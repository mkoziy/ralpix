import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveModel } from "./config.js";
import { parsePlan } from "./parser.js";
import { runPiSubprocessPrompt } from "./pi-subprocess.js";
import { buildPlanCreationPrompt } from "./planner-prompt.js";
import { expandPrompt, loadAgent, loadPrompt } from "./prompt.js";
import { usageToData } from "./utils.js";

import type { RunSession } from "./event-bus.js";
import type { EventUsage } from "./events.js";
import type { PiCommand, RunPiSubprocessConfig, SubprocessResult } from "./pi-subprocess.js";
import type { Plan, RalpixConfig } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface ClarificationRequest {
  question: string;
  options: string[];
}

interface HumanReviewDecision {
  action: "accept" | "revise" | "reload" | "reject";
  feedback?: string;
}

export interface PlanCreationResult {
  draft: string;
  plan: Plan;
  planPath: string;
}

interface PlanAcceptanceContext {
  draft: string;
  draftPath: string;
}

export interface PlannerDependencies {
  now?: () => Date;
  loadPrompt?: (name: string, cwd: string) => string;
  loadAgent?: (name: string) => string;
  runPrompt?: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
  runCritic?: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
  runAiReview?: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
}

interface PlannerRuntime {
  now: () => Date;
  promptLoader: (name: string, cwd: string) => string;
  agentLoader: (name: string) => string;
  runPrompt: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
  runCritic: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
  runAiReview: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
}

interface DraftRoundResult {
  kind: "clarification" | "draft";
  usage: EventUsage;
  clarification?: ClarificationRequest;
  draft?: string;
}

interface ReviewPhaseResult {
  action: string;
  digest: string;
}

interface ReviewLoopResult {
  action: "accept" | "revise" | "reject";
  draft: string;
  feedback?: string;
}

const DEFAULT_DESCRIPTION = "Untitled plan";
const RE_QUESTION_BLOCK = /<ralpix_question>\s*([\S\s]*?)\s*<\/ralpix_question>/i;
const REVIEW_ACCEPT = "Accept and finish";
const REVIEW_REVISE = "Revise from feedback";
const REVIEW_RELOAD = "Reload edited file";
const REVIEW_REJECT = "Reject and regenerate";

export async function runPlanCreation(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  description: string,
  config: RalpixConfig,
  session: RunSession,
  dependencies: PlannerDependencies = {},
): Promise<PlanCreationResult> {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new Error("plan description is required");
  }

  const runtime = resolvePlannerRuntime(dependencies);
  const model = resolveModel(config, "plan");
  const plansDir = resolve(ctx.cwd, config.plansDir.length > 0 ? config.plansDir : "docs/plans");
  mkdirSync(plansDir, { recursive: true });

  const template = runtime.promptLoader("plan-creation", ctx.cwd);
  const basePrompt = expandPrompt(template, {
    DESCRIPTION: trimmed,
    BRAINSTORM_CONTEXT: "",
  });

  const clarifications: Array<{ question: string; answer: string }> = [];
  let currentDraft = "";
  let draftPath = "";
  let pendingFeedback: string | null = null;
  let round = 0;

  session.log("phase_start", { label: "create" });

  for (;;) {
    round += 1;
    const draftRound = await runDraftRound(
      round,
      ctx,
      pi,
      config,
      session,
      basePrompt,
      clarifications,
      currentDraft,
      pendingFeedback,
      runtime.runPrompt,
      model,
    );

    if (draftRound.kind === "clarification") {
      await handleClarificationRound(session, clarifications, round, draftRound);
      pendingFeedback = null;
      continue;
    }

    if (draftRound.draft === undefined) {
      throw new Error("plan draft response missing draft");
    }

    currentDraft = draftRound.draft;
    draftPath = persistDraft(plansDir, trimmed, currentDraft, runtime.now(), draftPath);
    const draftPlan = parsePlan(currentDraft, draftPath);
    session.log("draft_generated", { digest: summarizeDraft(draftPlan) });
    session.log("round_end", { round, usage: draftRound.usage });
    pendingFeedback = null;

    const reviewDecision = await runReviewLoop(
      ctx,
      pi,
      currentDraft,
      draftPath,
      config,
      session,
      runtime.agentLoader,
      runtime.runCritic,
      runtime.runAiReview,
    );

    currentDraft = reviewDecision.draft;

    if (reviewDecision.action === "accept") {
      session.log("phase_end", { label: "accepted" });
      return buildAcceptedResult({ draft: currentDraft, draftPath });
    }

    pendingFeedback = reviewDecision.action === "revise"
      ? reviewDecision.feedback ?? "Revise the draft."
      : "The previous draft was rejected. Generate a different draft that stays aligned to the request.";
  }
}

async function handleClarificationRound(
  session: RunSession,
  clarifications: Array<{ question: string; answer: string }>,
  round: number,
  draftRound: DraftRoundResult,
): Promise<void> {
  const clarification = draftRound.clarification;
  if (clarification === undefined) {
    throw new Error("plan clarification response missing payload");
  }

  const promptId = `plan-q${String(clarifications.length + 1)}`;
  session.log("question", { promptId, message: clarification.question, next: "answer" });
  const answer = await askClarification(session, clarification);
  if (answer === null) {
    session.log("round_end", { round, usage: draftRound.usage });
    throw new Error("plan clarification cancelled");
  }

  clarifications.push({ question: clarification.question, answer });
  session.log("answer", { promptId, message: answer, usage: draftRound.usage });
  session.log("round_end", { round, usage: draftRound.usage });
}

function buildAcceptedResult(context: PlanAcceptanceContext): PlanCreationResult {
  return {
    draft: context.draft,
    plan: parsePlan(context.draft, context.draftPath),
    planPath: context.draftPath,
  };
}

function resolvePlannerRuntime(dependencies: PlannerDependencies): PlannerRuntime {
  return {
    now: dependencies.now ?? (() => new Date()),
    promptLoader: dependencies.loadPrompt ?? loadPrompt,
    agentLoader: dependencies.loadAgent ?? loadAgent,
    runPrompt: dependencies.runPrompt ?? runPiSubprocessPrompt,
    runCritic: dependencies.runCritic ?? runPiSubprocessPrompt,
    runAiReview: dependencies.runAiReview ?? runPiSubprocessPrompt,
  };
}

async function runDraftRound(
  round: number,
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  config: RalpixConfig,
  session: RunSession,
  basePrompt: string,
  clarifications: Array<{ question: string; answer: string }>,
  currentDraft: string,
  pendingFeedback: string | null,
  runPrompt: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>,
  model: RunPiSubprocessConfig,
): Promise<DraftRoundResult> {
  session.log("round_start", { round, label: `plan ${round}` });

  const prompt = buildDraftPrompt(basePrompt, clarifications, currentDraft, pendingFeedback, round);
  const draftResult = await runPrompt(ctx, pi, prompt, {
    ...model,
    piAgentDir: config.piAgentDir,
    timeoutMs: config.reviewTimeoutMs,
  }, session);
  const usage = usageFromResult(draftResult);

  if (draftResult.status !== "success") {
    throw new Error(draftResult.message ?? `plan subprocess ${draftResult.status}`);
  }

  const response = normalizeDraftOutput(draftResult);
  const clarification = extractClarificationRequest(response);
  if (clarification !== null) {
    return { kind: "clarification", usage, clarification };
  }

  const draft = stripMarkdownFence(response);
  const validation = validateDraft(draft);
  if (!validation.ok) {
    throw new Error(`invalid plan draft: ${validation.reason}`);
  }

  return { kind: "draft", usage, draft };
}

function buildDraftPrompt(
  basePrompt: string,
  clarifications: Array<{ question: string; answer: string }>,
  currentDraft: string,
  feedback: string | null,
  round: number,
): string {
  const prompt = buildPlanCreationPrompt(basePrompt, round);
  const sections = [prompt];

  if (clarifications.length > 0) {
    sections.push(
      "",
      "## Clarifications",
      ...clarifications.map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`),
    );
  }

  if (currentDraft.length > 0 && feedback !== null) {
    sections.push(
      "",
      "## Previous Draft",
      currentDraft.trim(),
      "",
      "## Revision Request",
      feedback.trim(),
      "",
      "Return only the full revised plan markdown.",
    );
  }

  return sections.join("\n");
}

function normalizeDraftOutput(result: SubprocessResult): string {
  return (result.message ?? result.stdout).trim();
}

function extractClarificationRequest(output: string): ClarificationRequest | null {
  const match = RE_QUESTION_BLOCK.exec(output);
  const body = match?.[1]?.trim();
  if (body === undefined || body.length === 0) return null;

  const question = (/^\s*question:\s*(.+)$/im).exec(body)?.[1]?.trim();
  if (question === undefined || question.length === 0) return null;

  const options = [...body.matchAll(/^\s*-\s+(.+)$/gim)]
    .map((entry) => entry[1]?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .slice(0, 3);

  return { question, options };
}

async function askClarification(
  session: RunSession,
  request: ClarificationRequest,
): Promise<string | null> {
  if (request.options.length >= 2) {
    const custom = "Other (type your own answer)";
    const answer = await session.choose(request.question, [...request.options, custom]);
    if (answer === null) return null;
    if (answer === custom) {
      return session.input(request.question, { placeholder: "Type your answer" });
    }
    return answer;
  }
  return session.input(request.question, { placeholder: "Type your answer" });
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = (/^```(?:markdown|md)?\n([\S\s]*?)\n```$/i).exec(trimmed)?.[1];
  return fenced?.trim() ?? trimmed;
}

function validateDraft(draft: string): { ok: true } | { ok: false; reason: string } {
  if (!(/^#\s+plan:\s+/im).test(draft)) {
    return { ok: false, reason: "missing # Plan title" };
  }
  if (!(/^###\s+(?:task|iteration)\s+\d+:/im).test(draft)) {
    return { ok: false, reason: "missing task sections" };
  }

  const parsed = parsePlan(draft);
  if (parsed.tasks.length === 0) {
    return { ok: false, reason: "parsed plan has no tasks" };
  }
  return { ok: true };
}

function persistDraft(
  plansDir: string,
  description: string,
  draft: string,
  createdAt: Date,
  previousPath: string,
): string {
  const targetPath = previousPath.length > 0
    ? previousPath
    : resolve(plansDir, `${dateStamp(createdAt)}-${slugify(planTitle(draft) ?? (description.length > 0 ? description : DEFAULT_DESCRIPTION))}.md`);

  writeFileSync(targetPath, `${draft.trimEnd()}\n`, "utf8");
  return targetPath;
}

function dateStamp(value: Date): string {
  const year = String(value.getFullYear());
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function planTitle(draft: string): string | null {
  return (/^#\s+plan:\s+(.+)$/im).exec(draft)?.[1]?.trim() ?? null;
}

function slugify(value: string): string {
  const slug = value.toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "plan";
}

function summarizeDraft(plan: Plan): string {
  const itemCount = plan.tasks.reduce((total, task) => total + task.items.length, 0);
  return `${plan.title} (${String(plan.tasks.length)} tasks, ${String(itemCount)} items)`;
}

async function runReviewPhase(
  kind: "critic" | "ai",
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  draft: string,
  reviewPrompt: string,
  config: RalpixConfig,
  session: RunSession,
  runReview: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>,
): Promise<ReviewPhaseResult> {
  session.log(kind === "critic" ? "critic_start" : "ai_review_start");

  const prompt = `${reviewPrompt}\n\n---\n\n## Plan to Review\n\n${draft.trim()}\n`;
  const result = await runReview(ctx, pi, prompt, {
    ...resolveModel(config, "plan"),
    piAgentDir: config.piAgentDir,
    timeoutMs: config.reviewTimeoutMs,
  }, session);

  const output = normalizeDraftOutput(result);
  const digest = firstMeaningfulLine(output);
  const usage = usageFromResult(result);

  session.log(kind === "critic" ? "critic_end" : "ai_review_end", {
    digest,
    usage,
  });

  return {
    action: inferReviewAction(kind, output),
    digest,
  };
}

function inferReviewAction(kind: "critic" | "ai", output: string): string {
  if (kind === "critic") {
    return (/no critical issues/i).test(output) ? "accept" : "revise";
  }
  return (/\bapprove\b/i).test(output) ? "accept" : "revise";
}

function firstMeaningfulLine(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

async function runReviewLoop(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  draft: string,
  draftPath: string,
  config: RalpixConfig,
  session: RunSession,
  agentLoader: (name: string) => string,
  runCritic: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>,
  runAiReview: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>,
): Promise<ReviewLoopResult> {
  let currentDraft = draft;

  for (;;) {
    const criticResult = await runReviewPhase(
      "critic",
      ctx,
      pi,
      currentDraft,
      agentLoader("critic"),
      config,
      session,
      runCritic,
    );
    session.log("review_result", {
      source: "critic",
      action: criticResult.action,
      digest: criticResult.digest,
    });

    const aiReviewResult = await runReviewPhase(
      "ai",
      ctx,
      pi,
      currentDraft,
      agentLoader("plan-review"),
      config,
      session,
      runAiReview,
    );
    session.log("review_result", {
      source: "ai",
      action: aiReviewResult.action,
      digest: aiReviewResult.digest,
    });

    const humanDecision = await reviewDraft(session, draftPath);
    session.log("human_review", { action: humanDecision.action });
    session.log("review_result", {
      source: "user",
      action: humanDecision.action,
    });

    if (humanDecision.action === "reload") {
      currentDraft = readFileSync(draftPath, "utf8");
      const reloadValidation = validateDraft(currentDraft);
      if (!reloadValidation.ok) {
        throw new Error(`invalid reloaded draft: ${reloadValidation.reason}`);
      }
      continue;
    }

    return {
      action: humanDecision.action,
      draft: currentDraft,
      ...(humanDecision.feedback === undefined ? {} : { feedback: humanDecision.feedback }),
    };
  }
}

async function reviewDraft(session: RunSession, draftPath: string): Promise<HumanReviewDecision> {
  const choice = await session.choose(
    `Review draft at ${draftPath}`,
    [REVIEW_ACCEPT, REVIEW_REVISE, REVIEW_RELOAD, REVIEW_REJECT],
  );

  if (choice === REVIEW_ACCEPT) {
    return { action: "accept" };
  }

  if (choice === REVIEW_RELOAD) {
    return { action: "reload" };
  }

  if (choice === REVIEW_REJECT) {
    return { action: "reject" };
  }

  const feedback = await session.input("What should change?", {
    placeholder: "Describe the revision",
  });
  return {
    action: "revise",
    feedback: feedback ?? "Revise the plan draft.",
  };
}

function usageFromResult(result: SubprocessResult): EventUsage {
  const step = {
    input: result.usage.input,
    output: result.usage.output,
    cacheRead: result.usage.cacheRead,
    cacheWrite: result.usage.cacheWrite,
    cost: result.usage.cost,
  };
  return usageToData(step, {
    input: step.input + step.cacheRead + step.cacheWrite,
    output: step.output,
    cost: step.cost,
  });
}

export function deleteDraft(path: string): void {
  if (path.length > 0 && existsSync(path)) {
    unlinkSync(path);
  }
}
