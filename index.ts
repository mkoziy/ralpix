import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import { createTuiEmitter } from "./adapters/tui.js";
import { runBrainstorm } from "./brainstorm.js";
import { initRalpixHome, loadConfig, resolvePiAgentDir } from "./config.js";
import { createEventBus } from "./event-bus.js";
import { executeAllTasks } from "./executor.js";
import { createLogWriterEmitter, LogWriter, progressDirForPhase } from "./logger.js";
import { loadPlan } from "./parser.js";
import { runPlanCreation } from "./planner.js";
import { runReviewPipeline, runStandaloneReview } from "./reviewer.js";

import type { RunSession } from "./event-bus.js";
import type { Phase, Plan, RalpixConfig, RalpixState } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const STATE_FILE = join(".ralpix", "ralpix-state.json");
const LEGACY_PROGRESS_DIR = join(".ralpix", "progress");
const MAIN_BRANCHES = new Set(["main", "master"]);

export interface PhaseRun {
  close: () => void;
  progressFilePath: string;
  session: RunSession;
  sessionName: string;
}

export interface IndexDependencies {
  now?: () => Date;
  loadConfig?: typeof loadConfig;
  resolvePiAgentDir?: typeof resolvePiAgentDir;
  initRalpixHome?: typeof initRalpixHome;
  runBrainstorm?: typeof runBrainstorm;
  runPlanCreation?: typeof runPlanCreation;
  executeAllTasks?: typeof executeAllTasks;
  runReviewPipeline?: typeof runReviewPipeline;
  runStandaloneReview?: typeof runStandaloneReview;
  loadPlan?: typeof loadPlan;
  getCurrentBranch?: (cwd: string) => string | null;
  createBranch?: (cwd: string, branchName: string) => void;
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "success" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }

  const line = `[ralpix] ${message}\n`;
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

function usage(): string {
  return "Usage: /ralpix init | /ralpix brainstorm <description> | /ralpix plan <description> | /ralpix execute <plan-path> | /ralpix review | /ralpix <plan-path>";
}

function loadRunConfig(
  ctx: ExtensionCommandContext,
  dependencies: IndexDependencies,
): RalpixConfig {
  const load = dependencies.loadConfig ?? loadConfig;
  const resolveAgentDir = dependencies.resolvePiAgentDir ?? resolvePiAgentDir;
  const loaded = load(ctx.cwd);
  return {
    ...loaded,
    piAgentDir: resolveAgentDir(ctx.cwd, loaded),
  };
}

function timestamp(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "run";
}

function inferEventPhase(eventType: string): Phase | "unknown" {
  if (
    eventType === "question" ||
    eventType === "answer" ||
    eventType === "approach_selected" ||
    eventType === "section_validated" ||
    eventType === "round_start" ||
    eventType === "round_end"
  ) {
    return "brainstorm";
  }
  if (
    eventType === "draft_generated" ||
    eventType === "review_result" ||
    eventType === "critic_start" ||
    eventType === "critic_end" ||
    eventType === "ai_review_start" ||
    eventType === "ai_review_end" ||
    eventType === "human_review"
  ) {
    return "plan";
  }
  if (eventType === "task_start" || eventType === "attempt_start" || eventType === "attempt_end" || eventType === "task_end") {
    return "execute";
  }
  if (
    eventType === "stage_start" ||
    eventType === "stage_update" ||
    eventType === "stage_finish" ||
    eventType === "iteration_start" ||
    eventType === "iteration_end" ||
    eventType === "eval_iteration_start" ||
    eventType === "eval_iteration_end"
  ) {
    return "review";
  }
  return "unknown";
}

export function inferProgressLogPhase(filePath: string): Phase | "unknown" {
  const seen = new Set<Phase | "unknown">();
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { phase?: string; type?: string };
      if (
        parsed.phase === "brainstorm" ||
        parsed.phase === "plan" ||
        parsed.phase === "execute" ||
        parsed.phase === "review"
      ) {
        seen.add(parsed.phase);
        continue;
      }

      if (typeof parsed.type === "string") {
        seen.add(inferEventPhase(parsed.type));
      } else {
        seen.add("unknown");
      }
    } catch {
      seen.add("unknown");
    }
  }

  if (seen.size !== 1) return "unknown";
  return [...seen][0] ?? "unknown";
}

export function migrateLegacyProgressLogs(cwd: string): string[] {
  const progressRoot = join(cwd, LEGACY_PROGRESS_DIR);
  if (!existsSync(progressRoot)) return [];

  const moved: string[] = [];
  const legacyFiles = readdirSync(progressRoot)
    .map((name) => join(progressRoot, name))
    .filter((filePath) => filePath.endsWith(".jsonl"))
    .filter((filePath) => statSync(filePath).isFile());

  if (legacyFiles.length === 0) return [];

  process.stderr.write("[ralpix] migrated legacy progress logs to per-phase directories\n");

  for (const filePath of legacyFiles) {
    const phase = inferProgressLogPhase(filePath);
    const targetDir = phase === "unknown" ? join(progressRoot, "unknown") : progressDirForPhase(cwd, phase);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, basename(filePath));
    renameSync(filePath, targetPath);
    moved.push(targetPath);
  }

  return moved;
}

function stateFilePath(cwd: string): string {
  return join(cwd, STATE_FILE);
}

function resolveStateProgressFile(cwd: string, state: RalpixState): string {
  if (state.progressFile.length > 0 && existsSync(state.progressFile)) {
    return state.progressFile;
  }

  const phase = state.phase === "reviewing" ? "review" : "execute";
  const fileName = basename(state.progressFile);
  const candidates = [
    join(progressDirForPhase(cwd, phase), fileName),
    join(cwd, LEGACY_PROGRESS_DIR, fileName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return state.progressFile;
}

export function persistState(cwd: string, state: RalpixState): void {
  const filePath = stateFilePath(cwd);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function restoreState(cwd: string, planPath?: string): RalpixState | null {
  const filePath = stateFilePath(cwd);
  if (!existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RalpixState>;
    const phase = parsed.phase;
    if (
      typeof parsed.planPath !== "string" ||
      typeof parsed.planTitle !== "string" ||
      (typeof parsed.currentTaskId !== "string" && parsed.currentTaskId !== null) ||
      (phase !== "idle" && phase !== "executing" && phase !== "reviewing" && phase !== "complete") ||
      !Array.isArray(parsed.completedTasks) ||
      !Array.isArray(parsed.failedTasks) ||
      typeof parsed.progressFile !== "string"
    ) {
      return null;
    }

    const restored: RalpixState = {
      planPath: parsed.planPath,
      planTitle: parsed.planTitle,
      currentTaskId: parsed.currentTaskId,
      phase,
      completedTasks: parsed.completedTasks,
      failedTasks: parsed.failedTasks,
      progressFile: resolveStateProgressFile(cwd, {
        planPath: parsed.planPath,
        planTitle: parsed.planTitle,
        currentTaskId: parsed.currentTaskId,
        phase,
        completedTasks: parsed.completedTasks,
        failedTasks: parsed.failedTasks,
        progressFile: parsed.progressFile,
        ...(parsed.review === undefined ? {} : { review: parsed.review }),
      }),
      ...(parsed.review === undefined ? {} : { review: parsed.review }),
    };

    if (planPath !== undefined && resolve(restored.planPath) !== resolve(planPath)) {
      return null;
    }

    return restored;
  } catch {
    return null;
  }
}

function clearState(cwd: string): void {
  rmSync(stateFilePath(cwd), { force: true });
}

export function buildStatusWidgetView(state: RalpixState): string[] {
  return [
    `Plan: ${state.planTitle}`,
    `Phase: ${state.phase}`,
    `Current task: ${state.currentTaskId ?? "-"}`,
    `Completed: ${String(state.completedTasks.length)}`,
    `Failed: ${String(state.failedTasks.length)}`,
    `Progress log: ${state.progressFile}`,
  ];
}

function planState(plan: Plan, phase: RalpixState["phase"], progressFile: string): RalpixState {
  return {
    planPath: plan.path,
    planTitle: plan.title,
    currentTaskId: plan.tasks.find((task) => task.status === "pending" || task.status === "in-progress")?.id ?? null,
    phase,
    completedTasks: plan.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    failedTasks: plan.tasks.filter((task) => task.status === "failed").map((task) => task.id),
    progressFile,
  };
}

function defaultSessionName(phase: Phase, now: Date, detail?: string): string {
  const base = detail === undefined ? phase : slugify(detail);
  return `${phase}-${timestamp(now)}-${base}`;
}

function progressFilePathFor(cwd: string, phase: Phase, sessionName: string): string {
  return join(progressDirForPhase(cwd, phase), `${sessionName}.jsonl`);
}

export async function createPhaseRun(
  ctx: ExtensionCommandContext,
  phase: Phase,
  sessionName: string,
  _now: Date,
): Promise<PhaseRun> {
  void _now;
  await Promise.resolve();
  const logWriter = new LogWriter(ctx.cwd, phase, sessionName);
  const emitter = createLogWriterEmitter(logWriter);

  return {
    close: () => { return; },
    progressFilePath: progressFilePathFor(ctx.cwd, phase, sessionName),
    sessionName,
    session: createEventBus(ctx, phase, [emitter, createTuiEmitter(ctx)]),
  };
}

function movePlanToCompleted(planPath: string): string {
  const source = resolve(planPath);
  const completedDir = join(dirname(source), "completed");
  mkdirSync(completedDir, { recursive: true });
  const destination = join(completedDir, basename(source));
  renameSync(source, destination);
  return destination;
}

function normalizePlanPath(cwd: string, rawArg: string): string {
  const withoutAt = rawArg.startsWith("@") ? rawArg.slice(1) : rawArg;
  return resolve(cwd, withoutAt);
}

function getCurrentBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf8" }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

function createBranch(cwd: string, branchName: string): void {
  execSync(`git switch -c ${branchName}`, { cwd, stdio: "ignore" });
}

async function maybeSwitchBranch(
  ctx: ExtensionCommandContext,
  seed: string,
  dependencies: IndexDependencies,
): Promise<void> {
  const currentBranch = (dependencies.getCurrentBranch ?? getCurrentBranch)(ctx.cwd);
  if (currentBranch === null || !MAIN_BRANCHES.has(currentBranch) || !ctx.hasUI) return;

  const branchName = `ralpix/${timestamp((dependencies.now ?? (() => new Date()))()).slice(0, 8)}-${slugify(seed)}`;
  const accepted = await ctx.ui.confirm(
    `You are on ${currentBranch}. Create a feature branch now?`,
    branchName,
  );
  if (accepted !== true) return;

  (dependencies.createBranch ?? createBranch)(ctx.cwd, branchName);
  notify(ctx, `Switched to ${branchName}`, "success");
}

function handleInit(
  ctx: ExtensionCommandContext,
  dependencies: IndexDependencies,
): void {
  const init = dependencies.initRalpixHome ?? initRalpixHome;
  const result = init(false);
  const parts = [];
  if (result.created.length > 0) parts.push(`${String(result.created.length)} created`);
  if (result.overwritten.length > 0) parts.push(`${String(result.overwritten.length)} overwritten`);
  if (result.skipped.length > 0) parts.push(`${String(result.skipped.length)} skipped`);
  const suffix = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  notify(ctx, `ralpix initialized${suffix}`, "success");
}

interface PlanCommandInput {
  description: string;
  existingPlanPath?: string;
}

interface HandlePlanOptions {
  brainstormContext?: string;
  skipBrainstormPrompt?: boolean;
}

async function maybeCollectBrainstormContext(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  description: string,
  config: RalpixConfig,
  dependencies: IndexDependencies,
): Promise<string | undefined> {
  if (!ctx.hasUI || !config.brainstormEnabled) {
    return undefined;
  }

  const brainstormFirst = await ctx.ui.confirm(
    "Brainstorm before creating the plan?",
    description,
  );
  if (brainstormFirst !== true) {
    return undefined;
  }

  const brainstormRun = await createPhaseRun(
    ctx,
    "brainstorm",
    defaultSessionName("brainstorm", (dependencies.now ?? (() => new Date()))(), description),
    (dependencies.now ?? (() => new Date()))(),
  );

  try {
    const result = await (dependencies.runBrainstorm ?? runBrainstorm)(
      ctx,
      pi as never,
      description,
      config,
      brainstormRun.session,
    );
    notify(ctx, `Brainstorm complete: ${result.sessionName}`, "success");
    notify(ctx, `Progress log: ${brainstormRun.progressFilePath}`, "info");
    return result.context;
  } finally {
    brainstormRun.session.close();
    brainstormRun.close();
  }
}

async function reopenExistingPlan(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  existingPlanPath: string,
  dependencies: IndexDependencies,
): Promise<boolean> {
  if (!existsSync(existingPlanPath)) {
    throw new Error(`plan not found: ${existingPlanPath}`);
  }

  if (!ctx.hasUI) {
    notify(ctx, `Plan ready: ${existingPlanPath}`, "info");
    return true;
  }

  const action = await ctx.ui.select(
    "Existing plan",
    ["Execute now", "Exit and run later"],
  );
  if (action === "Execute now") {
    await handleExecute(ctx, pi, existingPlanPath, dependencies);
    return true;
  }

  notify(ctx, `Plan ready: ${existingPlanPath}`, "info");
  return true;
}

async function handleBrainstorm(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  description: string,
  dependencies: IndexDependencies,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("brainstorm requires an interactive UI");
  }

  const config = loadRunConfig(ctx, dependencies);
  let nextPlanContext: string | undefined;
  let createPlanAfterBrainstorm = false;
  const phaseRun = await createPhaseRun(
    ctx,
    "brainstorm",
    defaultSessionName("brainstorm", (dependencies.now ?? (() => new Date()))(), description),
    (dependencies.now ?? (() => new Date()))(),
  );

  try {
    const result = await (dependencies.runBrainstorm ?? runBrainstorm)(
      ctx,
      pi as never,
      description,
      config,
      phaseRun.session,
    );
    notify(ctx, `Brainstorm complete: ${result.sessionName}`, "success");
    notify(ctx, `Progress log: ${phaseRun.progressFilePath}`, "info");
    createPlanAfterBrainstorm = (await ctx.ui.confirm(
      "Create a plan from this brainstorm now?",
      description,
    )) === true;
    nextPlanContext = result.context;
  } finally {
    phaseRun.session.close();
    phaseRun.close();
  }

  if (createPlanAfterBrainstorm) {
    await handlePlan(
      ctx,
      pi,
      {
        description,
      },
      dependencies,
      {
        brainstormContext: nextPlanContext,
        skipBrainstormPrompt: true,
      },
    );
  }
}

async function handlePlan(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  input: PlanCommandInput,
  dependencies: IndexDependencies,
  options: HandlePlanOptions = {},
): Promise<void> {
  const config = loadRunConfig(ctx, dependencies);
  const description = input.description.trim();
  const existingPlanPath = input.existingPlanPath;

  if (existingPlanPath !== undefined && description.length === 0) {
    await reopenExistingPlan(ctx, pi, existingPlanPath, dependencies);
    return;
  }

  let brainstormContext = options.brainstormContext;
  if (brainstormContext === undefined && options.skipBrainstormPrompt !== true) {
    brainstormContext = await maybeCollectBrainstormContext(ctx, pi, description, config, dependencies);
  }

  const phaseRun = await createPhaseRun(
    ctx,
    "plan",
    defaultSessionName("plan", (dependencies.now ?? (() => new Date()))(), description.length > 0 ? description : existingPlanPath),
    (dependencies.now ?? (() => new Date()))(),
  );

  try {
    const existingDraft = existingPlanPath === undefined
      ? undefined
      : readFileSync(existingPlanPath, "utf8");
    const result = await (dependencies.runPlanCreation ?? runPlanCreation)(
      ctx,
      pi as never,
      description,
      config,
      phaseRun.session,
      {
        ...(brainstormContext === undefined ? {} : { brainstormContext }),
        ...(existingDraft === undefined ? {} : { existingDraft }),
        ...(existingPlanPath === undefined ? {} : { existingPlanPath }),
      },
    );
    notify(ctx, `Plan saved: ${result.planPath}`, "success");
    notify(ctx, `Progress log: ${phaseRun.progressFilePath}`, "info");
  } finally {
    phaseRun.session.close();
    phaseRun.close();
  }
}

function ensureExecutionCompleted(plan: Plan): void {
  const unfinished = plan.tasks.find((task) => task.status !== "completed");
  if (unfinished !== undefined) {
    throw new Error(`plan execution stopped before completion: ${unfinished.title}`);
  }
}

async function handleExecute(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  planPath: string,
  dependencies: IndexDependencies,
): Promise<void> {
  const config = loadRunConfig(ctx, dependencies);
  const load = dependencies.loadPlan ?? loadPlan;
  let plan = load(planPath);
  await maybeSwitchBranch(ctx, plan.title, dependencies);

  migrateLegacyProgressLogs(ctx.cwd);
  const restored = restoreState(ctx.cwd, planPath);
  if (restored !== null) {
    notify(ctx, `Resuming interrupted ralpix session for ${restored.planTitle}`, "warning");
    if (ctx.hasUI) {
      ctx.ui.setWidget("ralpix-status", buildStatusWidgetView(restored));
    }
  }

  const executeRun = await createPhaseRun(
    ctx,
    "execute",
    slugify(basename(plan.path, extname(plan.path))),
    (dependencies.now ?? (() => new Date()))(),
  );

  try {
    if (restored?.phase === "executing") {
      executeRun.session.milestone("resume", `Resumed execution for ${restored.planTitle}`);
    }

    persistState(ctx.cwd, planState(plan, "executing", executeRun.progressFilePath));
    await (dependencies.executeAllTasks ?? executeAllTasks)(
      ctx,
      pi as never,
      plan,
      config,
      executeRun.session,
    );

    plan = load(planPath);
    ensureExecutionCompleted(plan);
  } catch (error) {
    const failedPlan = (dependencies.loadPlan ?? loadPlan)(planPath);
    persistState(ctx.cwd, planState(failedPlan, "executing", executeRun.progressFilePath));
    throw error;
  } finally {
    executeRun.session.close();
    executeRun.close();
  }

  if (config.reviewEnabled) {
    const reviewRun = await createPhaseRun(
      ctx,
      "review",
      `${slugify(basename(plan.path, extname(plan.path)))}-review`,
      (dependencies.now ?? (() => new Date()))(),
    );
    try {
      if (restored?.phase === "reviewing") {
        reviewRun.session.milestone("resume", `Resumed review for ${restored.planTitle}`);
      }

      persistState(ctx.cwd, planState(plan, "reviewing", reviewRun.progressFilePath));
      await (dependencies.runReviewPipeline ?? runReviewPipeline)(
        ctx,
        pi as never,
        plan,
        config,
        reviewRun.session,
        {
          progressFile: reviewRun.progressFilePath,
        },
      );
    } catch (error) {
      persistState(ctx.cwd, planState(plan, "reviewing", reviewRun.progressFilePath));
      throw error;
    } finally {
      reviewRun.session.close();
      reviewRun.close();
    }
  }

  const completedPath = movePlanToCompleted(plan.path);
  clearState(ctx.cwd);
  if (ctx.hasUI) {
    ctx.ui.setWidget("ralpix-status", undefined);
  }
  notify(ctx, `Plan completed: ${completedPath}`, "success");
}

async function handleReview(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  dependencies: IndexDependencies,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("review requires an interactive UI");
  }

  const config = loadRunConfig(ctx, dependencies);
  const branch = (dependencies.getCurrentBranch ?? getCurrentBranch)(ctx.cwd) ?? "current";
  const phaseRun = await createPhaseRun(
    ctx,
    "review",
    defaultSessionName("review", (dependencies.now ?? (() => new Date()))(), branch),
    (dependencies.now ?? (() => new Date()))(),
  );

  try {
    await (dependencies.runStandaloneReview ?? runStandaloneReview)(
      ctx,
      pi as never,
      config,
      phaseRun.session,
      {
        progressFile: phaseRun.progressFilePath,
      },
    );
    notify(ctx, `Progress log: ${phaseRun.progressFilePath}`, "info");
  } finally {
    phaseRun.session.close();
    phaseRun.close();
  }
}

type ParsedCommand = { kind: "invalid" } |
  { kind: "init" } |
  { kind: "review" } |
  { kind: "brainstorm"; description: string } |
  { kind: "brainstorm-usage" } |
  { kind: "plan"; description: string; existingPlanPath?: string } |
  { kind: "plan-usage" } |
  { kind: "execute"; planPath: string } |
  { kind: "execute-usage" };

function splitFirstToken(value: string): { first: string; rest: string } {
  const match = (/^\s*(\S+)(?:\s+([\S\s]*))?$/).exec(value);
  return {
    first: match?.[1] ?? "",
    rest: match?.[2]?.trim() ?? "",
  };
}

function looksLikePlanPath(rawArg: string): boolean {
  return rawArg.startsWith("@") || rawArg.endsWith(".md");
}

function parsePlanCommandArgs(args: string, cwd: string): ParsedCommand {
  if (args.length === 0) return { kind: "plan-usage" };
  const { first, rest } = splitFirstToken(args);
  if (looksLikePlanPath(first) && existsSync(normalizePlanPath(cwd, first))) {
    return { kind: "plan", existingPlanPath: normalizePlanPath(cwd, first), description: rest };
  }
  return { kind: "plan", description: args };
}

function parseCommand(trimmed: string, cwd: string): ParsedCommand {
  if (trimmed.length === 0) return { kind: "invalid" };
  if (trimmed === "init") return { kind: "init" };
  if (trimmed === "review") return { kind: "review" };
  if (trimmed === "brainstorm") return { kind: "brainstorm-usage" };
  if (trimmed.startsWith("brainstorm ")) {
    const description = trimmed.slice("brainstorm ".length).trim();
    return description.length > 0 ? { kind: "brainstorm", description } : { kind: "brainstorm-usage" };
  }
  if (trimmed === "plan") return { kind: "plan-usage" };
  if (trimmed.startsWith("plan ")) {
    return parsePlanCommandArgs(trimmed.slice("plan ".length).trim(), cwd);
  }
  if (trimmed === "execute") return { kind: "execute-usage" };
  if (trimmed.startsWith("execute ")) {
    return { kind: "execute", planPath: normalizePlanPath(cwd, trimmed.slice("execute ".length).trim()) };
  }
  return { kind: "execute", planPath: normalizePlanPath(cwd, trimmed) };
}

export function createRalpixCommandHandler(
  pi: ExtensionAPI,
  dependencies: IndexDependencies = {},
): (args: unknown, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args: unknown, ctx: ExtensionCommandContext) => {
    const trimmed = typeof args === "string" ? args.trim() : "";
    const command = parseCommand(trimmed, ctx.cwd);

    try {
      switch (command.kind) {
        case "invalid": {
          notify(ctx, usage(), "error");
          return;
        }
        case "init": {
          handleInit(ctx, dependencies);
          return;
        }
        case "review": {
          await handleReview(ctx, pi, dependencies);
          return;
        }
        case "brainstorm-usage": {
          notify(ctx, "Usage: /ralpix brainstorm <description>", "error");
          return;
        }
        case "brainstorm": {
          await handleBrainstorm(ctx, pi, command.description, dependencies);
          return;
        }
        case "plan-usage": {
          notify(ctx, "Usage: /ralpix plan <description>", "error");
          return;
        }
        case "plan": {
          await handlePlan(ctx, pi, {
            description: command.description,
            ...(command.existingPlanPath === undefined ? {} : { existingPlanPath: command.existingPlanPath }),
          }, dependencies);
          return;
        }
        case "execute-usage": {
          notify(ctx, "Usage: /ralpix execute <plan-path>", "error");
          return;
        }
        case "execute": {
          await handleExecute(ctx, pi, command.planPath, dependencies);
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, message, "error");
    }
  };
}

export default function ralpixExtension(pi: ExtensionAPI): void {
  pi.registerCommand("ralpix", {
    description: "Run ralpix plan, execute, brainstorm, review, and init commands",
    handler: createRalpixCommandHandler(pi),
  });
}
