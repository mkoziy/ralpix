/**
 * Task execution engine — runs each task in an isolated pi session.
 */

import { execSync } from "node:child_process";

import { buildModelArg, resolveModel, resolvePiAgentDir } from "./config.js";
import { createEventBus, formatTotalUsageText, type RunSession } from "./event-bus.js";
import { parsePlan, updatePlanTaskStatus } from "./parser.js";
import {
  createPiProgressHooks,
  extractPiToolText,
  runPiSubprocessPrompt,
  summarizePiToolCall,
} from "./pi-subprocess.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
import { createTokenLedger } from "./tui.js";

import type { EventUsage } from "./events.js";
import type { PiSubprocessHooks, PiSubprocessResult } from "./pi-subprocess.js";
import type { ModelConfig, Plan, PlanTask, RalpixConfig, SubprocessUsage, TaskResult } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

function buildUsage(
  stepLedger: ReturnType<typeof createTokenLedger>,
  totalLedger: ReturnType<typeof createTokenLedger>,
): EventUsage {
  const stepSnap = stepLedger.detailedSnapshot();
  const totalSnap = totalLedger.detailedSnapshot();
  const bd = stepLedger.breakdown();
  return {
    step: { input: stepSnap.input, output: stepSnap.output, cacheRead: stepSnap.cacheRead, cacheWrite: stepSnap.cacheWrite, cost: stepSnap.cost },
    total: { input: totalSnap.input, output: totalSnap.output, cost: totalSnap.cost },
    ...(bd.length > 0 ? { breakdown: bd } : {}),
  };
}

interface TaskSessionReport {
  success: boolean;
  summary: string;
  fullSummary?: string;
}

function previewSummary(text: string, limit = 500): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function isMaterialShellFailure(commandText: string): boolean {
  const normalized = commandText.toLowerCase();
  const firstToken = normalized.split(/\s+/u).find((token) => token.length > 0) ?? "";

  if ((/(\b|\/)(test|check|lint|typecheck|build)(\b|$)/u).test(normalized)) return true;
  if (normalized.includes("pytest") || normalized.includes("vitest") || normalized.includes("jest")) return true;

  return [
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "bunx",
    "go",
    "cargo",
    "make",
    "tsc",
    "eslint",
    "ruff",
    "biome",
  ].includes(firstToken);
}

function isMaterialToolFailure(toolName: string, args: unknown): boolean {
  const normalizedTool = toolName.toLowerCase();
  if (normalizedTool === "read" || normalizedTool === "open" || normalizedTool === "find") return false;

  if (normalizedTool === "bash" || normalizedTool === "exec_command" || normalizedTool === "shell") {
    const text = extractPiToolText(args);
    return text == null ? false : isMaterialShellFailure(text);
  }

  return false;
}

export function resolveTaskSessionReport(
  result: PiSubprocessResult,
  report: TaskSessionReport | null,
): TaskSessionReport {
  if (report !== null) {
    if (result.exitCode !== 0) {
      return {
        success: false,
        summary: `Task session exited with code ${String(result.exitCode)} despite reporting success`,
      };
    }
    return { ...report, fullSummary: report.fullSummary ?? report.summary };
  }

  const stderr = result.error.trim();
  const assistantText = result.lastAssistantText.trim();
  let detail = `pi exited with code ${String(result.exitCode)}`;
  if (assistantText.length > 0) detail = assistantText;
  if (stderr.length > 0) detail = stderr;

  const fullSummary = `Task session did not report a structured result. ${detail}`;
  return {
    success: false,
    summary: previewSummary(fullSummary),
    fullSummary,
  };
}

export interface TaskExecutionHooks {
  session?: RunSession;
  onTaskStart?: (task: PlanTask) => void;
  onTaskFinish?: (task: PlanTask, result: TaskResult) => void;
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
  _runSession?: (
    ctx: ExtensionCommandContext,
    planPath: string,
    promptContent: string,
    modelCfg: ModelConfig,
    piAgentDir: string | null,
    config: RalpixConfig,
    hooks?: PiSubprocessHooks,
  ) => Promise<TaskSessionReport>;
}

export function buildTaskPrompt(promptContent: string): string {
  return [
    promptContent,
    "",
    "## Completion Contract",
    "End your final response with this exact block and nothing after it:",
    "<RALPIX_TASK_RESULT>",
    "Success: true|false",
    "Summary: <one-line concise summary>",
    "</RALPIX_TASK_RESULT>",
    "Use `Success: true` only when the task is complete.",
    "Use `Success: false` with the blocker or failure reason when you cannot complete the task.",
    "Do not end your response without this block.",
  ].join("\n");
}

export function parseTaskSessionReport(text: string): TaskSessionReport | null {
  const match = (/<ralpix_task_result>\s*([\S\s]*?)\s*<\/ralpix_task_result>/i).exec(text);
  if (match?.[1] == null) return null;

  const body = match[1];
  const successMatch = (/^\s*success:\s*(true|false)\s*$/im).exec(body);
  const summaryMatch = (/^\s*summary:\s*(.+)$/im).exec(body);
  const successRaw = successMatch?.[1]?.toLowerCase();
  const summary = summaryMatch?.[1]?.trim();

  if (successRaw == null || summary == null || summary.length === 0) return null;
  return {
    success: successRaw === "true",
    summary,
    fullSummary: summary,
  };
}

async function runTaskSession(
  ctx: ExtensionCommandContext,
  planPath: string,
  promptContent: string,
  modelCfg: ModelConfig,
  piAgentDir: string | null,
  config: RalpixConfig,
  hooks?: PiSubprocessHooks,
): Promise<TaskSessionReport> {
  const result = await runPiSubprocessPrompt(
    ctx.cwd,
    buildTaskPrompt(promptContent),
    modelCfg,
    true,
    30 * 60 * 1000,
    hooks,
    piAgentDir,
    config,
  );
  const report = parseTaskSessionReport(result.lastAssistantText);

  // Detect the optional completion signal (model claims all tasks are done)
  const allDoneSignal = (/<<<ralpix:all_tasks_done>>>/i).test(result.lastAssistantText);

  if (report !== null && result.exitCode === 0) {
    if (report.success && allDoneSignal) {
      // Host-verified completion: re-parse plan to guard against hallucination
      try {
        const refreshed = parsePlan(planPath);
        const hasPending = refreshed.tasks.some(
          (t) => t.status === "pending" || t.status === "in-progress",
        );
        if (!hasPending) {
          return { ...report, summary: `${report.summary} (all tasks done — verified)` };
        }
        // Signal was emitted but tasks remain — warn and treat as normal success
      } catch {
        // ignore parse errors, fall through to normal report
      }
    }
    return report;
  }
  return resolveTaskSessionReport(result, report);
}

function tryCommit(
  cwd: string,
  message: string,
  enabled: boolean,
): string | null {
  if (!enabled) return null;

  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
    if (status.trim().length === 0) return null;

    const escapedMessage = message.replaceAll('"', String.raw`\"`);
    execSync(`git add -A && git commit -m "${escapedMessage}"`, {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    });

    return execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function executeTask(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  task: PlanTask,
  config: RalpixConfig,
  plan: Plan,
  hooks?: TaskExecutionHooks,
): Promise<TaskResult> {
  hooks?.onTaskStart?.(task);

  const session = hooks?.session ?? createEventBus(ctx, "execute", []);
  session.log("task_start", { taskId: task.id, taskNumber: task.number, taskTitle: task.title, itemCount: task.items.length });

  const ledger = createTokenLedger();

  const template = loadPrompt("task-default", ctx.cwd);

  // Pre-build context blocks so empty values leave no stray headings
  const contextBlock = plan.context.length > 0
    ? `## Project Context\n${plan.context}`
    : "";

  const extraKeys = Object.keys(plan.extraSections);
  const extraSectionsInner = extraKeys.length > 0
    ? extraKeys
      .map((key) => `## ${key}\n${plan.extraSections[key] ?? ""}`)
      .join("\n\n")
    : "";
  const extraSectionsBlock = extraSectionsInner.length > 0
    ? `## Additional Context\n${extraSectionsInner}`
    : "";

  const prompt = expandPrompt(template, {
    OVERVIEW: plan.overview.length > 0 ? plan.overview : plan.title,
    CONTEXT_BLOCK: contextBlock,
    TASK_TITLE: task.title,
    TASK_DESCRIPTION: task.description.length > 0
      ? task.description
      : task.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n"),
    EXTRA_SECTIONS_BLOCK: extraSectionsBlock,
  });

  updatePlanTaskStatus(plan.path, task.id, task.title, "in-progress");

  const modelCfg = resolveModel(config, "task");
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);
  let lastError: string | undefined;
  let lastErrorFull: string | undefined;
  const runSession = hooks?._runSession ?? runTaskSession;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const attemptLedger = createTokenLedger();
    try {
      const modelLabel = buildModelArg(modelCfg) ?? modelCfg.provider ?? "session default";
      session.log("attempt_start", { taskId: task.id, attempt, modelLabel });
      session.message("info", `${task.title} - attempt ${attempt} started`);
      session.status("running", `Attempt ${attempt}: running...`);

      let toolFailureLabel: string | undefined;
      const progressHooks = createPiProgressHooks(
        (detail) => {
          session.status("running", `Attempt ${attempt}: ${detail}`);
        },
        (provider, model, usage) => {
          ledger.add(provider, model, usage);
          attemptLedger.add(provider, model, usage);
          session.usage(formatTotalUsageText(ledger.snapshot()));
          hooks?.onUsage?.(provider, model, usage);
        },
      );
      const wrappedHooks: PiSubprocessHooks = {
        ...progressHooks,
        onEvent(event) {
          progressHooks.onEvent?.(event);
          if (
            event.type === "tool_execution_end" &&
            event.isError === true &&
            isMaterialToolFailure(event.toolName ?? "tool", event.args)
          ) {
            toolFailureLabel = summarizePiToolCall(event.toolName ?? "tool", event.args);
          }
        },
      };

      const rawResult = await runSession(
        ctx,
        plan.path,
        prompt,
        modelCfg,
        piAgentDir,
        config,
        wrappedHooks,
      );
      const result = toolFailureLabel == null || !rawResult.success
        ? rawResult
        : {
          success: false,
          summary: `Task session reported success after a tool failure: ${toolFailureLabel}`,
          fullSummary: `Task session reported success after a tool failure: ${toolFailureLabel}`,
        };

      if (result.success) {
        session.message("success", `Attempt ${attempt}: ${result.summary}`);
        session.message("result", ledger.usageLines().join("\n"));
        session.status("complete", "Task complete!");

        const commitMsg = config.commitMessageTemplate
          .replaceAll("{{taskTitle}}", task.title)
          .replaceAll("{{taskNumber}}", String(task.number));
        const hash = tryCommit(ctx.cwd, commitMsg, config.commitEnabled);

        session.log("attempt_end", { taskId: task.id, attempt, success: true, usage: buildUsage(attemptLedger, ledger) });
        session.log("task_end", {
          taskId: task.id,
          taskNumber: task.number,
          taskTitle: task.title,
          success: true,
          ...(hash !== null ? { committed: true } : {}),
          usage: buildUsage(ledger, ledger),
        });
        if (hooks?.session == null) {
          session.close();
        }
        updatePlanTaskStatus(plan.path, task.id, task.title, "completed");

        const taskResult = {
          success: true,
          summary: result.summary.slice(0, 200).length > 0
            ? result.summary.slice(0, 200)
            : `Task ${task.number} completed`,
        };
        hooks?.onTaskFinish?.(task, taskResult);
        return taskResult;
      }

      lastError = result.summary;
      lastErrorFull = result.fullSummary ?? result.summary;
      session.log("attempt_end", { taskId: task.id, attempt, success: false, usage: buildUsage(attemptLedger, ledger) });
      if (attempt <= config.maxRetries) {
        session.message("warning", `Attempt ${attempt}: ${lastError.slice(0, 100)}`);
        session.status("retrying", `Retrying after attempt ${attempt}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      lastErrorFull = lastError;
      session.log("attempt_end", { taskId: task.id, attempt, success: false, usage: buildUsage(attemptLedger, ledger) });
    }
  }

  const finalError = lastError ?? "Unknown error";
  const finalErrorFull = lastErrorFull ?? finalError;
  session.message("error", `Failed after ${config.maxRetries + 1} attempts`);
  session.status("failed", "Task failed");
  session.log("task_end", {
    taskId: task.id,
    taskNumber: task.number,
    taskTitle: task.title,
    success: false,
    detail: finalErrorFull,
    usage: buildUsage(ledger, ledger),
  });
  if (hooks?.session == null) {
    session.close();
  }
  updatePlanTaskStatus(plan.path, task.id, task.title, "failed");
  const taskResult = { success: false, error: finalError };
  hooks?.onTaskFinish?.(task, taskResult);
  return taskResult;
}

export async function executeAllTasks(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  plan: Plan,
  config: RalpixConfig,
  hooks?: TaskExecutionHooks,
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

    const result = await executeTask(ctx, pi, task, config, plan, hooks);
    results.push(result);

    if (!result.success) break;
  }

  return results;
}
