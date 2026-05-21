/**
 * ralpix — Autonomous Plan Execution Extension for pi
 *
 * Reads ralpix-format markdown plans and executes tasks hands-off.
 * Each task runs in an isolated pi process (spawn) to keep context sharp.
 *
 * Commands:
 *   /ralpix plan <desc>  — Create a plan interactively
 *   /ralpix init          — Initialise ~/.ralpix/ with defaults
 *   /ralpix <path>        — Execute a plan
 *
 * Tools (for LLM):
 *   ralpix_mark_task_done — Mark current task as complete
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join as pathJoin, parse as pathParse } from "node:path";

import { Type } from "typebox";

import { initRalpixHome, loadConfig, ralpixHomeDir } from "./config.js";
import { executeAllTasks } from "./executor.js";
import { ProgressLogger, fmtTokens, type UsageSummary } from "./logger.js";
import { parsePlan } from "./parser.js";
import { runPlanCreation } from "./planner.js";
import { runReviewPipeline } from "./reviewer.js";

import type {
  RalpixState,
  ReviewPipelineState,
  ReviewStageId,
  ReviewStageState,
  ReviewStageStatus,
  SubprocessUsage,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

const STATE_TYPE = "ralpix-state";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

type NotifyLevel = "error" | "info" | "success" | "warning";
type NotifyFn = (message: string, level: NotifyLevel) => void;

interface WidgetLine {
  color: string;
  text: string;
}

interface StatusWidgetView {
  statusText: string;
  lines: WidgetLine[];
}

type UsageByModel = Map<string, UsageSummary>;
type UsageById = Map<string, UsageByModel>;

interface CurrentStepView {
  title: string;
  detail?: string;
  usageLines: string[];
}

interface HistoryStepView {
  line: WidgetLine;
  usageLines: string[];
}

// ---------------------------------------------------------------------------
// Token ledger
// ---------------------------------------------------------------------------

function createTokenLedger() {
  const map = new Map<string, UsageSummary>();

  function add(provider: string, model: string, usage: SubprocessUsage): void {
    const key = `${provider}/${model}`;
    const e = map.get(key) ?? { input: 0, output: 0, cost: 0 };
    map.set(key, {
      input: e.input + usage.input + usage.cacheRead + usage.cacheWrite,
      output: e.output + usage.output,
      cost: e.cost + usage.cost,
    });
  }

  function totalCost(): number {
    let total = 0;
    for (const e of map.values()) total += e.cost;
    return total;
  }

  function snapshot(): UsageSummary {
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const e of map.values()) {
      input += e.input;
      output += e.output;
      cost += e.cost;
    }
    return { input, output, cost };
  }

  function diffSince(previous: UsageSummary): UsageSummary {
    const current = snapshot();
    return {
      input: current.input - previous.input,
      output: current.output - previous.output,
      cost: current.cost - previous.cost,
    };
  }

  return { add, diffSince, snapshot, totalCost };
}

type TokenLedger = ReturnType<typeof createTokenLedger>;

function recordUsage(
  usageById: UsageById,
  id: string,
  provider: string,
  model: string,
  usage: SubprocessUsage,
): void {
  const key = `${provider}/${model}`;
  const perModel = usageById.get(id) ?? new Map<string, UsageSummary>();
  const previous = perModel.get(key) ?? { input: 0, output: 0, cost: 0 };
  perModel.set(key, {
    input: previous.input + usage.input + usage.cacheRead + usage.cacheWrite,
    output: previous.output + usage.output,
    cost: previous.cost + usage.cost,
  });
  usageById.set(id, perModel);
}

function usageLinesFor(id: string, usageById: UsageById): string[] {
  const perModel = usageById.get(id);
  if (perModel === undefined) return [];
  return [...perModel.entries()].map(
    ([key, usage]) => `${key}  in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`,
  );
}

const REVIEW_STAGE_LABELS: Record<ReviewStageId, string> = {
  "first-pass": "First pass",
  "external-review": "External review",
  "external-eval": "External eval",
  "second-pass": "Second pass",
};

function createInitialReviewState(externalReviewEnabled: boolean): ReviewPipelineState {
  return {
    stages: [
      { id: "first-pass", status: "pending" },
      { id: "external-review", status: externalReviewEnabled ? "pending" : "skipped" },
      { id: "external-eval", status: externalReviewEnabled ? "pending" : "skipped" },
      { id: "second-pass", status: "pending" },
    ],
  };
}

function updateReviewStage(
  review: ReviewPipelineState,
  stageId: ReviewStageId,
  status: ReviewStageStatus,
  detail?: string,
): ReviewPipelineState {
  return {
    stages: review.stages.map((stage) => {
      if (stage.id !== stageId) return stage;
      return {
        ...stage,
        status,
        ...(detail === undefined ? {} : { detail }),
      };
    }),
  };
}

function formatReviewStageLine(stage: ReviewStageState): WidgetLine {
  const label = REVIEW_STAGE_LABELS[stage.id];
  const suffix = stage.status === "active" && stage.detail !== undefined && stage.detail.length > 0
    ? ` — ${stage.detail}`
    : "";

  switch (stage.status) {
    case "complete": {
      return { color: "success", text: `✓ ${label}${suffix}` };
    }
    case "failed": {
      return { color: "error", text: `✗ ${label}${suffix}` };
    }
    case "active": {
      return { color: "accent", text: `▶ ${label}${suffix}` };
    }
    case "skipped": {
      return { color: "muted", text: `- ${label}${suffix}` };
    }
    case "pending": {
      return { color: "muted", text: `○ ${label}${suffix}` };
    }
  }
}

function currentStepView(
  state: RalpixState,
  tasks: Array<{ id: string; title: string }>,
  taskUsageById: UsageById,
  reviewUsageById: UsageById,
): CurrentStepView | null {
  if (state.currentTaskId !== null) {
    const task = tasks.find((entry) => entry.id === state.currentTaskId);
    if (task === undefined) return null;
    return {
      title: task.title,
      usageLines: usageLinesFor(task.id, taskUsageById),
    };
  }

  const activeReviewStage = state.review?.stages.find((stage) => stage.status === "active");
  if (activeReviewStage === undefined) return null;

  return {
    title: REVIEW_STAGE_LABELS[activeReviewStage.id],
    usageLines: usageLinesFor(activeReviewStage.id, reviewUsageById),
    ...(activeReviewStage.detail === undefined ? {} : { detail: activeReviewStage.detail }),
  };
}

function buildHistorySteps(
  state: RalpixState,
  tasks: Array<{ id: string; title: string }>,
  taskUsageById: UsageById,
  reviewUsageById: UsageById,
): HistoryStepView[] {
  const steps: HistoryStepView[] = [];

  for (const task of tasks) {
    let line: WidgetLine | null = null;
    if (state.completedTasks.includes(task.id)) {
      line = { color: "success", text: `✓ ${task.title}` };
    } else if (state.failedTasks.includes(task.id)) {
      line = { color: "error", text: `✗ ${task.title}` };
    } else if (state.currentTaskId === task.id) {
      line = { color: "accent", text: `▶ ${task.title}` };
    }

    if (line !== null) {
      steps.push({
        line,
        usageLines: usageLinesFor(task.id, taskUsageById),
      });
    }
  }

  if (state.review !== undefined) {
    for (const stage of state.review.stages) {
      if (stage.status === "pending") continue;
      steps.push({
        line: formatReviewStageLine(stage),
        usageLines: usageLinesFor(stage.id, reviewUsageById),
      });
    }
  }

  return steps;
}

export function buildStatusWidgetView(
  state: RalpixState,
  tasks: Array<{ id: string; title: string }>,
  total: number,
  totalUsage?: UsageSummary,
  taskUsageById: UsageById = new Map(),
  reviewUsageById: UsageById = new Map(),
): StatusWidgetView {
  const { completedTasks, planTitle, phase } = state;
  const done = completedTasks.length;
  const usage = totalUsage ?? { input: 0, output: 0, cost: 0 };
  const costSuffix = usage.cost > 0 ? `  $${usage.cost.toFixed(3)}` : "";

  const lines: WidgetLine[] = [
    { color: "accent", text: `Plan: ${planTitle}` },
    { color: "muted", text: `Phase: ${phase} | ${done}/${total} tasks` },
  ];

  const current = currentStepView(state, tasks, taskUsageById, reviewUsageById);
  if (current !== null) {
    lines.push({ color: "muted", text: "" });
    lines.push({ color: "accent", text: "Now current" });
    lines.push({
      color: "accent",
      text: current.detail === undefined || current.detail.length === 0
        ? current.title
        : `${current.title} — ${current.detail}`,
    });
    for (const usageLine of current.usageLines) {
      lines.push({ color: "muted", text: usageLine });
    }
  }

  const historySteps = buildHistorySteps(state, tasks, taskUsageById, reviewUsageById);
  if (historySteps.length > 0) {
    lines.push({ color: "muted", text: "" });
    lines.push({ color: "accent", text: "Steps" });
    for (const step of historySteps) {
      lines.push(step.line);
      for (const usageLine of step.usageLines) {
        lines.push({ color: "muted", text: usageLine });
      }
    }
  }

  if (usage.input > 0 || usage.output > 0 || usage.cost > 0) {
    lines.push({ color: "muted", text: "" });
    lines.push({ color: "accent", text: "Total usage" });
    lines.push({
      color: "muted",
      text: `in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`,
    });
  }

  return {
    statusText: `📋 ralpix: ${phase} ${done}/${total}${costSuffix}`,
    lines,
  };
}

export function normalizePlanPathArg(rawPath: string): string {
  if (!rawPath.startsWith("@")) return rawPath;

  const unwrappedPath = rawPath.slice(1);
  if (unwrappedPath.startsWith("/") || unwrappedPath.startsWith("./") || unwrappedPath.startsWith("../")) {
    return unwrappedPath;
  }
  if (unwrappedPath.includes("/")) {
    const firstSegment = unwrappedPath.split("/")[0];
    if (firstSegment?.includes(".") === true) {
      return rawPath;
    }
    return unwrappedPath;
  }

  return rawPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function withRalpixErrorHandling(
  action: () => Promise<void>,
  notify: NotifyFn,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    notify(`ralpix error: ${errorMessage(error)}`, "error");
  }
}

export function markTaskExecutionStarted(
  state: RalpixState,
  taskId: string,
): RalpixState {
  return {
    ...state,
    currentTaskId: taskId,
  };
}

export function markTaskExecutionFinished(
  state: RalpixState,
  taskId: string,
  success: boolean,
): RalpixState {
  const completedTasks = success && !state.completedTasks.includes(taskId)
    ? [...state.completedTasks, taskId]
    : state.completedTasks;
  const failedTasks = !success && !state.failedTasks.includes(taskId)
    ? [...state.failedTasks, taskId]
    : state.failedTasks;

  return {
    ...state,
    currentTaskId: null,
    completedTasks,
    failedTasks,
  };
}

function persistState(pi: ExtensionAPI, state: RalpixState): void {
  pi.appendEntry(STATE_TYPE, state);
}

function restoreState(entries: SessionEntry[]): RalpixState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data !== undefined) {
      return entry.data as RalpixState;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------


export default function ralpixExtension(pi: ExtensionAPI): void {
  // ---- /ralpix command ----------------------------------------------------

  pi.registerCommand("ralpix", {
    description: "Execute a ralpix plan (/ralpix <path>, /ralpix init, /ralpix plan <desc>)",
    handler: async (args, ctx) => withRalpixErrorHandling(async () => {
      const trimmed = typeof args === "string" ? args.trim() : "";

      // ── Subcommands first (always accessible regardless of filesystem) ──

      // /ralpix (empty) or /ralpix init
      if (trimmed.length === 0 || trimmed === "init") {
        const ok = await ctx.ui.confirm(
          "Initialize ralpix?",
          "Create ~/.ralpix/ with default prompts, agents, and config?",
        );
        if (ok !== true) return;
        initRalpixHome();
        ctx.ui.notify(
          "ralpix initialized — ~/.ralpix/ created with defaults",
          "success",
        );
        return;
      }

      // /ralpix plan (exact, no description) — show usage
      if (trimmed === "plan") {
        ctx.ui.notify("Usage: /ralpix plan <description>", "error");
        return;
      }

      // ── /ralpix plan <description> ──────────────────────────────
      if (trimmed.startsWith("plan ")) {
        // If the full argument is an existing file path (e.g. a file
        // named "plan drafts/feature.md"), execute it directly instead
        // of treating it as a plan description.
        if (existsSync(resolve(ctx.cwd, trimmed))) {
          await runPlan(trimmed, ctx, pi);
          return;
        }

        const description = trimmed.slice(5).trim();
        if (description.length === 0) {
          ctx.ui.notify("Usage: /ralpix plan <description>", "error");
          return;
        }

        // Auto-init if needed
        if (!existsSync(ralpixHomeDir())) {
          ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
          initRalpixHome();
        }

        const config = loadConfig(ctx.cwd);
        const planPath = await runPlanCreation(description, ctx, pi, config);
        if (planPath !== null) {
          await runPlan(planPath, ctx, pi);
        }
        return;
      }

      // ── Existing plan file? Execute it ──────────────────────────
      if (existsSync(resolve(ctx.cwd, trimmed))) {
        await runPlan(trimmed, ctx, pi);
        return;
      }

      // Execute a plan (fallback — will show "not found" if invalid)
      await runPlan(trimmed, ctx, pi);
    }, (message, level) => {
      ctx.ui.notify(message, level);
    }),
  });

  // ---- tool: ralpix_mark_task_done ----------------------------------------

  pi.registerTool({
    name: "ralpix_mark_task_done",
    label: "Mark Task Done",
    description: "Mark the current plan task as complete during execution",
    promptSnippet: "Mark a ralpix plan task as done",
    /* eslint-disable @typescript-eslint/no-unsafe-assignment */
    parameters: Type.Object({
      taskId: Type.Optional(
        Type.String({ description: "Task ID to mark done (uses current if omitted)" }),
      ),
    }),
    /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    execute(_toolCallId, params) {
      const taskId = typeof params["taskId"] === "string"
        ? params["taskId"]
        : "current";
      return {
        content: [
          {
            type: "text",
            text: `Task ${taskId} marked as done.`,
          },
        ],
        details: {},
      };
    },
  });

  // ---- session_start — restore state and notify on interrupted runs ---------

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as SessionEntry[];
    const state = restoreState(entries);

    if (state !== null && state.phase !== "complete" && state.phase !== "idle") {
      // Notify about interrupted run, suggest resume
      const home = process.env["HOME"] ?? "";
      const displayPath = state.planPath.replace(home, "~");
      const resumeCmd = state.planPath.length > 0 ? `/ralpix ${displayPath}` : "/ralpix";
      ctx.ui.notify(
        `ralpix: previous run of "${state.planTitle}" was interrupted (phase: ${state.phase}).\nResume with: ${resumeCmd}`,
        "warning",
      );

      // Update widget to show last known state
      if (ctx.hasUI) {
        updateStatusWidget(state, ctx);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Plan execution orchestrator
// ---------------------------------------------------------------------------

async function runPlan(
  rawPath: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const planPath = resolve(ctx.cwd, normalizePlanPathArg(rawPath));

  if (!existsSync(planPath)) {
    ctx.ui.notify(`Plan file not found: ${planPath}`, "error");
    return;
  }

  if (!existsSync(ralpixHomeDir())) {
    ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
    initRalpixHome();
  }

  const config = loadConfig(ctx.cwd);
  const plan = parsePlan(planPath);

  const pendingCount = plan.tasks.filter((t) => t.status === "pending").length;
  ctx.ui.notify(
    `ralpix: "${plan.title}" — ${plan.tasks.length} tasks, ${pendingCount} pending`,
    "info",
  );

  // Setup progress logger
  const fileName = planPath.split("/").pop() ?? "plan";
  const planStem = fileName.replace(/\.md$/, "");
  const logger = new ProgressLogger(ctx.cwd, planStem);
  logger.logStart(plan);

  // Token ledger — accumulates usage across all subprocess calls
  const ledger = createTokenLedger();
  const taskUsageById: UsageById = new Map();
  const reviewUsageById: UsageById = new Map();
  const reviewUsageStartById = new Map<ReviewStageId, UsageSummary>();
  const onUsage = (provider: string, model: string, usage: SubprocessUsage): void => {
    ledger.add(provider, model, usage);
    if (state.currentTaskId === null) {
      const activeReviewStage = state.review?.stages.find((stage) => stage.status === "active");
      if (activeReviewStage !== undefined) {
        recordUsage(reviewUsageById, activeReviewStage.id, provider, model, usage);
      }
    } else {
      recordUsage(taskUsageById, state.currentTaskId, provider, model, usage);
    }
    updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
  };
  let taskUsageStart = ledger.snapshot();

  // Initial state
  const state: RalpixState = {
    planPath,
    planTitle: plan.title,
    currentTaskId: null,
    phase: "executing",
    completedTasks: plan.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    failedTasks: plan.tasks.filter((t) => t.status === "failed").map((t) => t.id),
    progressFile: logger.filePath,
    review: createInitialReviewState(config.externalReviewEnabled),
  };
  persistState(pi, state);
  updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);

  // ---- Execute tasks ------------------------------------------------------
  if (pendingCount > 0) {
    ctx.ui.notify(`Executing ${pendingCount} pending tasks...`, "info");

    const results = await executeAllTasks(ctx, pi, plan, config, logger, {
      onTaskStart(task) {
        taskUsageStart = ledger.snapshot();
        const nextState = markTaskExecutionStarted(state, task.id);
        state.currentTaskId = nextState.currentTaskId;
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
      },
      onTaskFinish(task, result) {
        logger.logTaskUsage(task, ledger.diffSince(taskUsageStart), ledger.snapshot());
        const nextState = markTaskExecutionFinished(state, task.id, result.success);
        state.currentTaskId = nextState.currentTaskId;
        state.completedTasks = nextState.completedTasks;
        state.failedTasks = nextState.failedTasks;
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
      },
      onUsage,
    });

    const allSuccess = results.every((r) => r.success);
    if (!allSuccess) {
      ctx.ui.notify(
        `ralpix: execution stopped — ${state.failedTasks.length} task(s) failed`,
        "error",
      );
      state.phase = "idle";
      persistState(pi, state);
      updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
      return;
    }
  }

  // ---- Review pipeline ----------------------------------------------------
  state.phase = "reviewing";
  persistState(pi, state);
  updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);

  ctx.ui.notify("All tasks complete. Starting review pipeline...", "info");
  const reviewUsageStart = ledger.snapshot();

  try {
    await runReviewPipeline(ctx, pi, plan, config, logger, {
      onUsage,
      onStageStart(stage, detail) {
        reviewUsageStartById.set(stage, ledger.snapshot());
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
      },
      onStageUpdate(stage, detail) {
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
      },
      onStageFinish(stage, status, detail) {
        const stageUsageStart = reviewUsageStartById.get(stage);
        if (stageUsageStart !== undefined) {
          logger.logReviewStepUsage(stage, ledger.diffSince(stageUsageStart), ledger.snapshot());
        }
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          status,
          detail,
        );
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Review pipeline error: ${msg}`, "warning");
    logger.logReview("first", `ERROR: ${msg}`);
  }
  logger.logReviewUsage(ledger.diffSince(reviewUsageStart), ledger.snapshot());

  // ---- Complete -----------------------------------------------------------
  state.phase = "complete";
  persistState(pi, state);
  updateStatusWidget(state, ctx, ledger, taskUsageById, reviewUsageById);
  logger.logComplete();

  const { completedTasks, failedTasks } = state;
  const done = completedTasks.length;
  const failed = failedTasks.length;
  ctx.ui.notify(
    `ralpix: "${plan.title}" complete — ${done} done, ${failed} failed. Progress: ${logger.filePath}`,
    failed > 0 ? "warning" : "success",
  );

  // Move plan on completion if configured
  if (config.movePlanOnCompletion && existsSync(planPath)) {
    try {
      const { dir, base } = pathParse(planPath);
      const completedDir = pathJoin(dir, "completed");
      mkdirSync(completedDir, { recursive: true });
      renameSync(planPath, pathJoin(completedDir, base));
      ctx.ui.notify(`Plan moved to ${completedDir}/${base}`, "info");
    } catch {
      // Non-fatal — plan move is optional
    }
  }

  // Clear widget after a brief pause
  setTimeout(() => {
    ctx.ui.setWidget("ralpix", undefined);
    ctx.ui.setStatus("ralpix", undefined);
  }, 5000);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

interface WidgetUI {
  setStatus: (k: string, v: string | undefined) => void;
  setWidget: (k: string, v: string[] | undefined) => void;
  theme: { fg: (c: string, t: string) => string };
}

function updateStatusWidget(
  state: RalpixState,
  ctx: { ui: WidgetUI },
  ledger?: TokenLedger,
  taskUsageById: UsageById = new Map(),
  reviewUsageById: UsageById = new Map(),
): void {
  const { completedTasks, failedTasks, planPath } = state;

  // Try to re-parse plan for fresh task titles
  let tasks: Array<{ id: string; title: string }> = [];
  let total = completedTasks.length + failedTasks.length;
  try {
    if (existsSync(planPath)) {
      const plan = parsePlan(planPath);
      tasks = plan.tasks.map((task) => ({ id: task.id, title: task.title }));
      total = plan.tasks.length;
    }
  } catch {
    // Plan may have been moved
  }

  const totalUsage = ledger?.snapshot() ?? { input: 0, output: 0, cost: 0 };
  const view = buildStatusWidgetView(state, tasks, total, totalUsage, taskUsageById, reviewUsageById);
  ctx.ui.setStatus("ralpix", ctx.ui.theme.fg("accent", view.statusText));

  const lines = view.lines.map((line) => ctx.ui.theme.fg(line.color, line.text));

  ctx.ui.setWidget("ralpix", lines);
}
