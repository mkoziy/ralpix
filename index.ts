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
import { ProgressLogger } from "./logger.js";
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

// ---------------------------------------------------------------------------
// Token ledger
// ---------------------------------------------------------------------------

interface LedgerEntry {
  input: number;
  output: number;
  cost: number;
}

function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function createTokenLedger() {
  const map = new Map<string, LedgerEntry>();

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

  function rows(theme: WidgetUI["theme"]): string[] {
    if (map.size === 0) return [];
    const out: string[] = [theme.fg("muted", "── tokens ──────────────────")];
    let totalIn = 0;
    let totalOut = 0;
    let totalC = 0;
    let hasCost = false;

    for (const [key, e] of map.entries()) {
      totalIn += e.input;
      totalOut += e.output;
      totalC += e.cost;
      if (e.cost > 0) hasCost = true;

      const label = key.length > 22 ? `…${key.slice(-21)}` : key;
      const costStr = e.cost > 0 ? `  $${e.cost.toFixed(3)}` : "";
      out.push(theme.fg("muted", `${label.padEnd(22)} ↑${fmtTokens(e.input)} ↓${fmtTokens(e.output)}${costStr}`));
    }

    if (map.size > 1) {
      const totalCostStr = hasCost ? `  $${totalC.toFixed(3)}` : "";
      out.push(theme.fg("muted", `${"Total".padEnd(22)} ↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}${totalCostStr}`));
    }

    return out;
  }

  return { add, totalCost, rows };
}

type TokenLedger = ReturnType<typeof createTokenLedger>;

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
  const suffix = stage.detail === undefined || stage.detail.length === 0 ? "" : ` — ${stage.detail}`;

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

export function buildStatusWidgetView(
  state: RalpixState,
  tasks: Array<{ id: string; title: string }>,
  total: number,
  totalCost = 0,
): StatusWidgetView {
  const { completedTasks, currentTaskId, failedTasks, planTitle, phase, review } = state;
  const done = completedTasks.length;
  const costSuffix = totalCost > 0 ? `  $${totalCost.toFixed(3)}` : "";

  const lines: WidgetLine[] = [
    { color: "accent", text: `Plan: ${planTitle}` },
    { color: "muted", text: `Phase: ${phase} | ${done}/${total} tasks` },
  ];

  for (const task of tasks) {
    if (completedTasks.includes(task.id)) {
      lines.push({ color: "success", text: `✓ ${task.title}` });
    } else if (failedTasks.includes(task.id)) {
      lines.push({ color: "error", text: `✗ ${task.title}` });
    } else if (currentTaskId === task.id) {
      lines.push({ color: "accent", text: `▶ ${task.title}` });
    } else {
      lines.push({ color: "muted", text: `○ ${task.title}` });
    }
  }

  if (review !== undefined) {
    lines.push({ color: "muted", text: "" });
    lines.push({ color: "accent", text: "Review" });
    for (const stage of review.stages) {
      lines.push(formatReviewStageLine(stage));
    }
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
  const onUsage = (provider: string, model: string, usage: SubprocessUsage): void => {
    ledger.add(provider, model, usage);
    updateStatusWidget(state, ctx, ledger);
  };

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
  updateStatusWidget(state, ctx, ledger);

  // ---- Execute tasks ------------------------------------------------------
  if (pendingCount > 0) {
    ctx.ui.notify(`Executing ${pendingCount} pending tasks...`, "info");

    const results = await executeAllTasks(ctx, pi, plan, config, logger, {
      onTaskStart(task) {
        const nextState = markTaskExecutionStarted(state, task.id);
        state.currentTaskId = nextState.currentTaskId;
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger);
      },
      onTaskFinish(task, result) {
        const nextState = markTaskExecutionFinished(state, task.id, result.success);
        state.currentTaskId = nextState.currentTaskId;
        state.completedTasks = nextState.completedTasks;
        state.failedTasks = nextState.failedTasks;
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger);
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
      updateStatusWidget(state, ctx, ledger);
      return;
    }
  }

  // ---- Review pipeline ----------------------------------------------------
  state.phase = "reviewing";
  persistState(pi, state);
  updateStatusWidget(state, ctx, ledger);

  ctx.ui.notify("All tasks complete. Starting review pipeline...", "info");

  try {
    await runReviewPipeline(ctx, pi, plan, config, logger, {
      onUsage,
      onStageStart(stage, detail) {
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger);
      },
      onStageUpdate(stage, detail) {
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger);
      },
      onStageFinish(stage, status, detail) {
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          status,
          detail,
        );
        persistState(pi, state);
        updateStatusWidget(state, ctx, ledger);
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Review pipeline error: ${msg}`, "warning");
    logger.logReview("first", `ERROR: ${msg}`);
  }

  // ---- Complete -----------------------------------------------------------
  state.phase = "complete";
  persistState(pi, state);
  updateStatusWidget(state, ctx, ledger);
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

  const cost = ledger?.totalCost() ?? 0;
  const view = buildStatusWidgetView(state, tasks, total, cost);
  ctx.ui.setStatus("ralpix", ctx.ui.theme.fg("accent", view.statusText));

  const lines = view.lines.map((line) => ctx.ui.theme.fg(line.color, line.text));

  if (ledger !== undefined) {
    for (const row of ledger.rows(ctx.ui.theme)) {
      lines.push(row);
    }
  }

  ctx.ui.setWidget("ralpix", lines);
}
