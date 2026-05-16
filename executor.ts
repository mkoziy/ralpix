/**
 * Task execution engine — runs each task in an isolated pi session.
 */

import { execSync } from "node:child_process";

import { Type } from "typebox";

import { applyModelConfigToSession, resolveModel } from "./config.js";
import { updatePlanTaskStatus } from "./parser.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

import type { ProgressLogger } from "./logger.js";
import type { ModelConfig, Plan, PlanTask, RalpixConfig, TaskResult } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext, SessionContext } from "@earendil-works/pi-coding-agent";

interface TaskSessionReport {
  success: boolean;
  summary: string;
}

function buildTaskPrompt(promptContent: string): string {
  return [
    promptContent,
    "",
    "## Completion Contract",
    "Before finishing, call `ralpix_report_task_result` exactly once.",
    "- Use `success: true` with a concise summary when the task is complete.",
    "- Use `success: false` with the blocker or failure reason when you cannot complete the task.",
    "Do not end the session without calling this tool.",
  ].join("\n");
}

async function runTaskSession(
  ctx: ExtensionCommandContext,
  promptContent: string,
  modelCfg: ModelConfig,
): Promise<TaskSessionReport> {
  const state: { report?: TaskSessionReport } = {};

  await ctx.newSession({
    setup: (sm) => applyModelConfigToSession(sm, modelCfg),
    withSession: async (taskCtx: SessionContext) => {
      taskCtx.registerTool({
        name: "ralpix_report_task_result",
        label: "Report Task Result",
        description: "Report the final task status and concise summary.",
        promptSnippet: "Report task result: {{summary}}",
        /* eslint-disable @typescript-eslint/no-unsafe-assignment */
        parameters: Type.Object({
          success: Type.Boolean({
            description: "True when the task is complete, false when blocked or failed.",
          }),
          summary: Type.String({
            description: "Short summary of completed work or the blocking issue.",
          }),
        }),
        /* eslint-enable @typescript-eslint/no-unsafe-assignment */
        execute(_toolCallId, params) {
          state.report = {
            success: params["success"] as boolean,
            summary: params["summary"] as string,
          };
          return {
            content: [
              { type: "text", text: "Task result recorded." },
            ],
          };
        },
      });

      await taskCtx.sendUserMessage(buildTaskPrompt(promptContent));
      await taskCtx.waitForIdle();
    },
  });

  return state.report ?? {
    success: false,
    summary: "Session ended without reporting a task result.",
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
): Promise<TaskResult> {
  logger.logTaskStart(task);

  const template = loadPrompt("task-default", ctx.cwd);
  const prompt = expandPrompt(template, {
    OVERVIEW: plan.overview.length > 0 ? plan.overview : plan.title,
    TASK_TITLE: task.title,
    TASK_DESCRIPTION: task.description.length > 0
      ? task.description
      : task.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n"),
  });

  updatePlanTaskStatus(plan.path, task.id, task.title, "in-progress");

  const modelCfg = resolveModel(config, "task");
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    try {
      const result = await runTaskSession(ctx, prompt, modelCfg);

      if (result.success) {
        const commitMsg = config.commitMessageTemplate
          .replaceAll("{{taskTitle}}", task.title)
          .replaceAll("{{taskNumber}}", String(task.number));
        const hash = tryCommit(ctx.cwd, commitMsg, config.commitEnabled);

        logger.logTaskEnd(task, true, hash === null ? "no commit" : `commit ${hash}`);
        updatePlanTaskStatus(plan.path, task.id, task.title, "completed");

        return {
          success: true,
          summary: result.summary.slice(0, 200).length > 0
            ? result.summary.slice(0, 200)
            : `Task ${task.number} completed`,
        };
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
  return { success: false, error: finalError };
}

export async function executeAllTasks(
  ctx: ExtensionCommandContext,
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

    if (!result.success) break;
  }

  return results;
}
