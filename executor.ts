/**
 * Task execution engine — runs each task in an isolated pi process.
 *
 * Uses spawn() with `pi --mode json -p --no-session` for true isolation,
 * same pattern as the subagent extension example.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { updatePlanTaskStatus } from "./parser.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
import { THINKING_LEVELS } from "./types.js";

import type { ProgressLogger } from "./logger.js";
import type { Plan, PlanTask, RalpixConfig, TaskResult, ThinkingLevel } from "./types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the pi executable path to spawn.
 */
function getPiExecutable(): { command: string; args: string[] } {
  // Use same pi that's running us
  const currentScript = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (typeof currentScript === "string" && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  // Fall back to `pi` on PATH
  return { command: "pi", args: [] };
}

/**
 * Write a temporary file and return its path.
 */
async function writeTempFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ralpix-"));
  const filePath = path.join(tmpDir, `${prefix}.md`);
  await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

interface JsonEvent {
  type: string;
  message?: {
    role: string;
    content?: Array<{ type: string; text: string }>;
  };
}

/**
 * Read last assistant text from JSON-line messages.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
function extractLastAssistantText(lines: string[]): string {
  const texts: string[] = [];
  for (const line of lines) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const event: JsonEvent = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const content = event.message.content;
        if (content !== undefined) {
          for (const part of content) {
            if (part.type === "text") texts.push(part.text);
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return texts.join("\n");
}

// ---------------------------------------------------------------------------
// Effort helpers
// ---------------------------------------------------------------------------

function isValidEffort(effort: unknown): effort is ThinkingLevel {
  return typeof effort === "string" && (THINKING_LEVELS as readonly string[]).includes(effort);
}

/** Check if stderr indicates an unsupported thinking level */
function isUnsupportedEffortError(stderr: string): boolean {
  return (/unsupported.*(?:thinking|effort|reasoning)/i).test(stderr) ||
    (/thinking.*not.*(?:support|available)/i).test(stderr) ||
    (/invalid.*thinking/i).test(stderr);
}

// ---------------------------------------------------------------------------
// Execute a single task via spawn
// ---------------------------------------------------------------------------

async function runTaskProcess(
  cwd: string,
  promptContent: string,
  model: string | null,
  effort: ThinkingLevel | null,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; error: string; effortRejected?: boolean }> {
  const invocation = getPiExecutable();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];

  if (model !== null && model.length > 0) {
    args.push("--model", model);
  }

  if (effort !== null) {
    args.push("--thinking", effort);
  }

  // Write prompt to temp file to avoid shell escaping issues
  const { dir: tmpDir, filePath: promptFile } = await writeTempFile("task", promptContent);
  args.push(`@${promptFile}`);

  return new Promise((resolve) => {
    const proc = spawn(invocation.command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      // Cleanup temp files
      try {
        fs.unlinkSync(promptFile);
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }

      resolve({
        exitCode: code ?? 1,
        output: stdout,
        error: stderr,
        effortRejected: isUnsupportedEffortError(stderr),
      });
    });

    proc.on("error", (err) => {
      try {
        fs.unlinkSync(promptFile);
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
      resolve({
        exitCode: 1,
        output: "",
        error: err.message,
      });
    });

    if (signal !== undefined) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) {
        killProc();
      } else {
        signal.addEventListener("abort", killProc, { once: true });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-commit
// ---------------------------------------------------------------------------

function tryCommit(
  cwd: string,
  message: string,
  enabled: boolean,
): string | null {
  if (!enabled) return null;

  try {
    // Check if there are changes to commit
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    if (status.trim().length === 0) return null; // nothing to commit

    const escapedMessage = message.replaceAll('"', String.raw`\"`);
    execSync(`git add -A && git commit -m "${escapedMessage}"`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Get commit hash
    return execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    return null; // commit failed (maybe no git repo, or nothing to commit)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a single task.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function executeTask(
  ctx: { cwd: string },
  _pi: ExtensionAPI,
  task: PlanTask,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
): Promise<TaskResult> {
  logger.logTaskStart(task);

  // Load and expand the task prompt
  const template = loadPrompt("task-default", ctx.cwd);
  const prompt = expandPrompt(template, {
    OVERVIEW: plan.overview.length > 0 ? plan.overview : plan.title,
    TASK_TITLE: task.title,
    TASK_DESCRIPTION: task.description.length > 0
      ? task.description
      : task.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n"),
  });

  // Mark in-progress in the plan file
  updatePlanTaskStatus(plan.path, task.id, task.title, "in-progress");

  // Determine model and effort
  const model = config.defaultModel ?? null;
  const effort = isValidEffort(config.defaultEffort) ? config.defaultEffort : null;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const result = await runTaskProcess(
        ctx.cwd,
        prompt,
        model,
        effort,
      );

      // If effort was rejected, retry once without effort
      if (result.effortRejected === true && effort !== null) {
        logger.logTaskEnd(task, false, `effort "${effort}" rejected by model, retrying without effort`);
        const retryResult = await runTaskProcess(
          ctx.cwd,
          prompt,
          model,
          null,
        );
        if (retryResult.exitCode === 0) {
          const commitMsg = config.commitMessageTemplate
            .replaceAll("{{taskTitle}}", task.title)
            .replaceAll("{{taskNumber}}", String(task.number));
          const hash = tryCommit(ctx.cwd, commitMsg, config.commitEnabled);
          const summary = extractLastAssistantText(retryResult.output.split("\n"));
          logger.logTaskEnd(task, true, hash === null ? "no commit" : `commit ${hash}`);
          updatePlanTaskStatus(plan.path, task.id, task.title, "completed");
          const retrySummary = summary.slice(0, 200).length > 0
            ? summary.slice(0, 200)
            : `Task ${task.number} completed`;
          return {
            success: true,
            summary: retrySummary,
          };
        }
        lastError = retryResult.error.length > 0 ? retryResult.error : `Exit code ${retryResult.exitCode}`;
        break;
      }

      if (result.exitCode === 0) {
        // Try to commit
        const commitMsg = config.commitMessageTemplate
          .replaceAll("{{taskTitle}}", task.title)
          .replaceAll("{{taskNumber}}", String(task.number));
        const hash = tryCommit(ctx.cwd, commitMsg, config.commitEnabled);

        // Extract summary from output
        const summary = extractLastAssistantText(result.output.split("\n"));

        logger.logTaskEnd(task, true, hash === null ? "no commit" : `commit ${hash}`);
        updatePlanTaskStatus(plan.path, task.id, task.title, "completed");

        const taskSummary = summary.slice(0, 200).length > 0
          ? summary.slice(0, 200)
          : `Task ${task.number} completed`;
        return {
          success: true,
          summary: taskSummary,
        };
      }

      lastError = result.error.length > 0 ? result.error : `Exit code ${result.exitCode}`;
      if (attempt <= config.maxRetries) {
        logger.logTaskEnd(task, false, `attempt ${attempt} failed, retrying (${lastError})`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt <= config.maxRetries) {
        logger.logTaskEnd(task, false, `attempt ${attempt} failed, retrying`);
      }
    }
  }

  // All retries exhausted
  const finalError = lastError ?? "Unknown error";
  logger.logTaskEnd(task, false, finalError);
  updatePlanTaskStatus(plan.path, task.id, task.title, "failed");
  return { success: false, error: finalError };
}

/**
 * Run all pending tasks sequentially.
 */
export async function executeAllTasks(
  ctx: { cwd: string },
  pi: ExtensionAPI,
  plan: Plan,
  config: RalpixConfig,
  logger: ProgressLogger,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];

  for (const task of plan.tasks) {
    if (task.status === "completed") {
      results.push({ success: true, summary: "Already completed" });
      continue;
    }
    if (task.status === "failed") {
      results.push({ success: false, error: "Previously failed" });
      continue;
    }

    const result = await executeTask(ctx, pi, task, config, plan, logger);
    results.push(result);

    if (!result.success) {
      // Stop on first failure after retries exhausted
      break;
    }
  }

  return results;
}
