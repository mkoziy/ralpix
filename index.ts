/**
 * ralpix — Autonomous Plan Execution Extension for pi
 *
 * Reads ralpix-format markdown plans and executes tasks hands-off.
 * Each task runs in an isolated pi process (spawn) to keep context sharp.
 *
 * Commands:
 *   /ralpix plan <desc>  — Create a plan interactively
 *   /ralpix init          — Initialise ~/.ralpix/ with defaults
 *   /ralpix review        — Review branch or uncommitted changes
 *   /ralpix <path>        — Execute a plan
 *
 *
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join as pathJoin, parse as pathParse, basename as pathBasename } from "node:path";

import { initRalpixHome, loadConfig, ralpixHomeDir } from "./config.js";
import { createEventBus, createLogWriterEmitter, formatTotalUsageText } from "./event-bus.js";
import { executeAllTasks } from "./executor.js";
import {
  LogWriter,
  fmtTokens,
  formatUsageBreakdownLines,
  formatUsageSummary,
  migrateProgressFiles,
  summarizeUsageSnapshot,
  usageToData,
  type UsageBreakdownEntry,
  type UsageSnapshot,
  type UsageSummary,
} from "./logger.js";
import { parsePlan } from "./parser.js";
import { runExistingPlanMenu, runPlanCreation } from "./planner.js";
import { runReviewPipeline, runStandaloneReview } from "./reviewer.js";
import { createTokenLedger } from "./tui.js";

import type {
  RalpixState,
  ReviewPipelineState,
  ReviewStageId,
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

type UsageByModel = Map<string, UsageBreakdownEntry>;
type UsageById = Map<string, UsageByModel>;

interface WidgetLine {
  color: string;
  text: string;
}

interface StatusWidgetView {
  statusText: string;
  lines: WidgetLine[];
}

function recordUsage(
  usageById: UsageById,
  id: string,
  provider: string,
  model: string,
  usage: SubprocessUsage,
): void {
  const key = `${provider}/${model}`;
  const perModel = usageById.get(id) ?? new Map<string, UsageBreakdownEntry>();
  const previous = perModel.get(key) ?? { provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  perModel.set(key, {
    provider,
    model,
    input: previous.input + usage.input,
    output: previous.output + usage.output,
    cacheRead: previous.cacheRead + usage.cacheRead,
    cacheWrite: previous.cacheWrite + usage.cacheWrite,
    cost: previous.cost + usage.cost,
  });
  usageById.set(id, perModel);
}

function usageBreakdownFor(id: string, usageById: UsageById): UsageBreakdownEntry[] {
  const perModel = usageById.get(id);
  if (perModel === undefined) return [];
  return [...perModel.values()].map((entry) => ({ ...entry }));
}

function usageLinesFor(id: string, usageById: UsageById): string[] {
  const perModel = usageById.get(id);
  if (perModel === undefined) return [];
  return formatUsageBreakdownLines([...perModel.values()]);
}

const REVIEW_STAGE_LABELS: Record<ReviewStageId, string> = {
  "first-pass": "Comprehensive review",
  "external-review": "External audit",
  "external-eval": "Resolve findings",
  "second-pass": "Quality & fix loop",
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

function snapshotUsageById(usageById: UsageById): UsageById {
  const snap = new Map<string, Map<string, UsageBreakdownEntry>>();
  for (const [id, perModel] of usageById.entries()) {
    const copy = new Map<string, UsageBreakdownEntry>();
    for (const [key, usage] of perModel.entries()) {
      copy.set(key, { ...usage });
    }
    snap.set(id, copy);
  }
  return snap;
}

function diffUsageBreakdown(id: string, before: UsageById, after: UsageById): UsageBreakdownEntry[] {
  const afterModels = after.get(id);
  if (afterModels === undefined) return [];
  const beforeModels = before.get(id);
  const entries: UsageBreakdownEntry[] = [];
  for (const [key, afterUsage] of afterModels.entries()) {
    const beforeUsage = beforeModels?.get(key);
    const entry = {
      provider: afterUsage.provider,
      model: afterUsage.model,
      input: afterUsage.input - (beforeUsage?.input ?? 0),
      output: afterUsage.output - (beforeUsage?.output ?? 0),
      cacheRead: afterUsage.cacheRead - (beforeUsage?.cacheRead ?? 0),
      cacheWrite: afterUsage.cacheWrite - (beforeUsage?.cacheWrite ?? 0),
      cost: afterUsage.cost - (beforeUsage?.cost ?? 0),
    };
    if (
      entry.input > 0 ||
      entry.output > 0 ||
      entry.cacheRead > 0 ||
      entry.cacheWrite > 0 ||
      entry.cost > 0
    ) {
      entries.push(entry);
    }
  }
  return entries;
}

export function buildStatusWidgetView(
  state: RalpixState,
  tasks: Array<{ id: string; title: string }>,
  total: number,
  totalUsage?: UsageSummary,
  taskUsageById: UsageById = new Map(),
  reviewUsageById: UsageById = new Map(),
): StatusWidgetView {
  const { completedTasks, currentTaskId, phase, review } = state;
  const done = completedTasks.length;
  const usage = totalUsage ?? { input: 0, output: 0, cost: 0 };
  const costSuffix = usage.cost > 0 ? `  $${usage.cost.toFixed(3)}` : "";
  const lines: WidgetLine[] = [];

  const currentTask = currentTaskId == null ? undefined : tasks.find((entry) => entry.id === currentTaskId);
  const activeReviewStage = review?.stages.find((stage) => stage.status === "active");
  if (currentTask !== undefined) {
    lines.push({ color: "accent", text: "Now" });
    lines.push({ color: "accent", text: currentTask.title });
    for (const usageLine of usageLinesFor(currentTask.id, taskUsageById)) {
      lines.push({ color: "muted", text: usageLine });
    }
  } else if (activeReviewStage !== undefined) {
    lines.push({ color: "accent", text: "Now" });
    const detail = activeReviewStage.detail == null || activeReviewStage.detail.length === 0
      ? REVIEW_STAGE_LABELS[activeReviewStage.id]
      : `${REVIEW_STAGE_LABELS[activeReviewStage.id]} — ${activeReviewStage.detail}`;
    lines.push({ color: "accent", text: detail });
    for (const usageLine of usageLinesFor(activeReviewStage.id, reviewUsageById)) {
      lines.push({ color: "muted", text: usageLine });
    }
  }

  if (usage.input > 0 || usage.output > 0 || usage.cost > 0) {
    if (lines.length > 0) lines.push({ color: "muted", text: "" });
    lines.push({ color: "accent", text: "Total" });
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

function detectExistingPlan(description: string, cwd: string): { existingPlanPath?: string; description: string } {
  const firstToken = description.split(/\s+/)[0];
  if (firstToken?.endsWith(".md") === true) {
    const normalizedToken = firstToken.startsWith("@") ? firstToken.slice(1) : firstToken;
    const candidate = resolve(cwd, normalizedToken);
    if (existsSync(candidate)) {
      const remaining = description.slice(firstToken.length).trim();
      return {
        existingPlanPath: candidate,
        description: remaining,
      };
    }
  }
  return { description };
}

async function handleBrainstormSubcommand(
  description: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!existsSync(ralpixHomeDir())) {
    ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
    initRalpixHome();
  }

  const config = loadConfig(ctx.cwd);
  const { runBrainstorm } = await import("./brainstorm.js");
  const result = await runBrainstorm(description, ctx, pi, config);

  if (result == null) return;

  const createPlan = await ctx.ui.confirm(
    "Create plan now?",
    "Use the brainstorm results to generate an implementation plan?",
  );
  if (createPlan !== true) return;

  const planPath = await runPlanCreation(description, ctx, pi, config, undefined, result);
  if (planPath != null) {
    const displayPath = planPath.startsWith(ctx.cwd + "/") ? planPath.slice(ctx.cwd.length + 1) : planPath;
    ctx.ui.notify(`Plan saved to ${displayPath}. Run it later with: /ralpix ${displayPath}`, "success");
  }
}

async function handlePlanSubcommand(
  trimmed: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (existsSync(resolve(ctx.cwd, trimmed))) {
    await runPlan(trimmed, ctx, pi);
    return;
  }

  let description = trimmed.slice(5).trim();
  if (description.length === 0) {
    ctx.ui.notify("Usage: /ralpix plan <description>", "error");
    return;
  }

  const planQuery = detectExistingPlan(description, ctx.cwd);
  description = planQuery.description;
  const existingPlanPath = planQuery.existingPlanPath;

  if (!existsSync(ralpixHomeDir())) {
    ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
    initRalpixHome();
  }

  const config = loadConfig(ctx.cwd);
  if (existingPlanPath !== undefined && description.length === 0) {
    const selectedPlanPath = await runExistingPlanMenu(existingPlanPath, ctx, config);
    if (selectedPlanPath != null) {
      await runPlan(selectedPlanPath, ctx, pi);
    }
    return;
  }
  const planPath = await runPlanCreation(description, ctx, pi, config, existingPlanPath);
  if (planPath != null) {
    await runPlan(planPath, ctx, pi);
  }
}

// ---------------------------------------------------------------------------
// Review handler
// ---------------------------------------------------------------------------

async function handleReviewSubcommand(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const currentBranch = (() => {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", { cwd: ctx.cwd, encoding: "utf-8", stdio: "pipe" }).trim();
    } catch {
      return null;
    }
  })();

  if (currentBranch === null) {
    ctx.ui.notify("Not a git repository — review requires a git repo", "error");
    return;
  }

  const reviewTargetRaw = await ctx.ui.select("What to review?", [
    "Branch changes (vs main/master)",
    "Uncommitted changes",
    "Both",
  ]);

  if (reviewTargetRaw == null) {
    ctx.ui.notify("Review cancelled", "info");
    return;
  }

  const targetMap: Record<string, "branch" | "uncommitted" | "both"> = {
    "Branch changes (vs main/master)": "branch",
    "Uncommitted changes": "uncommitted",
    Both: "both",
  };
  const reviewTarget = targetMap[reviewTargetRaw] ?? "branch";

  const modeChoice = await ctx.ui.select("Review mode?", [
    "Review only — report findings, no fixes",
    "Review and fix — apply fixes for issues found",
  ]);

  if (modeChoice == null) {
    ctx.ui.notify("Review cancelled", "info");
    return;
  }

  const reviewOnly = modeChoice === "Review only — report findings, no fixes";

  if (!existsSync(ralpixHomeDir())) {
    ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
    initRalpixHome();
  }

  const config = loadConfig(ctx.cwd);
  await runStandaloneReview(ctx, pi, config, reviewTarget, reviewOnly);
}

// ---------------------------------------------------------------------------
// Init handler
// ---------------------------------------------------------------------------

async function handleInitCommand(ctx: ExtensionCommandContext): Promise<void> {
  const homeExists = existsSync(ralpixHomeDir());
  let overwrite = false;
  if (homeExists) {
    const rewrite = await ctx.ui.confirm(
      "Re-initialize ralpix?",
      "~/.ralpix/ already exists. Overwrite existing files with bundled defaults?",
    );
    overwrite = rewrite === true;
  } else {
    const ok = await ctx.ui.confirm(
      "Initialize ralpix?",
      "Create ~/.ralpix/ with default prompts, agents, and config?",
    );
    if (ok !== true) return;
  }
  const result = initRalpixHome(overwrite);
  const parts: string[] = [];
  if (result.created.length > 0) parts.push(`${String(result.created.length)} created`);
  if (result.overwritten.length > 0) parts.push(`${String(result.overwritten.length)} overwritten`);
  if (result.skipped.length > 0) parts.push(`${String(result.skipped.length)} skipped`);
  const summary = parts.length > 0 ? parts.join(", ") : "no changes";
  ctx.ui.notify(`ralpix initialized — ${summary}`, "success");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------


export default function ralpixExtension(pi: ExtensionAPI): void {
  // ---- /ralpix command ----------------------------------------------------

  pi.registerCommand("ralpix", {
    description: "Execute a ralpix plan (/ralpix <path>, /ralpix init, /ralpix plan <desc>, /ralpix brainstorm <desc>, /ralpix review)",
    handler: async (args, ctx) => withRalpixErrorHandling(async () => {
      const trimmed = typeof args === "string" ? args.trim() : "";

      // ── Subcommands first (always accessible regardless of filesystem) ──

      // /ralpix (empty) or /ralpix init
      if (trimmed.length === 0 || trimmed === "init") {
        await handleInitCommand(ctx);
        return;
      }

      // /ralpix plan (exact, no description) — show usage
      if (trimmed === "plan") {
        ctx.ui.notify("Usage: /ralpix plan <description>", "error");
        return;
      }

      // /ralpix brainstorm (exact, no description) — show usage
      if (trimmed === "brainstorm") {
        ctx.ui.notify("Usage: /ralpix brainstorm <description>", "error");
        return;
      }

      // /ralpix review — show usage or run interactive
      if (trimmed === "review") {
        await handleReviewSubcommand(ctx, pi);
        return;
      }

      // ── /ralpix brainstorm <description> ────────────────────────
      if (trimmed.startsWith("brainstorm ")) {
        const description = trimmed.slice(11).trim();
        if (description.length === 0) {
          ctx.ui.notify("Usage: /ralpix brainstorm <description>", "error");
          return;
        }
        await handleBrainstormSubcommand(description, ctx, pi);
        return;
      }

      // ── /ralpix plan <description> ──────────────────────────────
      if (trimmed.startsWith("plan ")) {
        await handlePlanSubcommand(trimmed, ctx, pi);
        return;
      }

      // ── /ralpix review (with args, currently ignored) ───────────
      if (trimmed.startsWith("review ")) {
        await handleReviewSubcommand(ctx, pi);
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
    }
  });
}

// ---------------------------------------------------------------------------
// Branch guardrail helpers
// ---------------------------------------------------------------------------

function getCurrentBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\d\sa-z-]+/g, "")
    .trim()
    .replaceAll(/\s+/g, "-")
    .slice(0, 50);
}

function suggestBranchName(planTitle: string): string {
  const slug = slugify(planTitle);
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `ralpix/${date}-${slug}`;
}

async function maybeSwitchBranch(
  ctx: ExtensionCommandContext,
  planTitle: string,
): Promise<void> {
  const current = getCurrentBranch(ctx.cwd);
  if (current !== "main" && current !== "master") {
    return;
  }

  const branchName = suggestBranchName(planTitle);
  const shouldCreate = await ctx.ui.confirm(
    "Create branch?",
    `You are on \`${current}\`. Create branch \`${branchName}\` to work on this plan?`,
  );

  if (shouldCreate === true) {
    try {
      execSync(`git checkout -b ${branchName}`, { cwd: ctx.cwd, encoding: "utf-8", stdio: "pipe" });
      ctx.ui.notify(`Switched to branch ${branchName}`, "success");
    } catch {
      ctx.ui.notify(`Failed to create branch ${branchName}. Continuing on ${current}.`, "warning");
    }
  }
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

  migrateProgressFiles(ctx.cwd);

  if (!existsSync(ralpixHomeDir())) {
    ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
    initRalpixHome();
  }

  const config = loadConfig(ctx.cwd);
  const plan = parsePlan(planPath);
  const executeEmitters: import("./events.js").AgentEventEmitter[] = [];
  const session = createEventBus(ctx, "execute", executeEmitters);

  await maybeSwitchBranch(ctx, plan.title);

  const pendingCount = plan.tasks.filter((t) => t.status === "pending").length;
  session.message("info", `"${plan.title}" - ${plan.tasks.length} tasks, ${pendingCount} pending`);

  // Setup progress loggers — one per phase, each writes to .ralpix/progress/{phase}/
  const fileName = planPath.split("/").pop() ?? "plan";
  const planStem = fileName.replace(/\.md$/, "");
  const executeLogger = new LogWriter(ctx.cwd, "execute", planStem);
  const reviewLogger = new LogWriter(ctx.cwd, "review", planStem);
  executeEmitters.push(createLogWriterEmitter(executeLogger));
  executeLogger.write("start", { planTitle: plan.title, planPath: plan.path, taskCount: plan.tasks.length });

  // Token ledger — accumulates usage across all subprocess calls
  const ledger = createTokenLedger();
  const taskUsageById: UsageById = new Map();
  const reviewUsageById: UsageById = new Map();
  const reviewUsageStartById = new Map<ReviewStageId, UsageSnapshot>();
  const reviewUsageByIdStart = new Map<ReviewStageId, UsageById>();
  const onUsage = (provider: string, model: string, usage: SubprocessUsage): void => {
    ledger.add(provider, model, usage);
    session.usage(formatTotalUsageText(ledger.snapshot()));
    if (state.currentTaskId === null) {
      const activeReviewStage = state.review?.stages.find((stage) => stage.status === "active");
      if (activeReviewStage !== undefined) {
        recordUsage(reviewUsageById, activeReviewStage.id, provider, model, usage);
      }
    } else {
      recordUsage(taskUsageById, state.currentTaskId, provider, model, usage);
    }
  };
  let taskUsageStart = ledger.detailedSnapshot();

  // Initial state
  const state: RalpixState = {
    planPath,
    planTitle: plan.title,
    currentTaskId: null,
    phase: "executing",
    completedTasks: plan.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    failedTasks: plan.tasks.filter((t) => t.status === "failed").map((t) => t.id),
    progressFile: executeLogger.filePath,
    review: createInitialReviewState(config.externalReviewEnabled),
  };
  persistState(pi, state);
  session.status("running", "Executing plan...");

  // ---- Execute tasks ------------------------------------------------------
  if (pendingCount > 0) {
    session.message("info", `Executing ${pendingCount} pending tasks...`);

    const results = await executeAllTasks(ctx, pi, plan, config, {
      session,
      onTaskStart(task) {
        taskUsageStart = ledger.detailedSnapshot();
        const nextState = markTaskExecutionStarted(state, task.id);
        state.currentTaskId = nextState.currentTaskId;
        persistState(pi, state);
        session.status("running", `Task ${task.number}: ${task.title}`);
      },
      onTaskFinish(task, result) {
        const stepUsage = ledger.diffDetailedSince(taskUsageStart);
        const totalUsage = ledger.detailedSnapshot();
        const taskUsageBreakdown = usageBreakdownFor(task.id, taskUsageById);
        const taskUsageLines = formatUsageBreakdownLines(taskUsageBreakdown);
        executeLogger.write("task_usage", { taskId: task.id, taskNumber: task.number, taskTitle: task.title, usage: usageToData(stepUsage, totalUsage, taskUsageBreakdown), summary: formatUsageSummary(summarizeUsageSnapshot(stepUsage), summarizeUsageSnapshot(totalUsage)) });
        const nextState = markTaskExecutionFinished(state, task.id, result.success);
        state.currentTaskId = nextState.currentTaskId;
        state.completedTasks = nextState.completedTasks;
        state.failedTasks = nextState.failedTasks;
        persistState(pi, state);
        const outcome = result.success ? "success" : "warning";
        session.message(outcome, `Task ${task.number}: ${task.title}${result.success ? "" : " (failed)"}`);
        if (taskUsageLines.length > 0) {
          session.message("result", taskUsageLines.join("\n"));
        }
      },
      onUsage,
    });

    const allSuccess = results.every((r) => r.success);
    if (!allSuccess) {
      session.message("error", `Execution stopped - ${state.failedTasks.length} task(s) failed`);
      state.phase = "idle";
      persistState(pi, state);
      session.close();
      return;
    }
  }

  // ---- Review pipeline ----------------------------------------------------
  state.phase = "reviewing";
  persistState(pi, state);
  session.phase("review");
  session.status("reviewing", "Starting review pipeline...");

  session.message("info", "All tasks complete. Starting review pipeline...");
  const reviewUsageStart = ledger.detailedSnapshot();

  try {
    await runReviewPipeline(ctx, pi, plan, config, reviewLogger, {
      onUsage,
      onStageStart(stage, detail) {
        reviewUsageStartById.set(stage, ledger.detailedSnapshot());
        reviewUsageByIdStart.set(stage, snapshotUsageById(reviewUsageById));
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        const stageText = detail == null ? REVIEW_STAGE_LABELS[stage] : `${REVIEW_STAGE_LABELS[stage]} - ${detail}`;
        session.status("reviewing", stageText);
        session.message("info", stageText);
      },
      onStageUpdate(stage, detail) {
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        session.status("reviewing", `${REVIEW_STAGE_LABELS[stage]} - ${detail}`);
      },
      onStageFinish(stage, status, detail) {
        const stageUsageStart = reviewUsageStartById.get(stage);
        const totalUsage = ledger.detailedSnapshot();
        const stepUsage = stageUsageStart === undefined ? undefined : ledger.diffDetailedSince(stageUsageStart);
        const stageUsageStartById = reviewUsageByIdStart.get(stage) ??
          new Map<string, Map<string, UsageBreakdownEntry>>();
        const stageUsageBreakdown = diffUsageBreakdown(stage, stageUsageStartById, reviewUsageById);
        const stageUsageLines = formatUsageBreakdownLines(stageUsageBreakdown);
        if (stepUsage !== undefined) {
          reviewLogger.write("stage_usage", { stage, stageLabel: REVIEW_STAGE_LABELS[stage], usage: usageToData(stepUsage, totalUsage, stageUsageBreakdown), summary: formatUsageSummary(summarizeUsageSnapshot(stepUsage), summarizeUsageSnapshot(totalUsage)) });
        }
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          status,
          detail,
        );
        persistState(pi, state);
        const statusSuffix = status === "failed" ? " (failed)" : "";
        const detailSuffix = detail === undefined ? "" : ` - ${detail}`;
        session.message(status === "failed" ? "warning" : "result", `${REVIEW_STAGE_LABELS[stage]}${statusSuffix}${detailSuffix}`);
        if (stageUsageLines.length > 0) {
          session.message("result", stageUsageLines.join("\n"));
        }
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    session.message("warning", `Review pipeline error: ${msg}`);
    reviewLogger.write("complete", { status: "failed", error: msg });
  }
  const reviewStepUsage = ledger.diffDetailedSince(reviewUsageStart);
  const reviewTotalUsage = ledger.detailedSnapshot();
  reviewLogger.write("usage", { usage: usageToData(reviewStepUsage, reviewTotalUsage), summary: formatUsageSummary(summarizeUsageSnapshot(reviewStepUsage), summarizeUsageSnapshot(reviewTotalUsage)) });

  // ---- Complete -----------------------------------------------------------
  state.phase = "complete";
  persistState(pi, state);
  executeLogger.write("complete", {});
  session.status("complete", "Plan complete");

  const { completedTasks, failedTasks } = state;
  const done = completedTasks.length;
  const failed = failedTasks.length;
  session.message(
    failed > 0 ? "warning" : "success",
    `"${plan.title}" complete - ${done} done, ${failed} failed. Progress: ${executeLogger.filePath}`,
  );

  // Move completed plan to docs/plans/completed/
  if (existsSync(planPath)) {
    try {
      const { dir, base } = pathParse(planPath);
      if (pathBasename(dir) === "completed") {
        session.message("info", "Plan already in completed/ directory");
      } else {
        const completedDir = pathJoin(dir, "completed");
        mkdirSync(completedDir, { recursive: true });
        renameSync(planPath, pathJoin(completedDir, base));
        session.message("info", `Plan moved to ${completedDir}/${base}`);
      }
    } catch {
      // Non-fatal — plan move is best-effort
    }
  }
  session.close();
}
