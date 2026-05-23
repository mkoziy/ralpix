/**
 * Interactive plan creation — generates a plan draft, lets the user revise it,
 * and saves the accepted result.
 *
 * Uses a subprocess backend instead of ctx.newSession() because the host
 * runtime currently aborts before the session callback starts.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveModel, resolvePiAgentDir } from "./config.js";
import { parsePlan } from "./parser.js";
import { buildTemporalContext, createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { appendPlanCreationDebug, planCreationDebugFilePath } from "./planner-debug.js";
import { plannerLaunchConfigs } from "./planner-prompt.js";
import { loadAgent, loadPrompt, expandPrompt } from "./prompt.js";
import { createProgressTui, createTokenLedger } from "./tui.js";

import type { RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60);

  if (slug.length > 0) return slug;

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i) ?? 0;
    hash = Math.trunc((hash << 5) - hash + codePoint);
  }
  return `plan-${Math.abs(hash).toString(36).slice(0, 12)}`;
}

interface ClarificationRequest {
  question: string;
  options: string[];
}

function formatDateStamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

interface DraftSummary {
  title: string;
  tasks: number;
  items: number;
}

function summarizeDraft(draft: string): DraftSummary {
  const titleMatch = (/^#\s+plan:\s+(.+)$/im).exec(draft);
  const title = titleMatch?.[1]?.trim() ?? "Untitled";
  const tasks = [...draft.matchAll(/^###\s+task\s+\d+/gim)].length;
  const items = [...draft.matchAll(/^\s*-\s+\[.]/gim)].length;
  return { title, tasks, items };
}

interface ReviewDigest {
  verdict: string;
  critical: number;
  important: number;
  minor: number;
  overEngineering: number;
  testing: string | null;
  headline: string;
}

function digestPlanReview(review: string): ReviewDigest {
  const verdictMatch = (/\*\*\s*(approve|needs revision)\s*\*\*/i).exec(review);
  const verdict = verdictMatch?.[1]?.toUpperCase() ?? "UNKNOWN";

  const countIssues = (header: string): number => {
    const pattern = new RegExp(`^#{2,4}\s+${header}`, "gim");
    const match = pattern.exec(review);
    if (match === null) return 0;
    const start = match.index + match[0].length;
    const nextHeader = review.slice(start).search(/^#{2,4}\s+/m);
    const section = nextHeader >= 0 ? review.slice(start, start + nextHeader) : review.slice(start);
    return [...section.matchAll(/^\s*\d+\.\s+\*\*\[plan-review]\*\*/gim)].length;
  };

  const critical = countIssues("Critical Issues");
  const important = countIssues("Important Issues");
  const minor = countIssues("Minor Issues");

  const oeMatch = (/^#{2,4}\s+Over-Engineering Concerns/m).exec(review);
  let overEngineering = 0;
  if (oeMatch !== null) {
    const start = oeMatch.index + oeMatch[0].length;
    const nextHeader = review.slice(start).search(/^#{2,4}\s+/m);
    const section = nextHeader >= 0 ? review.slice(start, start + nextHeader) : review.slice(start);
    overEngineering = [...section.matchAll(/^\s*-\s+\*\*\[plan-review]\*\*/gim)].length;
  }

  const testingMatch = (/tasks with proper test requirements:\s*(\d+)\/(\d+)/i).exec(review);
  const g1 = testingMatch?.[1];
  const g2 = testingMatch?.[2];
  const testing = g1 != null && g2 != null ? `${g1}/${g2} tasks with tests` : null;

  const parts: string[] = [];
  if (critical > 0) parts.push(`${String(critical)} critical`);
  if (important > 0) parts.push(`${String(important)} important`);
  if (minor > 0) parts.push(`${String(minor)} minor`);
  if (parts.length === 0) parts.push("no issues");

  const testingSuffix = testing == null ? "" : ` · ${testing}`;
  const headline = `Review: ${verdict} — ${parts.join(", ")}${testingSuffix}`;

  return { verdict, critical, important, minor, overEngineering, testing, headline };
}

function buildPlanGenerationPrompt(
  basePrompt: string,
  round: number,
  clarifications: Array<{ question: string; answer: string }>,
  previousDraft?: string,
  feedback?: string,
): string {
  const sections = [
    basePrompt,
    "",
    "## Runtime Override",
    "You are running in one-shot plan generation mode.",
    "Make reasonable assumptions from the repository context.",
    "If you need clarification, output only this block and nothing else:",
    "<RALPIX_QUESTION>",
    "Question: <single concise question>",
    "Options:",
    "- <option 1>",
    "- <option 2>",
    "- <option 3>",
    "</RALPIX_QUESTION>",
    "If no clarification is needed, output only the complete ralpix markdown plan.",
    "The plan title and overview must stay tightly aligned to the user's request.",
    "Do not invent a different feature, subsystem, or goal than the request describes.",
    "Use `## Success Criteria`, not `## Validation Commands`.",
    "Do not wrap the plan in fenced code blocks.",
  ];

  if (clarifications.length > 0) {
    sections.push("", "## Clarifications", ...clarifications.map((entry) => `- Q: ${entry.question}\n  A: ${entry.answer}`));
  }

  if (round > 1 && previousDraft !== undefined) {
    sections.push(
      "",
      "## Previous Draft",
      previousDraft,
      "",
      "## Revision Request",
      feedback ?? "Revise the draft.",
      "",
      "Return the full updated plan markdown only.",
    );
  }

  return sections.join("\n");
}

function extractClarificationRequest(text: string): ClarificationRequest | null {
  const match = (/<ralpix_question>\s*([\S\s]*?)\s*<\/ralpix_question>/i).exec(text);
  if (match?.[1] == null) return null;
  const body = match[1];

  const questionMatch = (/^\s*question:\s*(.+)$/im).exec(body);
  const question = questionMatch?.[1]?.trim();
  if (question == null || question.length === 0) return null;

  const options = [...body.matchAll(/^\s*-\s+(.+)$/gim)]
    .map((x) => x[1]?.trim())
    .filter((x): x is string => x != null && x.length > 0)
    .slice(0, 3);

  return { question, options };
}

async function askClarification(
  ctx: ExtensionCommandContext,
  req: ClarificationRequest,
): Promise<string | null> {
  if (req.options.length >= 2) {
    const customLabel = "Other (type your own answer)";
    const selected = await ctx.ui.select(req.question, [...req.options, customLabel]);
    if (selected == null) return null;
    if (selected === customLabel) {
      const custom = await ctx.ui.input(req.question, "Type your custom answer");
      if (custom == null || custom.trim().length === 0) return null;
      return custom.trim();
    }
    return selected.trim();
  }
  const answer = await ctx.ui.input(req.question, "Your answer");
  if (answer == null || answer.trim().length === 0) return null;
  return answer.trim();
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = (/^```(?:markdown|md)?\n([\S\s]*?)\n```$/i).exec(trimmed);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function validatePlanDraft(content: string): { ok: true } | { ok: false; reason: string } {
  if (!(/^#\s+plan:\s+/im).test(content)) {
    return { ok: false, reason: "missing `# Plan:` title" };
  }
  if (!(/^###\s+task\s+\d+:/im).test(content)) {
    return { ok: false, reason: "missing `### Task N:` sections" };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "ralpix-plan-validate-"));
  const tempPath = join(tempDir, "draft.md");

  try {
    writeFileSync(tempPath, `${content.trimEnd()}\n`, "utf-8");
    const plan = parsePlan(tempPath);
    if (plan.tasks.length === 0) {
      return { ok: false, reason: "parsed plan has no tasks" };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore
    }
    try {
      rmdirSync(tempDir);
    } catch {
      // ignore
    }
  }

  return { ok: true };
}

function draftFileNameFromContent(content: string, fallbackDescription: string, createdAt: Date): string {
  const match = (/^#\s+plan:\s+(.+)$/im).exec(content);
  const title = match?.[1]?.trim();
  const slug = slugify(title !== undefined && title.length > 0 ? title : fallbackDescription);
  return `${formatDateStamp(createdAt)}-${slug}.md`;
}

function nextAvailableDraftPath(plansDir: string, fileName: string, previousPath?: string): string {
  const initialPath = join(plansDir, fileName);
  if (!existsSync(initialPath) || previousPath === initialPath) {
    return initialPath;
  }

  const suffix = fileName.endsWith(".md") ? ".md" : "";
  const baseName = suffix.length > 0 ? fileName.slice(0, -suffix.length) : fileName;
  for (let attempt = 2; attempt < 1000; attempt++) {
    const candidate = join(plansDir, `${baseName}-${String(attempt)}${suffix}`);
    if (!existsSync(candidate) || previousPath === candidate) {
      return candidate;
    }
  }

  throw new Error(`Unable to allocate draft filename for ${fileName}`);
}

function saveDraftFile(
  plansDir: string,
  description: string,
  content: string,
  createdAt: Date,
  previousPath?: string,
): string {
  const nextPath = nextAvailableDraftPath(
    plansDir,
    draftFileNameFromContent(content, description, createdAt),
    previousPath,
  );
  writeFileSync(nextPath, `${content.trimEnd()}\n`, "utf-8");
  if (previousPath !== undefined && previousPath !== nextPath && existsSync(previousPath)) {
    unlinkSync(previousPath);
  }
  return nextPath;
}

async function runPlanReviewSubprocess(
  draftPath: string,
  cwd: string,
  config: RalpixConfig,
): Promise<string | null> {
  try {
    const planContent = readFileSync(draftPath, "utf-8");
    const agentPrompt = loadAgent("plan-review");
    const fullPrompt = `${agentPrompt}\n\n---\n\n## Plan to Review\n\n${planContent}`;

    const modelCfg = resolveModel(config, "plan");
    const piAgentDir = resolvePiAgentDir(cwd, config);
    const temporal = buildTemporalContext(config);
    const promptWithTemporal = temporal.length > 0 ? `${temporal}\n${fullPrompt}` : fullPrompt;

    const result = await runPiSubprocessPrompt(
      cwd,
      promptWithTemporal,
      modelCfg,
      true,
      120000,
      undefined,
      piAgentDir,
      config,
    );

    if (result.exitCode !== 0) return null;
    return result.output;
  } catch {
    return null;
  }
}

async function reviewDraft(
  ctx: ExtensionCommandContext,
  draftPath: string,
): Promise<{ action: "accept" | "reject" | "revise" | "reload"; feedback?: string }> {
  const reviewChoice = await ctx.ui.select(
    `Plan draft saved to ${draftPath}. What next?`,
    [
      "✓ Accept — save and finish",
      "↻ Revise — provide feedback",
      "↺ I edited the file — reload it",
      "✗ Reject — discard the plan",
    ],
  );

  if (typeof reviewChoice === "string" && reviewChoice.includes("Accept")) {
    return { action: "accept" };
  }

  if (typeof reviewChoice === "string" && reviewChoice.includes("Revise")) {
    const feedback = await ctx.ui.input(
      "What changes would you like?",
      "Add more details, change approach, fix issues...",
    );
    return { action: "revise", feedback: feedback ?? "" };
  }

  if (typeof reviewChoice === "string" && reviewChoice.includes("reload")) {
    return { action: "reload" };
  }

  return { action: "reject" };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function runPlanCreation(
  description: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  config: RalpixConfig,
  existingPlanPath?: string,
  brainstormContext?: string,
): Promise<string | null> {
  const trimmed = description.trim();
  if (trimmed.length < 5) {
    ctx.ui.notify("Plan description too short (min 5 characters)", "error");
    return null;
  }

  const isUpdate = existingPlanPath !== undefined && existsSync(existingPlanPath);
  const modeLabel = isUpdate ? "Updating" : "Creating";
  ctx.ui.notify(`${modeLabel} plan for: "${description}"...`, "info");
  appendPlanCreationDebug(ctx.cwd, `runPlanCreation: start description=${JSON.stringify(description)}`);
  appendPlanCreationDebug(ctx.cwd, `runPlanCreation: debug file ${planCreationDebugFilePath(ctx.cwd)}`);
  appendPlanCreationDebug(ctx.cwd, `runPlanCreation: plansDir=${config.plansDir}`);

  // ── Optional brainstorm phase (if enabled and not updating) ──
  let effectiveContext = brainstormContext ?? "";
  if (!isUpdate && effectiveContext.length === 0 && config.brainstormEnabled) {
    const offer = await ctx.ui.confirm(
      "Brainstorm first?",
      "Would you like to brainstorm approaches and design before creating the plan?",
    );
    if (offer === true) {
      const { runBrainstorm } = await import("./brainstorm.js");
      const result = await runBrainstorm(description, ctx, _pi, config);
      if (result != null) {
        effectiveContext = result;
      }
    }
  }

  ctx.ui.notify("Generating plan draft...", "info");

  const template = loadPrompt("plan-creation", ctx.cwd);
  const basePrompt = expandPrompt(template, {
    DESCRIPTION: description,
    BRAINSTORM_CONTEXT: effectiveContext.length > 0 ? `\n\n${effectiveContext}\n` : "",
  });

  let previousDraft: string | undefined;
  let feedback: string | undefined;
  const clarifications: Array<{ question: string; answer: string }> = [];
  const launchConfigs = plannerLaunchConfigs();
  const plansDir = resolve(ctx.cwd, config.plansDir.length > 0 ? config.plansDir : "docs/plans");
  const createdAt = new Date();
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  let draftPath: string | undefined;

  if (isUpdate) {
    previousDraft = readFileSync(existingPlanPath, "utf-8");
    feedback = description;
    draftPath = existingPlanPath;
    appendPlanCreationDebug(ctx.cwd, `runPlanCreation: loaded existing plan ${existingPlanPath}`);
  }

  const tui = createProgressTui(ctx, "plan-creation-progress", `plan: ${description}`);
  const ledger = createTokenLedger();

  try {
    for (let round = isUpdate ? 2 : 1; round <= 5; round++) {
      const prompt = buildPlanGenerationPrompt(basePrompt, round, clarifications, previousDraft, feedback);
      let result: { exitCode: number; output: string; error: string } | null = null;

      for (const [launchIndex, launchConfig] of launchConfigs.entries()) {
        const modelCfg = launchConfig.modelPhase === null
          ? { model: null, provider: null, effort: null }
          : resolveModel(config, launchConfig.modelPhase);
        const usageBefore = ledger.snapshot();

        tui.setPhase("drafting");
        tui.setCurrent(`Round ${round}: AI drafting...`);
        tui.refresh();

        appendPlanCreationDebug(ctx.cwd, `round ${round}: subprocess start`);

        const hooks = createPiProgressHooks(
          (detail) => {
            tui.setCurrent(`Round ${round}: ${detail}`);
            tui.refresh();
          },
          (provider, model, usage) => {
            ledger.add(provider, model, usage);
            tui.setTotalUsage(ledger.snapshot());
            tui.refresh();
          },
        );

        result = await runPiSubprocessPrompt(
          ctx.cwd,
          prompt,
          modelCfg,
          launchConfig.includeEffort,
          120000,
          hooks,
          resolvePiAgentDir(ctx.cwd, config),
          config,
        );

        if (result.exitCode === 0) {
          tui.pushStep({
            title: `Round ${round}: draft generated`,
            usageSummary: ledger.diffSince(usageBefore),
            usageLines: ledger.usageLines(),
          });
          break;
        }

        appendPlanCreationDebug(
          ctx.cwd,
          `round ${round}: launch ${String(launchIndex + 1)} failed exit=${String(result.exitCode)}`,
        );
        tui.pushStep({
          title: `Round ${round}: launch ${String(launchIndex + 1)} failed (exit ${String(result.exitCode)})`,
        });
      }

      if (result?.exitCode !== 0) {
        ctx.ui.notify(
          `Plan creation failed in subprocess. See ${planCreationDebugFilePath(ctx.cwd)} and stderr in debug log.`,
          "error",
        );
        return null;
      }

      const draft = stripMarkdownFence(result.output);
      const draftStatus = draft.length > 0 ? `len=${String(draft.length)}` : "empty";
      appendPlanCreationDebug(
        ctx.cwd,
        `round ${round}: extracted draft ${draftStatus}`,
      );
      ctx.ui.notify(`Draft received (${String(draft.length)} chars)`, "info");

      const clarification = extractClarificationRequest(draft);
      if (clarification !== null) {
        appendPlanCreationDebug(ctx.cwd, `round ${round}: model asked clarification ${JSON.stringify(clarification.question)}`);
        tui.setPhase("clarifying");
        tui.setCurrent("Waiting for clarification...");
        tui.refresh();
        ctx.ui.notify(`Need clarification: ${clarification.question}`, "info");
        const answer = await askClarification(ctx, clarification);
        if (answer == null || answer.length === 0) {
          ctx.ui.notify("Plan creation cancelled (clarification unanswered)", "warning");
          return null;
        }
        clarifications.push({ question: clarification.question, answer });
        appendPlanCreationDebug(ctx.cwd, `round ${round}: clarification answered ${JSON.stringify(answer)}`);
        tui.pushStep({ title: `Clarified: ${clarification.question} → ${answer}` });
        continue;
      }

      if (draft.length === 0) {
        ctx.ui.notify(
          `Plan creation produced no draft. See ${planCreationDebugFilePath(ctx.cwd)}`,
          "error",
        );
        return null;
      }

      const draftValidation = validatePlanDraft(draft);
      if (!draftValidation.ok) {
        appendPlanCreationDebug(ctx.cwd, `round ${round}: invalid draft ${draftValidation.reason}`);
        ctx.ui.notify(`Draft needs fixes: ${draftValidation.reason}`, "warning");
        tui.pushStep({ title: `Round ${round}: invalid draft (${draftValidation.reason})` });
        previousDraft = draft;
        feedback =
          `The previous draft was not a valid ralpix plan: ${draftValidation.reason}. ` +
          "Return only valid ralpix plan markdown with `# Plan:` and `### Task N:` sections. " +
          "Optional sections like `## Overview`, `## Success Criteria`, `## Design Decisions`, etc. are encouraged when they help the implementer.";
        continue;
      }

      if (isUpdate) {
        writeFileSync(existingPlanPath, `${draft.trimEnd()}\n`, "utf-8");
        draftPath = existingPlanPath;
      } else {
        draftPath = saveDraftFile(plansDir, description, draft, createdAt, draftPath);
      }
      const summary = summarizeDraft(draft);
      appendPlanCreationDebug(ctx.cwd, `round ${round}: saved draft ${draftPath}`);
      ctx.ui.notify(
        isUpdate ? `Plan updated at ${draftPath}` : `Plan saved to ${draftPath}`,
        "success",
      );
      tui.pushStep({
        title: `Draft: "${summary.title}" — ${String(summary.tasks)} tasks, ${String(summary.items)} items`,
      });

      for (;;) {
        tui.setPhase("reviewing");
        tui.setCurrent("Waiting for user review...");
        tui.refresh();
        const review = await reviewDraft(ctx, draftPath);
        if (review.action === "reject") {
          tui.pushStep({ title: "Plan rejected by user" });
          ctx.ui.notify("Plan creation cancelled (user rejected)", "warning");
          return null;
        }
        if (review.action === "reload") {
          const currentDraft = readFileSync(draftPath, "utf-8");
          const validation = validatePlanDraft(currentDraft);
          if (!validation.ok) {
            ctx.ui.notify(`Plan file is invalid: ${validation.reason}`, "error");
            continue;
          }
          ctx.ui.notify(`Reloaded edited draft from ${draftPath}`, "success");
          tui.pushStep({ title: "Reloaded edited draft" });
          continue;
        }
        if (review.action === "accept") {
          const currentDraft = readFileSync(draftPath, "utf-8");
          const validation = validatePlanDraft(currentDraft);
          if (!validation.ok) {
            ctx.ui.notify(`Plan file is invalid: ${validation.reason}`, "error");
            continue;
          }
          tui.setPhase("complete");
          tui.pushStep({ title: "Plan accepted" });
          appendPlanCreationDebug(ctx.cwd, `runPlanCreation: accepted ${draftPath}`);
          ctx.ui.notify(isUpdate ? `Plan updated at ${draftPath}` : `Plan saved to ${draftPath}`, "success");

          // Post-acceptance loop: Review → Execute → Done
          let postReview: string | null = null;
          let reviewDigest: ReviewDigest | null = null;
          for (;;) {
            const choices = postReview == null
              ? ["🔍 Review plan (AI check)", "▶ Execute plan now", "✓ Done — exit, run later"]
              : ["↻ Revise based on review", "▶ Execute plan now", "✓ Done — exit, run later"];

            const selectPrompt = reviewDigest == null
              ? `Plan saved to ${draftPath}. What next?`
              : `${reviewDigest.headline}\n\nPlan saved to ${draftPath}. What next?`;

            const next = await ctx.ui.select(selectPrompt, choices);

            if (typeof next === "string" && next.includes("Execute")) {
              return draftPath;
            }

            if (typeof next === "string" && next.includes("Done")) {
              return null;
            }

            if (typeof next === "string" && next.includes("Review")) {
              ctx.ui.notify("Running AI plan review...", "info");
              appendPlanCreationDebug(ctx.cwd, "runPlanCreation: starting plan review");
              tui.setCurrent("AI reviewing plan...");
              tui.refresh();
              const reviewResult = await runPlanReviewSubprocess(draftPath, ctx.cwd, config);
              if (reviewResult == null || reviewResult.trim().length === 0) {
                ctx.ui.notify("Plan review did not return output. You can still execute or revise manually.", "warning");
                continue;
              }
              const digest = digestPlanReview(reviewResult);
              ctx.ui.notify(digest.headline, digest.verdict === "APPROVE" ? "success" : "warning");
              tui.pushStep({ title: `AI review: ${digest.headline}` });
              reviewDigest = digest;
              postReview = reviewResult;
              continue;
            }

            if (typeof next === "string" && next.includes("Revise")) {
              if (postReview != null) {
                previousDraft = readFileSync(draftPath, "utf-8");
                feedback = `Apply the following AI review feedback:\n\n${postReview}`;
                appendPlanCreationDebug(ctx.cwd, "runPlanCreation: revision from plan review");
                tui.pushStep({ title: "Revision from AI review feedback" });
              }
              break;
            }

            // Fallback — treat as Done
            return null;
          }

          // If we broke out of the post-acceptance loop with a revision request,
          // continue the outer revision loop.
          continue;
        }

        previousDraft = readFileSync(draftPath, "utf-8");
        feedback = review.feedback;
        tui.pushStep({ title: "User requested revision" });
        appendPlanCreationDebug(ctx.cwd, `round ${round}: revision requested`);
        break;
      }
    }

    ctx.ui.notify("Plan creation exhausted revision rounds", "error");
    return null;
  } finally {
    tui.close();
  }
}
