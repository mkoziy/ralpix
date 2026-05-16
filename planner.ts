/**
 * Interactive plan creation — generates a plan draft, lets the user revise it,
 * and saves the accepted result.
 *
 * Uses a subprocess backend instead of ctx.newSession() because the host
 * runtime currently aborts before the session callback starts.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildModelArg, resolveModel } from "./config.js";
import { appendPlanCreationDebug, planCreationDebugFilePath } from "./planner-debug.js";
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
): Promise<PlannerProcessResult> {
  appendPlanCreationDebug(cwd, `round ${round}: subprocess start`);
  const invocation = getPiExecutable();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];
  const modelCfg = resolveModel(config, "plan");
  const modelArg = buildModelArg(modelCfg);
  if (modelArg !== null) {
    args.push("--model", modelArg);
  } else if (modelCfg.provider !== null && modelCfg.provider.length > 0) {
    args.push("--provider", modelCfg.provider);
  }
  if (modelCfg.effort !== null) {
    args.push("--thinking", modelCfg.effort);
  }
  const { dir, filePath } = await writeTempFile(`plan-round-${round}`, promptContent);
  args.push(`@${filePath}`);
  appendPlanCreationDebug(cwd, `round ${round}: subprocess args prepared model=${modelArg ?? modelCfg.provider ?? "default"} effort=${modelCfg.effort ?? "default"}`);

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
): Promise<{ action: "accept" | "reject" | "revise"; feedback?: string }> {
  const reviewChoice = await ctx.ui.select(
    "Review the plan draft:",
    ["✓ Accept — save and finish", "↻ Revise — provide feedback", "✗ Reject — discard the plan"],
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

  for (let round = 1; round <= 3; round++) {
    const prompt = buildPlanGenerationPrompt(basePrompt, round, previousDraft, feedback);
    const result = await runPlannerProcess(ctx.cwd, prompt, round, config);

    if (result.exitCode !== 0) {
      ctx.ui.notify(
        `Plan creation failed in subprocess. See ${planCreationDebugFilePath(ctx.cwd)} and stderr in debug log.`,
        "error",
      );
      return null;
    }

    const draft = extractLastAssistantText(result.output.split("\n"));
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

    const review = await reviewDraft(ctx);
    if (review.action === "reject") {
      ctx.ui.notify("Plan creation cancelled (user rejected)", "warning");
      return null;
    }
    if (review.action === "accept") {
      const plansDir = resolve(ctx.cwd, config.plansDir.length > 0 ? config.plansDir : "docs/plans");
      if (!existsSync(plansDir)) {
        mkdirSync(plansDir, { recursive: true });
      }

      const planName = slugify(description);
      const planPath = join(plansDir, `${planName}.md`);

      if (existsSync(planPath)) {
        const overwrite = await ctx.ui.confirm(
          "Plan already exists",
          `${planPath} already exists. Overwrite?`,
        );
        if (overwrite !== true) {
          ctx.ui.notify("Plan creation cancelled (file exists)", "warning");
          return null;
        }
      }

      writeFileSync(planPath, draft, "utf-8");
      appendPlanCreationDebug(ctx.cwd, `runPlanCreation: saved ${planPath}`);
      ctx.ui.notify(`Plan saved to ${planPath}`, "success");

      const execute = await ctx.ui.select(
        "Plan created. What next?",
        ["▶ Execute plan now", "✓ Done — exit, run later"],
      );

      if (typeof execute === "string" && execute.includes("Execute")) {
        return planPath;
      }

      return null;
    }

    previousDraft = draft;
    feedback = review.feedback;
    appendPlanCreationDebug(ctx.cwd, `round ${round}: revision requested`);
  }

  ctx.ui.notify("Plan creation exhausted revision rounds", "error");
  return null;
}
