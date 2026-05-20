/**
 * Interactive plan creation — generates a plan draft, lets the user revise it,
 * and saves the accepted result.
 *
 * Uses a subprocess backend instead of ctx.newSession() because the host
 * runtime currently aborts before the session callback starts.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { buildModelArg, resolveModel } from "./config.js";
import { parsePlan } from "./parser.js";
import { appendPlanCreationDebug, planCreationDebugFilePath } from "./planner-debug.js";
import { plannerLaunchConfigs } from "./planner-prompt.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
import { resolveWorkspacePath, sandboxPiInvocation, workspaceSandboxFailureDetail, workspaceTempDir } from "./workspace.js";

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

function getPiExecutable(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (typeof currentScript === "string" && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

async function writeTempFile(
  cwd: string,
  prefix: string,
  content: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(join(workspaceTempDir(cwd), "plan-"));
  const filePath = join(dir, `${prefix}.md`);
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

interface JsonEvent {
  type: string;
  message?: {
    role: string;
    content?: Array<{ type: string; text: string }>;
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
function extractLastAssistantText(lines: string[]): string {
  let parts: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as JsonEvent;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        parts = [];
        const content = event.message.content;
        if (content !== undefined) {
          for (const part of content) {
            if (part.type === "text") parts.push(part.text);
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return parts.join("\n").trim();
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

function validatePlanDraft(cwd: string, content: string): { ok: true } | { ok: false; reason: string } {
  if (!(/^#\s+plan:\s+/im).test(content)) {
    return { ok: false, reason: "missing `# Plan:` title" };
  }
  if (!(/^##\s+overview\b/im).test(content)) {
    return { ok: false, reason: "missing `## Overview` section" };
  }
  if (!(/^##\s+success criteria\b/im).test(content)) {
    return { ok: false, reason: "missing `## Success Criteria` section" };
  }
  if (!(/^###\s+task\s+\d+:/im).test(content)) {
    return { ok: false, reason: "missing `### Task N:` sections" };
  }

  const tempDir = mkdtempSync(join(workspaceTempDir(cwd), "plan-validate-"));
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

interface PlannerProcessResult {
  exitCode: number;
  output: string;
  error: string;
}

export function plannerFailureDetail(result: PlannerProcessResult): string {
  const sandboxDetail = workspaceSandboxFailureDetail(result.error);
  if (sandboxDetail !== null) return sandboxDetail;

  const stderr = result.error.trim();
  if (stderr.length > 0) return stderr;

  const stdout = result.output.trim();
  if (stdout.length > 0) return stdout;

  return `subprocess exited with code ${String(result.exitCode)}`;
}

async function runPlannerProcess(
  cwd: string,
  promptContent: string,
  round: number,
  config: RalpixConfig,
  launchConfig: { modelPhase: "plan" | "task" | null; includeEffort: boolean },
): Promise<PlannerProcessResult> {
  appendPlanCreationDebug(cwd, `round ${round}: subprocess start`);
  try {
    const invocation = getPiExecutable();
    const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];
    const modelCfg = launchConfig.modelPhase === null
      ? { model: null, provider: null, effort: null }
      : resolveModel(config, launchConfig.modelPhase);
    const modelArg = buildModelArg(modelCfg);
    if (launchConfig.modelPhase !== null && modelArg !== null) {
      args.push("--model", modelArg);
    } else if (launchConfig.modelPhase !== null && modelCfg.provider !== null && modelCfg.provider.length > 0) {
      args.push("--provider", modelCfg.provider);
    }
    if (launchConfig.includeEffort && modelCfg.effort !== null) {
      args.push("--thinking", modelCfg.effort);
    }
    const { dir, filePath } = await writeTempFile(cwd, `plan-round-${round}`, promptContent);
    args.push(`@${filePath}`);
    const modelLabel = launchConfig.modelPhase === null ? "default" : (modelArg ?? modelCfg.provider ?? "default");
    const effortLabel = launchConfig.includeEffort ? (modelCfg.effort ?? "default") : "default";
    appendPlanCreationDebug(cwd, `round ${round}: subprocess args prepared model=${modelLabel} effort=${effortLabel}`);
    const sandboxed = sandboxPiInvocation(cwd, {
      command: invocation.command,
      args,
    });

    return await new Promise((resolvePromise) => {
      const proc = spawn(sandboxed.command, sandboxed.args, {
        cwd,
        env: sandboxed.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timeout = setTimeout(() => {
        appendPlanCreationDebug(cwd, `round ${round}: subprocess timeout`);
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      }, 120000);

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        try {
          unlinkSync(filePath);
        } catch {
          // ignore
        }
        try {
          rmdirSync(dir);
        } catch {
          // ignore
        }
        clearTimeout(timeout);
        appendPlanCreationDebug(cwd, `round ${round}: subprocess close exit=${String(code ?? 1)}`);
        if ((code ?? 1) !== 0 && stdout.trim().length > 0) {
          appendPlanCreationDebug(cwd, `round ${round}: stdout ${JSON.stringify(stdout.trim().slice(0, 2000))}`);
        }
        if (stderr.trim().length > 0) {
          appendPlanCreationDebug(cwd, `round ${round}: stderr ${JSON.stringify(stderr.trim().slice(0, 2000))}`);
        }
        resolvePromise({
          exitCode: code ?? 1,
          output: stdout,
          error: stderr,
        });
      });

      proc.on("error", (error) => {
        try {
          unlinkSync(filePath);
        } catch {
          // ignore
        }
        try {
          rmdirSync(dir);
        } catch {
          // ignore
        }
        clearTimeout(timeout);
        appendPlanCreationDebug(cwd, `round ${round}: subprocess error ${error.message}`);
        resolvePromise({
          exitCode: 1,
          output: "",
          error: error.message,
        });
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendPlanCreationDebug(cwd, `round ${round}: launcher error ${message}`);
    return {
      exitCode: 1,
      output: "",
      error: message,
    };
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
): Promise<string | null> {
  const trimmed = description.trim();
  if (trimmed.length < 5) {
    ctx.ui.notify("Plan description too short (min 5 characters)", "error");
    return null;
  }

  ctx.ui.notify(`Creating plan for: "${description}"...`, "info");
  appendPlanCreationDebug(ctx.cwd, `runPlanCreation: start description=${JSON.stringify(description)}`);
  appendPlanCreationDebug(ctx.cwd, `runPlanCreation: debug file ${planCreationDebugFilePath(ctx.cwd)}`);
  appendPlanCreationDebug(ctx.cwd, `runPlanCreation: plansDir=${config.plansDir}`);
  ctx.ui.notify("Generating plan draft...", "info");

  const template = loadPrompt("plan-creation", ctx.cwd);
  const basePrompt = expandPrompt(template, {
    DESCRIPTION: description,
  });

  let previousDraft: string | undefined;
  let feedback: string | undefined;
  const clarifications: Array<{ question: string; answer: string }> = [];
  const launchConfigs = plannerLaunchConfigs();
  const plansDir = resolveWorkspacePath(ctx.cwd, config.plansDir.length > 0 ? config.plansDir : "docs/plans", {
    kind: "create",
    label: "plans directory",
  });
  const createdAt = new Date();
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  let draftPath: string | undefined;

  for (let round = 1; round <= 5; round++) {
    const prompt = buildPlanGenerationPrompt(basePrompt, round, clarifications, previousDraft, feedback);
    let result: PlannerProcessResult | null = null;
    for (const [launchIndex, launchConfig] of launchConfigs.entries()) {
      result = await runPlannerProcess(ctx.cwd, prompt, round, config, launchConfig);
      if (result.exitCode === 0) break;
      appendPlanCreationDebug(
        ctx.cwd,
        `round ${round}: launch ${String(launchIndex + 1)} failed exit=${String(result.exitCode)}`,
      );
      if (workspaceSandboxFailureDetail(result.error) !== null) {
        appendPlanCreationDebug(ctx.cwd, `round ${round}: aborting retries due to sandbox failure`);
        break;
      }
    }

    if (result?.exitCode !== 0) {
      const failureDetail = result === null ? "subprocess did not start" : plannerFailureDetail(result);
      ctx.ui.notify(
        `Plan creation failed: ${failureDetail}. See ${planCreationDebugFilePath(ctx.cwd)}.`,
        "error",
      );
      return null;
    }

    const draft = stripMarkdownFence(extractLastAssistantText(result.output.split("\n")));
    const draftStatus = draft.length > 0 ? `len=${String(draft.length)}` : "empty";
    appendPlanCreationDebug(
      ctx.cwd,
      `round ${round}: extracted draft ${draftStatus}`,
    );

    const clarification = extractClarificationRequest(draft);
    if (clarification !== null) {
      appendPlanCreationDebug(ctx.cwd, `round ${round}: model asked clarification ${JSON.stringify(clarification.question)}`);
      const answer = await askClarification(ctx, clarification);
      if (answer == null || answer.length === 0) {
        ctx.ui.notify("Plan creation cancelled (clarification unanswered)", "warning");
        return null;
      }
      clarifications.push({ question: clarification.question, answer });
      appendPlanCreationDebug(ctx.cwd, `round ${round}: clarification answered ${JSON.stringify(answer)}`);
      continue;
    }

    if (draft.length === 0) {
      ctx.ui.notify(
        `Plan creation produced no draft. See ${planCreationDebugFilePath(ctx.cwd)}`,
        "error",
      );
      return null;
    }

    const draftValidation = validatePlanDraft(ctx.cwd, draft);
    if (!draftValidation.ok) {
      appendPlanCreationDebug(ctx.cwd, `round ${round}: invalid draft ${draftValidation.reason}`);
      previousDraft = draft;
      feedback =
        `The previous draft was not a valid ralpix plan: ${draftValidation.reason}. ` +
        "Return only valid ralpix plan markdown with `# Plan:`, `## Overview`, `## Success Criteria`, and `### Task N:` sections.";
      continue;
    }

    draftPath = saveDraftFile(plansDir, description, draft, createdAt, draftPath);
    appendPlanCreationDebug(ctx.cwd, `round ${round}: saved draft ${draftPath}`);
    ctx.ui.notify(`Plan draft written to ${draftPath}`, "info");

    for (;;) {
      const review = await reviewDraft(ctx, draftPath);
      if (review.action === "reject") {
        ctx.ui.notify("Plan creation cancelled (user rejected)", "warning");
        return null;
      }
      if (review.action === "reload") {
        const currentDraft = readFileSync(draftPath, "utf-8");
        const validation = validatePlanDraft(ctx.cwd, currentDraft);
        if (!validation.ok) {
          ctx.ui.notify(`Plan file is invalid: ${validation.reason}`, "error");
          continue;
        }
        ctx.ui.notify(`Reloaded edited draft from ${draftPath}`, "success");
        continue;
      }
      if (review.action === "accept") {
        const currentDraft = readFileSync(draftPath, "utf-8");
        const validation = validatePlanDraft(ctx.cwd, currentDraft);
        if (!validation.ok) {
          ctx.ui.notify(`Plan file is invalid: ${validation.reason}`, "error");
          continue;
        }
        appendPlanCreationDebug(ctx.cwd, `runPlanCreation: accepted ${draftPath}`);
        ctx.ui.notify(`Plan saved to ${draftPath}`, "success");

        const execute = await ctx.ui.select(
          "Plan created. What next?",
          ["▶ Execute plan now", "✓ Done — exit, run later"],
        );

        if (typeof execute === "string" && execute.includes("Execute")) {
          return draftPath;
        }

        return null;
      }

      previousDraft = readFileSync(draftPath, "utf-8");
      feedback = review.feedback;
      appendPlanCreationDebug(ctx.cwd, `round ${round}: revision requested`);
      break;
    }
  }

  ctx.ui.notify("Plan creation exhausted revision rounds", "error");
  return null;
}
