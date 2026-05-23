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
 *
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join as pathJoin, parse as pathParse } from "node:path";

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

// Module-scope no-op function to satisfy unicorn/consistent-function-scoping
const noopFn = (): void => {
  return;
};

type UsageByModel = Map<string, UsageSummary>;
type UsageById = Map<string, UsageByModel>;

interface CurrentStepView {
  title: string;
  detail?: string;
  usageLines: string[];
}

interface ProgressStepEntry {
  title: string;
  usageSummary: UsageSummary | undefined;
  usageLines?: string[];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function spinnerFrame(): string {
  const index = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? " ";
}

function fmtElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

class RalpixProgressComponent implements PiTuiComponent {
  private readonly title: string;
  private readonly theme: PiTuiTheme;
  private currentPhase = "idle";
  private currentTitle = "";
  private currentUsage: UsageSummary | undefined;
  private totalUsage: UsageSummary = { input: 0, output: 0, cost: 0 };
  private readonly steps: ProgressStepEntry[] = [];
  private running = false;
  private currentStartTime = 0;

  constructor(title: string, theme: PiTuiTheme) {
    this.title = title;
    this.theme = theme;
  }

  setPhase(phase: string): void {
    this.currentPhase = phase;
  }

  setCurrent(title: string, usage: UsageSummary | undefined): void {
    this.currentTitle = title;
    this.currentUsage = usage;
  }

  clearCurrent(): void {
    this.currentTitle = "";
    this.currentUsage = undefined;
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (running) {
      this.currentStartTime = Date.now();
    }
  }

  setTotalUsage(usage: UsageSummary): void {
    this.totalUsage = usage;
  }

  pushStep(step: ProgressStepEntry): void {
    this.steps.push(step);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const maxWidth = Math.max(20, width);
    const border = this.theme.fg("borderAccent", "─".repeat(maxWidth));
    const bold = this.theme.bold ?? ((text: string) => text);
    const spin = this.running ? this.theme.fg("accent", spinnerFrame()) : "";
    const spinPad = this.running ? " " : "";
    lines.push(border);
    lines.push(this.fit(this.theme.fg("accent", bold(`ralpix: ${this.title}`)), maxWidth));
    lines.push(this.fit(this.theme.fg("muted", `${spin}${spinPad}Phase: ${this.currentPhase}`), maxWidth));
    lines.push(border);

    lines.push(this.fit(this.theme.fg("accent", "Steps"), maxWidth));
    const visibleSteps = this.steps.slice(-12);
    if (visibleSteps.length === 0) {
      lines.push(this.fit(this.theme.fg("dim", "No completed steps yet"), maxWidth));
    } else {
      for (const step of visibleSteps) {
        lines.push(this.fit(step.title, maxWidth));
        if (step.usageLines !== undefined && step.usageLines.length > 0) {
          for (const line of step.usageLines) {
            lines.push(this.fit(this.theme.fg("muted", line), maxWidth));
          }
        } else if (step.usageSummary !== undefined) {
          lines.push(this.fit(this.theme.fg("muted", this.formatUsage(step.usageSummary)), maxWidth));
        }
      }
    }

    lines.push(border);
    lines.push(this.fit(this.theme.fg("accent", "Now"), maxWidth));
    lines.push(...this.renderNowLines(maxWidth, spin, spinPad));

    lines.push(border);
    lines.push(this.fit(this.theme.fg("accent", "Total"), maxWidth));
    lines.push(this.fit(this.theme.fg("muted", this.formatUsage(this.totalUsage)), maxWidth));
    lines.push(border);

    return lines;
  }

  invalidate(): void {
    return;
  }

  private renderNowLines(maxWidth: number, spin: string, spinPad: string): string[] {
    const result: string[] = [];
    if (this.currentTitle.length === 0) {
      result.push(this.fit(this.theme.fg("dim", `${spin}${spinPad}Idle`), maxWidth));
    } else {
      let titleLine = this.currentTitle;
      if (this.running && this.currentStartTime > 0) {
        titleLine += ` (${fmtElapsed(Date.now() - this.currentStartTime)})`;
      }
      result.push(this.fit(`${spin}${spinPad}${titleLine}`, maxWidth));
      if (this.currentUsage !== undefined) {
        result.push(this.fit(this.theme.fg("muted", this.formatUsage(this.currentUsage)), maxWidth));
      }
    }
    return result;
  }

  private formatUsage(usage: UsageSummary): string {
    return `in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`;
  }

  private fit(text: string, width: number): string {
    const visible = this.#visibleLength(text);
    if (visible <= width) return text;
    if (width <= 3) return this.#stripAnsi(text).slice(0, width);
    return `${this.#ansiSafeSlice(text, width - 3)}...`;
  }

  /** Strip ANSI escape sequences (SGR codes like \u001B[...m). */
  #stripAnsi(s: string): string {
    return s.replaceAll(/\u001B\[[\d;]*m/gu, "");
  }

  /** Visible character count, excluding ANSI escape sequences. */
  #visibleLength(s: string): number {
    return this.#stripAnsi(s).length;
  }

  /**
   * Return the prefix of `s` whose visible length is at most `maxVisible`.
   * ANSI escape sequences are kept intact and do not count toward the limit.
   */
  #ansiSafeSlice(s: string, maxVisible: number): string {
    let out = "";
    let visible = 0;
    let i = 0;
    while (i < s.length && visible < maxVisible) {
      const start = i;
      const char = s.charAt(i);
      if (char === "\u001B" && i + 1 < s.length && s[i + 1] === "[") {
        i += 2;
        while (i < s.length && s[i] !== "m") i++;
        if (i < s.length) i++; // skip "m"
        out += s.slice(start, i);
      } else {
        out += char;
        visible++;
        i++;
      }
    }
    return out;
  }
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

  return { add, diffSince, snapshot };
}

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

function usageSummaryFor(id: string, usageById: UsageById): UsageSummary | undefined {
  const perModel = usageById.get(id);
  if (perModel === undefined) return undefined;
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const usage of perModel.values()) {
    input += usage.input;
    output += usage.output;
    cost += usage.cost;
  }
  return { input, output, cost };
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

function clearStatusWidget(ctx: { ui: WidgetUI }): void {
  ctx.ui.setWidget("ralpix", undefined);
  ctx.ui.setStatus("ralpix", undefined);
}

function reviewStageTitle(stage: ReviewStageId, detail?: string): string {
  const base = REVIEW_STAGE_LABELS[stage];
  return detail === undefined || detail.length === 0 ? base : `${base} — ${detail}`;
}

interface ProgressTuiRuntime {
  close: () => void;
  pushStep: (step: ProgressStepEntry) => void;
  refresh: () => void;
  setPhase: (phase: string) => void;
}

function createProgressTui(
  ctx: ExtensionCommandContext,
  planTitle: string,
  tasks: Array<{ id: string; title: string }>,
  ledger: ReturnType<typeof createTokenLedger>,
  taskUsageById: UsageById,
  reviewUsageById: UsageById,
  getState: () => RalpixState,
): ProgressTuiRuntime {
  clearStatusWidget(ctx);
  if (!ctx.hasUI) {
    return {
      close() {
        return;
      },
      pushStep() {
        return;
      },
      refresh() {
        return;
      },
      setPhase() {
        return;
      },
    };
  }

  const panel = new RalpixProgressComponent(planTitle, ctx.ui.theme);
  let requestRender = noopFn;
  let animInterval: ReturnType<typeof setInterval> | undefined;

  const startAnimation = (): void => {
    if (animInterval !== undefined) return;
    panel.setRunning(true);
    animInterval = setInterval(() => requestRender(), SPINNER_INTERVAL_MS);
  };

  const stopAnimation = (): void => {
    if (animInterval !== undefined) {
      clearInterval(animInterval);
      animInterval = undefined;
    }
    panel.setRunning(false);
  };

  ctx.ui.setWidget("ralpix-progress", (ui: PiTuiRuntime) => {
    requestRender = () => ui.requestRender();
    return panel;
  });

  const syncCurrent = (): void => {
    const state = getState();
    if (state.currentTaskId !== null) {
      const task = tasks.find((entry) => entry.id === state.currentTaskId);
      if (task !== undefined) {
        panel.setCurrent(task.title, usageSummaryFor(task.id, taskUsageById));
        return;
      }
    }

    const activeReviewStage = state.review?.stages.find((stage) => stage.status === "active");
    if (activeReviewStage !== undefined) {
      panel.setCurrent(
        reviewStageTitle(activeReviewStage.id, activeReviewStage.detail),
        usageSummaryFor(activeReviewStage.id, reviewUsageById),
      );
      return;
    }

    panel.clearCurrent();
  };

  return {
    close() {
      stopAnimation();
      ctx.ui.setWidget("ralpix-progress", undefined);
      requestRender = noopFn;
    },
    pushStep(step) {
      panel.pushStep(step);
    },
    refresh() {
      syncCurrent();
      panel.setTotalUsage(ledger.snapshot());
      requestRender();
    },
    setPhase(phase) {
      panel.setPhase(phase);
      if (phase === "executing" || phase === "reviewing") {
        startAnimation();
      } else {
        stopAnimation();
      }
    },
  };
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

export function buildStatusWidgetView(
  state: RalpixState,
  tasks: Array<{ id: string; title: string }>,
  total: number,
  totalUsage?: UsageSummary,
  taskUsageById: UsageById = new Map(),
  reviewUsageById: UsageById = new Map(),
): StatusWidgetView {
  const { completedTasks, phase } = state;
  const done = completedTasks.length;
  const usage = totalUsage ?? { input: 0, output: 0, cost: 0 };
  const costSuffix = usage.cost > 0 ? `  $${usage.cost.toFixed(3)}` : "";

  const lines: WidgetLine[] = [];

  const current = currentStepView(state, tasks, taskUsageById, reviewUsageById);
  if (current !== null) {
    lines.push({ color: "accent", text: "Now" });
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

function snapshotUsageById(usageById: UsageById): UsageById {
  const snap = new Map<string, Map<string, UsageSummary>>();
  for (const [id, perModel] of usageById.entries()) {
    const copy = new Map<string, UsageSummary>();
    for (const [key, usage] of perModel.entries()) {
      copy.set(key, { ...usage });
    }
    snap.set(id, copy);
  }
  return snap;
}

function diffUsageLines(id: string, before: UsageById, after: UsageById): string[] {
  const afterModels = after.get(id);
  if (afterModels === undefined) return [];
  const beforeModels = before.get(id);
  const lines: string[] = [];
  for (const [key, afterUsage] of afterModels.entries()) {
    const beforeUsage = beforeModels?.get(key);
    const input = afterUsage.input - (beforeUsage?.input ?? 0);
    const output = afterUsage.output - (beforeUsage?.output ?? 0);
    const cost = afterUsage.cost - (beforeUsage?.cost ?? 0);
    if (input > 0 || output > 0 || cost > 0) {
      lines.push(`${key}  in ${fmtTokens(input)}  out ${fmtTokens(output)}  $${cost.toFixed(3)}`);
    }
  }
  return lines;
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
    const candidate = resolve(cwd, firstToken);
    if (existsSync(candidate)) {
      const remaining = description.slice(firstToken.length).trim();
      return {
        existingPlanPath: candidate,
        description: remaining.length > 0 ? remaining : "Update the plan based on current codebase state and requirements.",
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
    await runPlan(planPath, ctx, pi);
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
  const planPath = await runPlanCreation(description, ctx, pi, config, existingPlanPath);
  if (planPath != null) {
    await runPlan(planPath, ctx, pi);
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------


export default function ralpixExtension(pi: ExtensionAPI): void {
  // ---- /ralpix command ----------------------------------------------------

  pi.registerCommand("ralpix", {
    description: "Execute a ralpix plan (/ralpix <path>, /ralpix init, /ralpix plan <desc>, /ralpix brainstorm <desc>)",
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

      // /ralpix brainstorm (exact, no description) — show usage
      if (trimmed === "brainstorm") {
        ctx.ui.notify("Usage: /ralpix brainstorm <description>", "error");
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
      if (ctx.hasUI) clearStatusWidget(ctx);
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
  const reviewUsageByIdStart = new Map<ReviewStageId, UsageById>();
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
    progressTui.refresh();
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
  const progressTui = createProgressTui(
    ctx,
    plan.title,
    plan.tasks.map((task) => ({ id: task.id, title: task.title })),
    ledger,
    taskUsageById,
    reviewUsageById,
    () => state,
  );
  progressTui.setPhase("executing");
  persistState(pi, state);
  clearStatusWidget(ctx);
  progressTui.refresh();

  // ---- Execute tasks ------------------------------------------------------
  if (pendingCount > 0) {
    ctx.ui.notify(`Executing ${pendingCount} pending tasks...`, "info");

    const results = await executeAllTasks(ctx, pi, plan, config, logger, {
      onTaskStart(task) {
        taskUsageStart = ledger.snapshot();
        const nextState = markTaskExecutionStarted(state, task.id);
        state.currentTaskId = nextState.currentTaskId;
        persistState(pi, state);
        clearStatusWidget(ctx);
        progressTui.setPhase("executing");
        progressTui.refresh();
      },
      onTaskFinish(task, result) {
        const stepUsage = ledger.diffSince(taskUsageStart);
        const totalUsage = ledger.snapshot();
        const taskUsageLines = usageLinesFor(task.id, taskUsageById);
        logger.logTaskUsage(task, stepUsage, totalUsage, taskUsageLines);
        const nextState = markTaskExecutionFinished(state, task.id, result.success);
        state.currentTaskId = nextState.currentTaskId;
        state.completedTasks = nextState.completedTasks;
        state.failedTasks = nextState.failedTasks;
        persistState(pi, state);
        clearStatusWidget(ctx);
        progressTui.pushStep({
          title: `Task ${task.number}: ${task.title}${result.success ? "" : " (failed)"}`,
          usageSummary: stepUsage,
          usageLines: taskUsageLines,
        });
        progressTui.refresh();
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
      clearStatusWidget(ctx);
      progressTui.setPhase("idle");
      progressTui.refresh();
      return;
    }
  }

  // ---- Review pipeline ----------------------------------------------------
  state.phase = "reviewing";
  persistState(pi, state);
  clearStatusWidget(ctx);
  progressTui.setPhase("reviewing");
  progressTui.refresh();

  ctx.ui.notify("All tasks complete. Starting review pipeline...", "info");
  const reviewUsageStart = ledger.snapshot();

  try {
    await runReviewPipeline(ctx, pi, plan, config, logger, {
      onUsage,
      onStageStart(stage, detail) {
        reviewUsageStartById.set(stage, ledger.snapshot());
        reviewUsageByIdStart.set(stage, snapshotUsageById(reviewUsageById));
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        clearStatusWidget(ctx);
        progressTui.setPhase("reviewing");
        progressTui.refresh();
      },
      onStageUpdate(stage, detail) {
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          "active",
          detail,
        );
        persistState(pi, state);
        clearStatusWidget(ctx);
        progressTui.refresh();
      },
      onStageFinish(stage, status, detail) {
        const stageUsageStart = reviewUsageStartById.get(stage);
        const totalUsage = ledger.snapshot();
        const stepUsage = stageUsageStart === undefined ? undefined : ledger.diffSince(stageUsageStart);
        const stageUsageStartById = reviewUsageByIdStart.get(stage) ??
          new Map<string, Map<string, UsageSummary>>();
        const stageUsageLines = diffUsageLines(stage, stageUsageStartById, reviewUsageById);
        if (stepUsage !== undefined) {
          logger.logReviewStepUsage(stage, stepUsage, totalUsage, stageUsageLines);
        }
        state.review = updateReviewStage(
          state.review ?? createInitialReviewState(config.externalReviewEnabled),
          stage,
          status,
          detail,
        );
        persistState(pi, state);
        clearStatusWidget(ctx);
        const statusSuffix = status === "failed" ? " (failed)" : "";
        const detailSuffix = detail === undefined ? "" : ` — ${detail}`;
        progressTui.pushStep({
          title: `${REVIEW_STAGE_LABELS[stage]}${statusSuffix}${detailSuffix}`,
          usageSummary: stepUsage,
          ...(stageUsageLines.length > 0 ? { usageLines: stageUsageLines } : {}),
        });
        progressTui.refresh();
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
  clearStatusWidget(ctx);
  logger.logComplete();
  progressTui.setPhase("complete");
  progressTui.refresh();

  const { completedTasks, failedTasks } = state;
  const done = completedTasks.length;
  const failed = failedTasks.length;
  ctx.ui.notify(
    `ralpix: "${plan.title}" complete — ${done} done, ${failed} failed. Progress: ${logger.filePath}`,
    failed > 0 ? "warning" : "success",
  );

  // Move completed plan to docs/plans/completed/
  if (existsSync(planPath)) {
    try {
      const { dir, base } = pathParse(planPath);
      const completedDir = pathJoin(dir, "completed");
      mkdirSync(completedDir, { recursive: true });
      renameSync(planPath, pathJoin(completedDir, base));
      ctx.ui.notify(`Plan moved to ${completedDir}/${base}`, "info");
    } catch {
      // Non-fatal — plan move is best-effort
    }
  }

  // Keep the progress TUI visible so the full report remains on screen
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

interface WidgetUI {
  setStatus: (k: string, v: string | undefined) => void;
  setWidget: (k: string, v: string[] | ((ui: PiTuiRuntime, theme: PiTuiTheme) => PiTuiComponent) | undefined) => void;
}
