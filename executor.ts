import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { resolveModel, resolvePiAgentDir } from "./config.js";
import { updatePlanTaskStatus } from "./parser.js";
import { runPiSubprocessPrompt } from "./pi-subprocess.js";
import { expandPrompt, loadPrompt } from "./prompt.js";
import { createTokenLedger } from "./tui.js";
import { usageToData } from "./utils.js";

import type { RunSession } from "./event-bus.js";
import type { PiCommand, RunPiSubprocessConfig, SubprocessResult } from "./pi-subprocess.js";
import type { ModelConfig, Plan, PlanTask, RalpixConfig, SubprocessUsage } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const ALL_DONE_SIGNAL_RE = /<<<ralpix:all_tasks_done>>>/i;
const TASK_RESULT_RE = /<ralpix_task_result>\s*([\S\s]*?)\s*<\/ralpix_task_result>/i;
const SUCCESS_RE = /^\s*success:\s*(true|false)\s*$/im;
const SUMMARY_RE = /^\s*summary:\s*(.+)$/im;
const TASK_HEADER_RE = (/^\s*###\s+(?:task|iteration)\s+\d+:/im);
const UNCHECKED_BOX_RE = (/-\s+\[\s]/);

interface TaskSessionReport {
  success: boolean;
  summary: string;
  detail: string;
}

interface UsageAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ExecutorDependencies {
  loadPrompt?: (name: string, cwd: string) => string;
  runPrompt?: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
  tryCommit?: (cwd: string, message: string, enabled: boolean) => string | null;
}

type RunPromptFn = NonNullable<ExecutorDependencies["runPrompt"]>;

export async function executeAllTasks(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  dependencies: ExecutorDependencies = {},
): Promise<void> {
  const promptLoader = dependencies.loadPrompt ?? loadPrompt;
  const runPrompt: RunPromptFn = dependencies.runPrompt ?? runPiSubprocessPrompt;
  const commit: NonNullable<ExecutorDependencies["tryCommit"]> = dependencies.tryCommit ?? tryCommit;

  const template = promptLoader("task-default", ctx.cwd);
  const model = resolveModel(config, "task");
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);

  for (const task of plan.tasks) {
    if (task.status === "completed" || task.status === "failed") continue;
    const succeeded = await executeTask(
      ctx,
      pi,
      plan,
      task,
      config,
      session,
      template,
      model,
      piAgentDir,
      runPrompt,
      commit,
    );
    if (!succeeded) break;
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function executeTask(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  task: PlanTask,
  config: RalpixConfig,
  session: RunSession,
  template: string,
  model: ModelConfig,
  piAgentDir: string | null,
  runPrompt: RunPromptFn,
  commit: NonNullable<ExecutorDependencies["tryCommit"]>,
): Promise<boolean> {
  session.log("task_start", {
    taskId: task.id,
    taskNumber: task.number,
    taskTitle: task.title,
    itemCount: task.items.length,
  });

  task.status = "in-progress";
  updatePlanTaskStatus(plan.path, task.id, task.title, "in-progress");

  const prompt = buildTaskPrompt(template, plan, task);
  const taskLedger = createTokenLedger();
  const totalUsage = emptyUsage();
  let lastReport: TaskSessionReport | null = null;
  let abortRetries = false;

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    const attemptLedger = createTokenLedger();
    const ledger = {
      add(provider: string, modelName: string, usage: SubprocessUsage) {
        taskLedger.add(provider, modelName, usage);
        attemptLedger.add(provider, modelName, usage);
      },
      totalText() {
        return formatUsageText(totalUsage);
      },
    };

    session.log("attempt_start", {
      taskId: task.id,
      attempt,
      modelLabel: modelLabel(model),
    });

    try {
      const result = await runPrompt(
        ctx,
        pi,
        withCompletionContract(prompt),
        {
          ...model,
          piAgentDir,
          timeoutMs: TASK_TIMEOUT_MS,
          ledger,
        },
        session,
      );

      addUsage(totalUsage, result.usage);
      const materialFailure = detectMaterialFailure(result.stdout);
      const report = resolveTaskSessionReport(result);
      const allDoneSignal = hasAllDoneSignal(result);
      const materialFailureDetail = materialFailure === null
        ? null
        : `Task session encountered a material tool failure: ${materialFailure}`;

      lastReport = materialFailureDetail === null
        ? report
        : {
          success: false,
          summary: materialFailureDetail,
          detail: materialFailureDetail,
        };

      if (allDoneSignal && hasRemainingTasks(plan.path)) {
        session.milestone("guard", `Ignored premature all-tasks-done signal for ${task.title}`);
      }

      session.log("attempt_end", {
        taskId: task.id,
        attempt,
        success: lastReport.success,
        usage: usageToData(
          result.usage,
          {
            input: totalUsage.input + totalUsage.cacheRead + totalUsage.cacheWrite,
            output: totalUsage.output,
            cost: totalUsage.cost,
          },
          attemptLedger.breakdown(),
        ),
      });

      if (lastReport.success) {
        const commitHash = commit(
          ctx.cwd,
          config.commitMessageTemplate
            .replaceAll("{{taskTitle}}", task.title)
            .replaceAll("{{taskNumber}}", String(task.number)),
          config.commitEnabled,
        );

        task.status = "completed";
        updatePlanTaskStatus(plan.path, task.id, task.title, "completed");
        session.log("task_end", {
          taskId: task.id,
          taskNumber: task.number,
          taskTitle: task.title,
          success: true,
          ...(config.commitEnabled ? { committed: commitHash !== null } : {}),
          usage: usageToData(
            { ...totalUsage },
            {
              input: totalUsage.input + totalUsage.cacheRead + totalUsage.cacheWrite,
              output: totalUsage.output,
              cost: totalUsage.cost,
            },
            taskLedger.breakdown(),
          ),
        });
        return true;
      }

      abortRetries = materialFailure !== null;
      if (abortRetries || attempt > config.maxRetries) break;
    } catch (error) {
      lastReport = failureReport(error);
      session.log("attempt_end", {
        taskId: task.id,
        attempt,
        success: false,
        usage: usageToData(
          emptyUsage(),
          {
            input: totalUsage.input + totalUsage.cacheRead + totalUsage.cacheWrite,
            output: totalUsage.output,
            cost: totalUsage.cost,
          },
          attemptLedger.breakdown(),
        ),
      });
      if (attempt > config.maxRetries) break;
    }
  }

  task.status = "failed";
  updatePlanTaskStatus(plan.path, task.id, task.title, "failed");
  session.log("task_end", {
    taskId: task.id,
    taskNumber: task.number,
    taskTitle: task.title,
    success: false,
    detail: lastReport?.detail ?? "Task failed",
    ...(config.commitEnabled ? { committed: false } : {}),
    usage: usageToData(
      { ...totalUsage },
      {
        input: totalUsage.input + totalUsage.cacheRead + totalUsage.cacheWrite,
        output: totalUsage.output,
        cost: totalUsage.cost,
      },
      taskLedger.breakdown(),
    ),
  });
  return false;
}

function buildTaskPrompt(template: string, plan: Plan, task: PlanTask): string {
  const contextBlock = plan.context.length > 0 ? `## Project Context\n${plan.context}` : "";
  const extraSectionsBlock = Object.keys(plan.extraSections).length === 0
    ? ""
    : [
      "## Additional Context",
      ...Object.entries(plan.extraSections).map(([key, value]) => `## ${key}\n${value}`),
    ].join("\n\n");

  return expandPrompt(template, {
    OVERVIEW: plan.overview.length > 0 ? plan.overview : plan.title,
    CONTEXT_BLOCK: contextBlock,
    TASK_TITLE: task.title,
    TASK_DESCRIPTION: task.description.length > 0
      ? task.description
      : task.items.map((item) => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n"),
    EXTRA_SECTIONS_BLOCK: extraSectionsBlock,
  });
}

function withCompletionContract(prompt: string): string {
  return [
    prompt,
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

function resolveTaskSessionReport(result: SubprocessResult): TaskSessionReport {
  const text = [result.message, result.stdout].filter((value): value is string => typeof value === "string").join("\n");
  const match = TASK_RESULT_RE.exec(text);
  if (match?.[1] != null) {
    const success = SUCCESS_RE.exec(match[1])?.[1]?.toLowerCase();
    const summary = SUMMARY_RE.exec(match[1])?.[1]?.trim();
    if (success !== undefined && summary !== undefined && summary.length > 0) {
      if (result.exitCode !== 0 && success === "true") {
        return {
          success: false,
          summary: `Task session exited with code ${String(result.exitCode)} despite reporting success`,
          detail: `Task session exited with code ${String(result.exitCode)} despite reporting success`,
        };
      }
      return { success: success === "true", summary, detail: summary };
    }
  }

  if (result.message !== undefined && result.message.trim().length > 0) {
    return {
      success: false,
      summary: previewSummary(result.message.trim()),
      detail: result.message.trim(),
    };
  }

  if (result.stderr.trim().length > 0) {
    return {
      success: false,
      summary: previewSummary(result.stderr.trim()),
      detail: result.stderr.trim(),
    };
  }

  return {
    success: false,
    summary: `Task session did not report a structured result. pi exited with ${String(result.exitCode)}`,
    detail: `Task session did not report a structured result. pi exited with ${String(result.exitCode)}`,
  };
}

function detectMaterialFailure(stdout: string): string | null {
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const type = readString(payload["type"]) ?? readString(payload["event"]);
      if (type !== "tool_execution_end") continue;
      if (payload["isError"] !== true) continue;
      const toolName = readString(payload["toolName"]) ?? "tool";
      if (!isMaterialToolFailure(toolName, payload["args"])) continue;
      return summarizeToolCall(toolName, payload["args"]);
    } catch {
      continue;
    }
  }
  return null;
}

function hasAllDoneSignal(result: SubprocessResult): boolean {
  return ALL_DONE_SIGNAL_RE.test(result.message ?? "") || ALL_DONE_SIGNAL_RE.test(result.stdout);
}

function hasRemainingTasks(planPath: string): boolean {
  try {
    const content = readFileSync(planPath, "utf8");
    return TASK_HEADER_RE.test(content) && UNCHECKED_BOX_RE.test(content);
  } catch {
    return true;
  }
}

function isMaterialToolFailure(toolName: string, args: unknown): boolean {
  const normalizedTool = toolName.toLowerCase();
  if (normalizedTool === "read" || normalizedTool === "open" || normalizedTool === "find") return false;
  if (!["bash", "exec_command", "shell"].includes(normalizedTool)) return false;
  const text = extractToolText(args);
  return text === null ? false : isMaterialShellFailure(text);
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

function extractToolText(args: unknown): string | null {
  if (typeof args === "string") return compact(args);
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  const command = record["cmd"] ?? record["command"];
  if (typeof command === "string") return compact(command);
  const query = record["q"];
  if (typeof query === "string") return compact(query);
  const parts = Object.entries(record)
    .flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [`${key}=${String(value)}`];
      }
      return [];
    })
    .slice(0, 3);
  return parts.length === 0 ? null : compact(parts.join(" "));
}

function summarizeToolCall(toolName: string, args: unknown): string {
  const text = extractToolText(args);
  return text === null ? toolName : `${toolName} ${previewSummary(text, 100)}`;
}

function previewSummary(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function compact(text: string): string {
  const value = text.replaceAll(/\s+/gu, " ").trim();
  return value.length === 0 ? "" : value;
}

function modelLabel(model: ModelConfig): string {
  if (model.model?.includes("/") === true) return model.model;
  if (model.provider !== null && model.model !== null) return `${model.provider}/${model.model}`;
  if (model.model !== null) return model.model;
  if (model.provider !== null) return model.provider;
  return "session default";
}

function emptyUsage(): UsageAccumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsage(target: UsageAccumulator, usage: SubprocessUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost;
}

function formatUsageText(usage: UsageAccumulator): string {
  return `in ${String(usage.input + usage.cacheRead + usage.cacheWrite)} out ${String(usage.output)} $${usage.cost.toFixed(3)}`;
}

function failureReport(error: unknown): TaskSessionReport {
  const detail = error instanceof Error ? error.message : String(error);
  return { success: false, summary: previewSummary(detail), detail };
}

function tryCommit(cwd: string, message: string, enabled: boolean): string | null {
  if (!enabled) return null;
  try {
    const status = execSync("git status --porcelain", { cwd, encoding: "utf8" });
    if (status.trim().length === 0) return null;
    execSync(`git add -A && git commit -m ${shellQuote(message)}`, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    return execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", String.raw`'\''`) + "'";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
