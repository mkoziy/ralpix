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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildModelArg, resolveModel } from "./config.js";
import { parsePlan } from "./parser.js";
import { appendPlanCreationDebug, planCreationDebugFilePath } from "./planner-debug.js";
import { plannerLaunchConfigs } from "./planner-prompt.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

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

function getPiExecutable(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (typeof currentScript === "string" && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

async function writeTempFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "ralpix-plan-"));
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
  previousDraft?: string,
  feedback?: string,
): string {
  const sections = [
    basePrompt,
    "",
    "## Runtime Override",
    "You are running in one-shot plan generation mode.",
    "Do not ask questions and do not call any tools.",
    "Make reasonable assumptions from the repository context.",
    "Your entire final response must be only the complete ralpix markdown plan.",
    "Do not include prose before or after the plan.",
  ];

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

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = (/^```(?:markdown|md)?\n([\S\s]*?)\n```$/i).exec(trimmed);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function validatePlanDraft(content: string): { ok: true } | { ok: false; reason: string } {
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

function draftFileNameFromContent(content: string, fallbackDescription: string): string {
  const match = (/^#\s+plan:\s+(.+)$/im).exec(content);
  const title = match?.[1]?.trim();
  return `${slugify(title !== undefined && title.length > 0 ? title : fallbackDescription)}.md`;
}

function saveDraftFile(
  plansDir: string,
  description: string,
  content: string,
  previousPath?: string,
): string {
  const nextPath = join(plansDir, draftFileNameFromContent(content, description));
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

async function runPlannerProcess(
  cwd: string,
  promptContent: string,
  round: number,
  config: RalpixConfig,
  launchConfig: { modelPhase: "plan" | "task" | null; includeEffort: boolean },
): Promise<PlannerProcessResult> {
  appendPlanCreationDebug(cwd, `round ${round}: subprocess start`);
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
  const { dir, filePath } = await writeTempFile(`plan-round-${round}`, promptContent);
  args.push(`@${filePath}`);
  const modelLabel = launchConfig.modelPhase === null ? "default" : (modelArg ?? modelCfg.provider ?? "default");
  const effortLabel = launchConfig.includeEffort ? (modelCfg.effort ?? "default") : "default";
  appendPlanCreationDebug(cwd, `round ${round}: subprocess args prepared model=${modelLabel} effort=${effortLabel}`);

  return new Promise((resolvePromise) => {
    const proc = spawn(invocation.command, args, {
      cwd,
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
  const launchConfigs = plannerLaunchConfigs();
  const plansDir = resolve(ctx.cwd, config.plansDir.length > 0 ? config.plansDir : "docs/plans");
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  let draftPath: string | undefined;

  for (let round = 1; round <= 3; round++) {
    const prompt = buildPlanGenerationPrompt(basePrompt, round, previousDraft, feedback);
    let result: PlannerProcessResult | null = null;
    for (const [launchIndex, launchConfig] of launchConfigs.entries()) {
      result = await runPlannerProcess(ctx.cwd, prompt, round, config, launchConfig);
      if (result.exitCode === 0) break;
      appendPlanCreationDebug(
        ctx.cwd,
        `round ${round}: launch ${String(launchIndex + 1)} failed exit=${String(result.exitCode)}`,
      );
    }

    if (result?.exitCode !== 0) {
      ctx.ui.notify(
        `Plan creation failed in subprocess. See ${planCreationDebugFilePath(ctx.cwd)} and stderr in debug log.`,
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
      previousDraft = draft;
      feedback =
        `The previous draft was not a valid ralpix plan: ${draftValidation.reason}. ` +
        "Return only valid ralpix plan markdown with `# Plan:`, `## Overview`, `## Success Criteria`, and `### Task N:` sections.";
      continue;
    }

    draftPath = saveDraftFile(plansDir, description, draft, draftPath);
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
        const validation = validatePlanDraft(currentDraft);
        if (!validation.ok) {
          ctx.ui.notify(`Plan file is invalid: ${validation.reason}`, "error");
          continue;
        }
        ctx.ui.notify(`Reloaded edited draft from ${draftPath}`, "success");
        continue;
      }
      if (review.action === "accept") {
        const currentDraft = readFileSync(draftPath, "utf-8");
        const validation = validatePlanDraft(currentDraft);
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
