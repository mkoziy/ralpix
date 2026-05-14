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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Plan, PlanTask, RalpixConfig, TaskResult, ThinkingLevel } from "./types.js";
import { THINKING_LEVELS } from "./types.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
import { ProgressLogger } from "./logger.js";
import { updatePlanTaskStatus } from "./parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TaskRunResult {
  success: boolean;
  error?: string;
  summary?: string;
  commitHash?: string;
}

/**
 * Get the pi executable path to spawn.
 */
function getPiExecutable(): { command: string; args: string[] } {
  // Use same pi that's running us
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
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

/**
 * Read last assistant text from JSON-line messages.
 */
function extractLastAssistantText(lines: string[]): string {
  const texts: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        for (const part of event.message.content ?? []) {
          if (part.type === "text") texts.push(part.text);
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
  return /unsupported.*(thinking|effort|reasoning)/i.test(stderr) ||
    /thinking.*not.*(support|available)/i.test(stderr) ||
    /invalid.*thinking/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Execute a single task via spawn
// ---------------------------------------------------------------------------

async function runTaskProcess(
  cwd: string,
  prompt: string,
  model: string | null,
  effort: ThinkingLevel | null,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; output: string; error: string; effortRejected?: boolean }> {
  const invocation = getPiExecutable();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];

  if (model) {
    args.push("--model", model);
  }

  if (effort) {
    args.push("--thinking", effort);
  }

  // Write prompt to temp file to avoid shell escaping issues
  const { dir: tmpDir, filePath: promptFile } = await writeTempFile("task", prompt);
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
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      resolve({
        exitCode: code ?? 1,
        output: stdout,
        error: stderr,
        effortRejected: isUnsupportedEffortError(stderr),
      });
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
      resolve({
        exitCode: 1,
        output: "",
        error: err.message,
      });
    });

    if (signal) {
      const killProc = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Auto-commit
// ---------------------------------------------------------------------------

async function tryCommit(
  cwd: string,
  message: string,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled) return null;

  try {
    // Check if there are changes to commit
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    if (!status.trim()) return null; // nothing to commit

    execSync(`git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Get commit hash
    const hash = execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8" }).trim();
    return hash;
  } catch (err) {
    return null; // commit failed (maybe no git repo, or nothing to commit)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a single task.
 */
export async function executeTask(
  ctx: { cwd: string },
  pi: ExtensionAPI,
  task: PlanTask,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
): Promise<TaskResult> {
  logger.logTaskStart(task);

  // Load and expand the task prompt
  const template = loadPrompt("task-default", ctx.cwd);
  const prompt = expandPrompt(template, {
    OVERVIEW: plan.overview || plan.title,
    TASK_TITLE: task.title,
    TASK_DESCRIPTION: task.description ||
      task.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n"),
  });

  // Mark in-progress in the plan file
  updatePlanTaskStatus(plan.path, task.id, task.title, "in-progress");

  // Determine model and effort
  const model = config.defaultModel || null;
  const effort = isValidEffort(config.defaultEffort) ? config.defaultEffort : null;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const result = await runTaskProcess(
        ctx.cwd,
        prompt,
        model,
        effort,
        undefined, // no abort signal for now
      );

      // If effort was rejected, retry once without effort
      if (result.effortRejected && effort) {
        logger.logTaskEnd(task, false, `effort "${effort}" rejected by model, retrying without effort`);
        const retryResult = await runTaskProcess(
          ctx.cwd,
          prompt,
          model,
          null,
          undefined,
        );
        if (retryResult.exitCode === 0) {
          const commitMsg = config.commitMessageTemplate
            .replace("{{taskTitle}}", task.title)
            .replace("{{taskNumber}}", String(task.number));
          const hash = await tryCommit(ctx.cwd, commitMsg, config.commitEnabled);
          const summary = extractLastAssistantText(retryResult.output.split("\n"));
          logger.logTaskEnd(task, true, hash ? `commit ${hash}` : "no commit");
          updatePlanTaskStatus(plan.path, task.id, task.title, "completed");
          return {
            success: true,
            summary: summary.slice(0, 200) || `Task ${task.number} completed`,
          };
        }
        lastError = retryResult.error || `Exit code ${retryResult.exitCode}`;
        break;
      }

      if (result.exitCode === 0) {
        // Try to commit
        const commitMsg = config.commitMessageTemplate
          .replace("{{taskTitle}}", task.title)
          .replace("{{taskNumber}}", String(task.number));
        const hash = await tryCommit(ctx.cwd, commitMsg, config.commitEnabled);

        // Extract summary from output
        const summary = extractLastAssistantText(result.output.split("\n"));

        logger.logTaskEnd(task, true, hash ? `commit ${hash}` : "no commit");
        updatePlanTaskStatus(plan.path, task.id, task.title, "completed");

        return {
          success: true,
          summary: summary.slice(0, 200) || `Task ${task.number} completed`,
        };
      } else {
        lastError = result.error || `Exit code ${result.exitCode}`;
        if (attempt <= config.maxRetries) {
          logger.logTaskEnd(task, false, `attempt ${attempt} failed, retrying (${lastError})`);
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt <= config.maxRetries) {
        logger.logTaskEnd(task, false, `attempt ${attempt} failed, retrying`);
      }
    }
  }

  // All retries exhausted
  logger.logTaskEnd(task, false, lastError);
  updatePlanTaskStatus(plan.path, task.id, task.title, "failed");
  return { success: false, error: lastError };
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
