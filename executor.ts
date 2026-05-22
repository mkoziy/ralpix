/**
 * Task execution engine — runs each task in an isolated pi session.
 */

import { execSync } from "node:child_process";

import { buildModelArg, resolveModel, resolvePiAgentDir } from "./config.js";
import { parsePlan, updatePlanTaskStatus } from "./parser.js";
import { createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

import type { ProgressLogger } from "./logger.js";
import type { ModelConfig, Plan, PlanTask, RalpixConfig, SubprocessUsage, TaskResult } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface TaskSessionReport {
  success: boolean;
  summary: string;
}

export interface TaskExecutionHooks {
  onTaskStart?: (task: PlanTask) => void;
  onTaskFinish?: (task: PlanTask, result: TaskResult) => void;
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
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
  };
}

async function runTaskSession(
  ctx: ExtensionCommandContext,
  planPath: string,
  promptContent: string,
  modelCfg: ModelConfig,
  piAgentDir: string | null,
  config: RalpixConfig,
  onProgress?: (detail: string) => void,
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void,
): Promise<TaskSessionReport> {
  const result = await runPiSubprocessPrompt(
    ctx.cwd,
    buildTaskPrompt(promptContent),
    modelCfg,
    true,
    30 * 60 * 1000,
    createPiProgressHooks(onProgress, onUsage),
    piAgentDir,
    config,
  );
  const report = parseTaskSessionReport(result.lastAssistantText);

  // Detect the optional completion signal (model claims all tasks are done)
  const allDoneSignal = (/<<<ralpix:all_tasks_done>>>/i).test(result.lastAssistantText);

  if (report !== null) {
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

  const stderr = result.error.trim();
  const assistantText = result.lastAssistantText.trim();
  let detail = `pi exited with code ${String(result.exitCode)}`;
  if (assistantText.length > 0) detail = assistantText;
  if (stderr.length > 0) detail = stderr;

  return {
    success: false,
    summary: `Task session did not report a structured result. ${detail}`.slice(0, 500),
  };
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
  logger: ProgressLogger,
  hooks?: TaskExecutionHooks,
): Promise<TaskResult> {
  hooks?.onTaskStart?.(task);
  logger.logTaskStart(task);

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

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const modelLabel = buildModelArg(modelCfg) ?? modelCfg.provider ?? "session default";
      logger.logTaskInfo(task, `attempt ${attempt} launched (${modelLabel})`);
      ctx.ui.notify(`ralpix: ${task.title} — attempt ${attempt} started`, "info");
      const result = await runTaskSession(ctx, plan.path, prompt, modelCfg, piAgentDir, config, (detail) => {
        logger.logTaskInfo(task, `attempt ${attempt}: ${detail}`);
      }, hooks?.onUsage);

      if (result.success) {
        const commitMsg = config.commitMessageTemplate
          .replaceAll("{{taskTitle}}", task.title)
          .replaceAll("{{taskNumber}}", String(task.number));
        const hash = tryCommit(ctx.cwd, commitMsg, config.commitEnabled);

        logger.logTaskEnd(task, true, hash === null ? "no commit" : `commit ${hash}`);
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

  const finalError = lastError ?? "Unknown error";
  logger.logTaskEnd(task, false, finalError);
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
  logger: ProgressLogger,
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

    const result = await executeTask(ctx, pi, task, config, plan, logger, hooks);
    results.push(result);

    if (!result.success) break;
  }

  return results;
}
