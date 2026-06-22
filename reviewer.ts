import { execSync } from "node:child_process";

import { buildSessionModelChange, resolveModel, resolvePiAgentDir } from "./config.js";
import { expandPrompt, loadPrompt } from "./prompt.js";
import { runTaskReviewSubprocess } from "./task-review-subprocess.js";
import { usageToData } from "./utils.js";

import type { RunSession } from "./event-bus.js";
import type { PiCommand, RunPiSubprocessConfig } from "./pi-subprocess.js";
import type { ReviewPromptPhase, TaskReviewSubprocessResult } from "./task-review-subprocess.js";
import type { ModelConfig, Plan, RalpixConfig, ReviewStageId, SubprocessUsage } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ReviewMode = "review-only" | "review-and-fix";
type ReviewTarget = "branch" | "uncommitted" | "both";

interface UsageAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface ReviewStageState {
  usage: UsageAccumulator;
}

interface ReviewRuntime {
  loadPrompt: (name: string, cwd: string) => string;
  runSubprocess: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
    phase: ReviewPromptPhase,
  ) => Promise<TaskReviewSubprocessResult>;
  detectDefaultBranch: (cwd: string) => string;
  getHeadHash: (cwd: string) => string;
  getCurrentBranch: (cwd: string) => string | null;
  progressFile: string;
  diffCommands: string | undefined;
  reviewOnly: boolean;
}

export interface ReviewerDependencies {
  loadPrompt?: (name: string, cwd: string) => string;
  runSubprocess?: ReviewRuntime["runSubprocess"];
  detectDefaultBranch?: (cwd: string) => string;
  getHeadHash?: (cwd: string) => string;
  getCurrentBranch?: (cwd: string) => string | null;
  progressFile?: string;
  diffCommands?: string;
  reviewOnly?: boolean;
}

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const NO_ISSUES_FOUND_RE = /^no issues found$/i;
const EXTERNAL_REVIEW_MODEL_PHASE = "external-review";
const EXTERNAL_EVAL_MODEL_PHASE = "external-eval";
const EXTERNAL_REVIEW_STAGE: ReviewStageId = "external-review";
const EXTERNAL_EVAL_STAGE: ReviewStageId = "external-eval";
const FIRST_PASS_AGENTS = 5;
const SECOND_PASS_AGENTS = 2;
const ALL_REVIEW_STAGES: ReviewStageId[] = [
  "first-pass",
  "first-pass-stabilize",
  EXTERNAL_REVIEW_STAGE,
  EXTERNAL_EVAL_STAGE,
  "second-pass",
];

export async function runReviewPipeline(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  dependencies: ReviewerDependencies = {},
): Promise<void> {
  const runtime = resolveReviewerRuntime(dependencies);
  const totalUsage = emptyUsage();

  session.log("phase_start", { label: runtime.reviewOnly ? "review-only" : "review-and-fix" });

  if (!config.reviewEnabled) {
    for (const stage of ALL_REVIEW_STAGES) {
      finishStage(session, stage, "skipped", totalUsage, emptyUsage(), "review disabled");
    }
    session.log("phase_end", { label: "skipped" });
    return;
  }

  const defaultBranch = runtime.detectDefaultBranch(ctx.cwd);
  const mode: ReviewMode = runtime.reviewOnly ? "review-only" : "review-and-fix";

  const firstPass = await runSinglePassStage(
    "first-pass",
    "review-first",
    "review-first",
    ctx,
    pi,
    plan,
    config,
    session,
    runtime,
    totalUsage,
    defaultBranch,
    mode,
    "checking all completed tasks",
  );
  if (!firstPass) {
    session.log("phase_end", { label: "failed" });
    return;
  }

  const stabilized = await runFirstPassStabilizeStage(
    ctx,
    pi,
    plan,
    config,
    session,
    runtime,
    totalUsage,
    defaultBranch,
    mode,
  );
  if (!stabilized) {
    session.log("phase_end", { label: "failed" });
    return;
  }

  const externalSucceeded = await runExternalReviewStages(
    ctx,
    pi,
    plan,
    config,
    session,
    runtime,
    totalUsage,
    defaultBranch,
    mode,
  );
  if (!externalSucceeded) {
    session.log("phase_end", { label: "failed" });
    return;
  }

  const secondPass = await runSecondPassStage(
    ctx,
    pi,
    plan,
    config,
    session,
    runtime,
    totalUsage,
    defaultBranch,
    mode,
  );

  if (secondPass) {
    await runFinalize(ctx, pi, plan, config, session, runtime);
  }

  session.log("phase_end", { label: secondPass ? "complete" : "failed" });
}

export async function runStandaloneReview(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  config: RalpixConfig,
  session: RunSession,
  dependencies: ReviewerDependencies = {},
): Promise<void> {
  const runtime = resolveReviewerRuntime(dependencies);
  const currentBranch = runtime.getCurrentBranch(ctx.cwd) ?? "current";
  const reviewTarget = await session.choose(
    "What should ralpix review?",
    [
      "Branch diff vs main",
      "Uncommitted changes",
      "Branch diff plus uncommitted changes",
    ],
  );
  if (reviewTarget === null) {
    throw new Error("standalone review cancelled");
  }

  const modeChoice = await session.choose(
    "How should ralpix handle the review?",
    ["Review and fix", "Review only"],
  );
  if (modeChoice === null) {
    throw new Error("standalone review cancelled");
  }

  const target = mapReviewTarget(reviewTarget);
  const reviewOnly = modeChoice === "Review only";
  const title = standaloneReviewTitle(reviewTarget, currentBranch);

  await runReviewPipeline(
    ctx,
    pi,
    {
      path: "",
      title,
      overview: "",
      context: "",
      successCriteria: [],
      tasks: [],
      extraSections: {},
    },
    config,
    session,
    {
      ...dependencies,
      reviewOnly,
      diffCommands: buildDiffCommands(runtime.detectDefaultBranch(ctx.cwd), target),
    },
  );
}

async function runFinalize(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
): Promise<void> {
  if (!config.finalizeEnabled) {
    session.milestone("finalize-skip", "finalize skipped");
    return;
  }

  session.milestone("finalize-start", "Finalize started");
  const prompt = expandPrompt(runtime.loadPrompt("finalize", ctx.cwd), {
    GOAL: plan.title,
  });

  const result = await runtime.runSubprocess(
    ctx,
    pi,
    prompt,
    buildSubprocessConfig(config, "review-second", ctx.cwd),
    session,
    "second",
  );

  if (result.report.success) {
    session.milestone("finalize-end", "Finalize complete");
  } else {
    session.milestone("ERR", `Finalize failed: ${result.report.summary}`);
  }
}

function resolveReviewerRuntime(dependencies: ReviewerDependencies): ReviewRuntime {
  const progressFile = dependencies.progressFile?.trim() ?? "";
  if (progressFile.length === 0) {
    throw new Error("review progressFile is required");
  }

  return {
    loadPrompt: dependencies.loadPrompt ?? loadPrompt,
    runSubprocess: dependencies.runSubprocess ?? runTaskReviewSubprocess,
    detectDefaultBranch: dependencies.detectDefaultBranch ?? detectDefaultBranch,
    getHeadHash: dependencies.getHeadHash ?? getHeadHash,
    getCurrentBranch: dependencies.getCurrentBranch ?? getCurrentBranch,
    progressFile,
    diffCommands: dependencies.diffCommands,
    reviewOnly: dependencies.reviewOnly ?? false,
  };
}

async function runSinglePassStage(
  stage: ReviewStageId,
  promptName: string,
  modelPhase: "review-first" | "review-second",
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  totalUsage: UsageAccumulator,
  defaultBranch: string,
  mode: ReviewMode,
  detail: string,
): Promise<boolean> {
  const stageState = startStage(session, stage, detail);
  const result = await runParallelStagePrompts(
    FIRST_PASS_AGENTS,
    ctx,
    pi,
    promptName,
    modelPhase,
    plan,
    config,
    session,
    runtime,
    defaultBranch,
    mode,
  );

  addUsage(stageState.usage, result.usage);
  addUsage(totalUsage, result.usage);

  if (!result.report.success) {
    finishStage(session, stage, "failed", totalUsage, stageState.usage, result.report.summary);
    return false;
  }

  finishStage(session, stage, "complete", totalUsage, stageState.usage, result.report.summary);
  return true;
}

async function runIterativePassStage(
  stage: ReviewStageId,
  initialDetail: string,
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  totalUsage: UsageAccumulator,
  defaultBranch: string,
  mode: ReviewMode,
): Promise<boolean> {
  const maxIterations = normalizedIterations(config.reviewMaxIterations);
  const stageState = startStage(session, stage, initialDetail);

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const headBefore = runtime.getHeadHash(ctx.cwd);
    if (headBefore.length === 0 && !runtime.reviewOnly) {
      finishStage(session, stage, "failed", totalUsage, stageState.usage, "cannot determine git HEAD");
      return false;
    }

    session.log("iteration_start", { stage, iteration });
    const result = await runParallelStagePrompts(
      SECOND_PASS_AGENTS,
      ctx,
      pi,
      "review-second",
      "review-second",
      plan,
      config,
      session,
      runtime,
      defaultBranch,
      mode,
    );

    addUsage(stageState.usage, result.usage);
    addUsage(totalUsage, result.usage);
    session.log("iteration_end", {
      stage,
      iteration,
      usage: usageSnapshot(result.usage, totalUsage),
    });

    if (!result.report.success) {
      finishStage(session, stage, "failed", totalUsage, stageState.usage, result.report.summary);
      return false;
    }

    if (runtime.reviewOnly) {
      finishStage(session, stage, "complete", totalUsage, stageState.usage, "review-only pass complete");
      return true;
    }

    const headAfter = runtime.getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      finishStage(session, stage, "complete", totalUsage, stageState.usage, `review clean at iteration ${String(iteration)}`);
      return true;
    }

    session.log("stage_update", {
      stage,
      detail: `fixes applied in iteration ${String(iteration)}; continuing`,
    });
  }

  finishStage(
    session,
    stage,
    "complete",
    totalUsage,
    stageState.usage,
    `max iterations reached (${String(maxIterations)})`,
  );
  return true;
}

async function runFirstPassStabilizeStage(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  totalUsage: UsageAccumulator,
  defaultBranch: string,
  mode: ReviewMode,
): Promise<boolean> {
  const maxIterations = normalizedIterations(config.reviewMaxIterations);
  return runIterativePassStage(
    "first-pass-stabilize",
    `stabilizing — iteration 1/${String(maxIterations)}`,
    ctx, pi, plan, config, session, runtime, totalUsage, defaultBranch, mode,
  );
}

async function runSecondPassStage(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  totalUsage: UsageAccumulator,
  defaultBranch: string,
  mode: ReviewMode,
): Promise<boolean> {
  const maxIterations = normalizedIterations(config.reviewMaxIterations);
  return runIterativePassStage(
    "second-pass",
    `quality review — iteration 1/${String(maxIterations)}`,
    ctx, pi, plan, config, session, runtime, totalUsage, defaultBranch, mode,
  );
}

async function runExternalReviewStages(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  totalUsage: UsageAccumulator,
  defaultBranch: string,
  mode: ReviewMode,
): Promise<boolean> {
  if (!config.externalReviewEnabled) {
    finishStage(session, EXTERNAL_REVIEW_STAGE, "skipped", totalUsage, emptyUsage(), "external review disabled");
    finishStage(session, EXTERNAL_EVAL_STAGE, "skipped", totalUsage, emptyUsage(), "external review disabled");
    return true;
  }

  const model = resolveModel(config, EXTERNAL_REVIEW_MODEL_PHASE);
  if (!hasConfiguredModel(model)) {
    finishStage(session, EXTERNAL_REVIEW_STAGE, "skipped", totalUsage, emptyUsage(), "no external model configured");
    finishStage(session, EXTERNAL_EVAL_STAGE, "skipped", totalUsage, emptyUsage(), "no findings to evaluate");
    return true;
  }

  const maxIterations = normalizedIterations(config.externalReviewMaxIterations);
  const patience = config.externalReviewPatience > 0 ? config.externalReviewPatience : 3;
  const reviewerName = reviewModelLabel(model);
  const reviewState = startStage(
    session,
    EXTERNAL_REVIEW_STAGE,
    `auditing changes — iteration 1/${String(maxIterations)} (${reviewerName})`,
  );
  const evalState = startStage(session, EXTERNAL_EVAL_STAGE, `fixing findings — patience ${String(patience)}`);

  let previousFindings = "";
  let lastReviewHead = "";
  let unchangedRounds = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    session.log("iteration_start", { stage: EXTERNAL_REVIEW_STAGE, iteration });
    const reviewPrompt = buildExternalReviewPrompt(
      ctx.cwd,
      runtime,
      defaultBranch,
      plan.title,
      lastReviewHead,
      previousFindings,
    );
    const reviewResult = await runtime.runSubprocess(
      ctx,
      pi,
      reviewPrompt,
      buildSubprocessConfig(config, EXTERNAL_REVIEW_MODEL_PHASE, ctx.cwd),
      session,
      "external",
    );

    addUsage(reviewState.usage, reviewResult.usage);
    addUsage(totalUsage, reviewResult.usage);
    session.log("iteration_end", {
      stage: EXTERNAL_REVIEW_STAGE,
      iteration,
      usage: usageSnapshot(reviewResult.usage, totalUsage),
    });

    if (!reviewResult.report.success) {
      finishStage(session, EXTERNAL_REVIEW_STAGE, "failed", totalUsage, reviewState.usage, reviewResult.report.summary);
      finishStage(session, EXTERNAL_EVAL_STAGE, "failed", totalUsage, evalState.usage, "external reviewer failed");
      return false;
    }

    const findings = reviewResult.report.summary.trim();
    if (findings.length === 0 || NO_ISSUES_FOUND_RE.test(findings)) {
      finishStage(session, EXTERNAL_REVIEW_STAGE, "complete", totalUsage, reviewState.usage, "no issues found");
      finishStage(session, EXTERNAL_EVAL_STAGE, "skipped", totalUsage, evalState.usage, "no findings to evaluate");
      return true;
    }

    previousFindings = findings;
    lastReviewHead = runtime.getHeadHash(ctx.cwd);
    session.log("stage_update", { stage: EXTERNAL_REVIEW_STAGE, detail: `findings reported in iteration ${String(iteration)}` });

    if (runtime.reviewOnly) {
      finishStage(session, EXTERNAL_REVIEW_STAGE, "complete", totalUsage, reviewState.usage, `findings reported in iteration ${String(iteration)}`);
      finishStage(session, EXTERNAL_EVAL_STAGE, "skipped", totalUsage, evalState.usage, "review-only mode");
      return true;
    }

    const evalOutcome = await runExternalEvalIteration(
      ctx,
      pi,
      plan,
      config,
      session,
      runtime,
      totalUsage,
      defaultBranch,
      mode,
      reviewState,
      evalState,
      findings,
      iteration,
      patience,
      unchangedRounds,
    );
    unchangedRounds = evalOutcome.unchangedRounds;
    if (evalOutcome.complete !== null) {
      return evalOutcome.complete;
    }
  }

  finishStage(
    session,
    EXTERNAL_REVIEW_STAGE,
    "complete",
    totalUsage,
    reviewState.usage,
    `max iterations reached (${String(maxIterations)})`,
  );
  finishStage(
    session,
    EXTERNAL_EVAL_STAGE,
    "complete",
    totalUsage,
    evalState.usage,
    `max iterations reached (${String(maxIterations)})`,
  );
  return true;
}

async function runPromptForStage(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  promptName: string,
  modelPhase: "review-first" | "review-second" | "external-review" | "external-eval",
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  defaultBranch: string,
  mode: ReviewMode,
  extraVars: Record<string, string> = {},
): Promise<TaskReviewSubprocessResult> {
  const prompt = buildStagePrompt(
    runtime.loadPrompt(promptName, ctx.cwd),
    plan,
    runtime.progressFile,
    defaultBranch,
    runtime.diffCommands ?? buildDiffCommands(defaultBranch, "branch"),
    mode,
    modelPhase,
    extraVars,
  );

  return runtime.runSubprocess(
    ctx,
    pi,
    prompt,
    buildSubprocessConfig(config, modelPhase, ctx.cwd),
    session,
    reviewPromptPhaseForModel(modelPhase),
  );
}

async function runParallelStagePrompts(
  count: number,
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  promptName: string,
  modelPhase: "review-first" | "review-second" | "external-review" | "external-eval",
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  defaultBranch: string,
  mode: ReviewMode,
  extraVars: Record<string, string> = {},
): Promise<TaskReviewSubprocessResult> {
  const results = await Promise.all(
    Array.from({ length: count }, async () => runPromptForStage(
      ctx,
      pi,
      promptName,
      modelPhase,
      plan,
      config,
      session,
      runtime,
      defaultBranch,
      mode,
      extraVars,
    )),
  );

  const combinedUsage = results.reduce<SubprocessUsage>((usage, result) => ({
    input: usage.input + result.usage.input,
    output: usage.output + result.usage.output,
    cacheRead: usage.cacheRead + result.usage.cacheRead,
    cacheWrite: usage.cacheWrite + result.usage.cacheWrite,
    cost: usage.cost + result.usage.cost,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

  const summaries = results
    .map((result, index) => `agent ${String(index + 1)}: ${result.report.summary}`)
    .filter((summary) => summary.trim().length > 0);

  return {
    status: results.every((result) => result.status === "success") ? "success" : "failure",
    success: results.every((result) => result.success),
    exitCode: results.some((result) => result.exitCode !== 0) ? 1 : 0,
    signal: null,
    stdout: results.map((result) => result.stdout).join("\n"),
    stderr: results.map((result) => result.stderr).join("\n"),
    message: results
      .map((result) => result.message)
      .filter((message): message is string => typeof message === "string" && message.length > 0)
      .join("\n"),
    usage: combinedUsage,
    report: {
      success: results.every((result) => result.report.success),
      summary: summaries.join("\n"),
    },
  };
}

function buildStagePrompt(
  template: string,
  plan: Plan,
  progressFile: string,
  defaultBranch: string,
  diffCommands: string,
  mode: ReviewMode,
  phase: "review-first" | "review-second" | "external-review" | "external-eval",
  extraVars: Record<string, string>,
): string {
  let fixInstructions = "";
  if (phase === "review-first") {
    fixInstructions = firstPassFixInstructions(mode);
  } else if (phase === "review-second") {
    fixInstructions = secondPassFixInstructions(mode);
  }

  return expandPrompt(template, {
    GOAL: plan.title,
    PROGRESS_FILE: progressFile,
    DEFAULT_BRANCH: defaultBranch,
    DIFF_COMMANDS: diffCommands,
    FIX_INSTRUCTIONS: fixInstructions,
    ...extraVars,
  });
}

function buildExternalReviewPrompt(
  cwd: string,
  runtime: ReviewRuntime,
  defaultBranch: string,
  goal: string,
  lastReviewHead: string,
  previousFindings: string,
): string {
  const template = runtime.loadPrompt(EXTERNAL_REVIEW_MODEL_PHASE, cwd);
  const diffCommands = lastReviewHead.length > 0
    ? [
      "Run these commands to see the latest fix changes:",
      "```bash",
      `git diff ${lastReviewHead}..HEAD --stat`,
      `git diff ${lastReviewHead}..HEAD`,
      "```",
    ].join("\n")
    : runtime.diffCommands ?? buildDiffCommands(defaultBranch, "branch");

  const previousBlock = previousFindings.length === 0
    ? ""
    : [
      "",
      "## Previous Review Findings",
      "",
      previousFindings,
      "",
      "Re-check unresolved findings before reporting new ones.",
    ].join("\n");

  return `${expandPrompt(template, {
    GOAL: goal,
    PROGRESS_FILE: runtime.progressFile,
    DEFAULT_BRANCH: defaultBranch,
    DIFF_COMMANDS: diffCommands,
  })}${previousBlock}`;
}

function buildSubprocessConfig(
  config: RalpixConfig,
  phase: "review-first" | "review-second" | "external-review" | "external-eval",
  cwd: string,
): RunPiSubprocessConfig {
  return {
    ...resolveModel(config, phase),
    piAgentDir: resolvePiAgentDir(cwd, config),
    timeoutMs: config.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS,
  };
}

function reviewPromptPhaseForModel(phase: "review-first" | "review-second" | "external-review" | "external-eval"): ReviewPromptPhase {
  switch (phase) {
    case "review-first": {
      return "first";
    }
    case "review-second": {
      return "second";
    }
    case EXTERNAL_REVIEW_MODEL_PHASE: {
      return "external";
    }
    case EXTERNAL_EVAL_MODEL_PHASE: {
      return "eval";
    }
  }
}

function firstPassFixInstructions(mode: ReviewMode): string {
  if (mode === "review-only") {
    return "Do NOT make code changes. Report findings only.";
  }
  return "Fix critical and major issues, validate the fixes, and keep changes minimal.";
}

function secondPassFixInstructions(mode: ReviewMode): string {
  if (mode === "review-only") {
    return "Do NOT make code changes. Report remaining critical and major findings only.";
  }
  return "Fix only the remaining critical and major issues. Skip style nits and minor issues.";
}

function finishStage(
  session: RunSession,
  stage: ReviewStageId,
  status: "complete" | "failed" | "skipped",
  totalUsage: UsageAccumulator,
  stageUsage: UsageAccumulator,
  detail: string,
): void {
  session.log("stage_finish", {
    stage,
    status,
    detail,
    usage: usageSnapshot(stageUsage, totalUsage),
  });
}

function startStage(session: RunSession, stage: ReviewStageId, detail: string): ReviewStageState {
  session.log("stage_start", { stage, detail });
  return { usage: emptyUsage() };
}

function usageSnapshot(step: UsageAccumulator, total: UsageAccumulator) {
  return usageToData(
    cloneUsage(step),
    {
      input: total.input + total.cacheRead + total.cacheWrite,
      output: total.output,
      cost: total.cost,
    },
  );
}

function emptyUsage(): UsageAccumulator {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function cloneUsage(usage: UsageAccumulator): SubprocessUsage {
  return { ...usage };
}

function addUsage(target: UsageAccumulator, usage: SubprocessUsage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost;
}

function normalizedIterations(value: number): number {
  return value > 0 ? value : 10;
}

function hasConfiguredModel(model: ModelConfig): boolean {
  return (model.model?.length ?? 0) > 0 || (model.provider?.length ?? 0) > 0;
}

function reviewModelLabel(model: ModelConfig): string {
  const sessionModel = buildSessionModelChange(model);
  if (sessionModel !== null) return `${sessionModel.provider}/${sessionModel.model}`;
  if (model.model !== null) return model.model;
  if (model.provider !== null) return model.provider;
  return "default";
}

function detectDefaultBranch(cwd: string): string {
  try {
    const remoteHead = execSync("git symbolic-ref refs/remotes/origin/HEAD --short", {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (remoteHead.length > 0) {
      if (!remoteHead.includes("/")) return remoteHead;
      const parts = remoteHead.split("/");
      return parts.at(-1) ?? "main";
    }
  } catch {
    // fall through
  }

  try {
    const branches = execSync("git branch --format='%(refname:short)'", {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
  } catch {
    // fall through
  }

  return "main";
}

function getHeadHash(cwd: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return "";
  }
}

function getCurrentBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return null;
  }
}

function mapReviewTarget(label: string): ReviewTarget {
  switch (label) {
    case "Branch diff vs main": {
      return "branch";
    }
    case "Uncommitted changes": {
      return "uncommitted";
    }
    default: {
      return "both";
    }
  }
}

function standaloneReviewTitle(reviewTarget: string, currentBranch: string): string {
  if (reviewTarget === "Branch diff vs main") {
    return `Review branch ${currentBranch}`;
  }
  if (reviewTarget === "Uncommitted changes") {
    return "Review uncommitted changes";
  }
  return `Review branch ${currentBranch} and uncommitted changes`;
}

interface ExternalEvalOutcome {
  unchangedRounds: number;
  complete: boolean | null;
}

async function runExternalEvalIteration(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  plan: Plan,
  config: RalpixConfig,
  session: RunSession,
  runtime: ReviewRuntime,
  totalUsage: UsageAccumulator,
  defaultBranch: string,
  mode: ReviewMode,
  reviewState: ReviewStageState,
  evalState: ReviewStageState,
  findings: string,
  iteration: number,
  patience: number,
  unchangedRounds: number,
): Promise<ExternalEvalOutcome> {
  const headBefore = runtime.getHeadHash(ctx.cwd);
  session.log("eval_iteration_start", { iteration });
  const evalResult = await runPromptForStage(
    ctx,
    pi,
    EXTERNAL_EVAL_MODEL_PHASE,
    EXTERNAL_EVAL_MODEL_PHASE,
    plan,
    config,
    session,
    runtime,
    defaultBranch,
    mode,
    { FINDINGS: findings },
  );

  addUsage(evalState.usage, evalResult.usage);
  addUsage(totalUsage, evalResult.usage);
  session.log("eval_iteration_end", {
    iteration,
    usage: usageSnapshot(evalResult.usage, totalUsage),
  });

  if (!evalResult.report.success) {
    finishStage(session, EXTERNAL_REVIEW_STAGE, "complete", totalUsage, reviewState.usage, `findings reported in iteration ${String(iteration)}`);
    finishStage(session, EXTERNAL_EVAL_STAGE, "failed", totalUsage, evalState.usage, evalResult.report.summary);
    return { unchangedRounds, complete: false };
  }

  if (evalResult.report.summary.includes("EXTERNAL_REVIEW_DONE")) {
    finishStage(session, EXTERNAL_REVIEW_STAGE, "complete", totalUsage, reviewState.usage, `findings reported in iteration ${String(iteration)}`);
    finishStage(session, EXTERNAL_EVAL_STAGE, "complete", totalUsage, evalState.usage, "all findings resolved");
    return { unchangedRounds, complete: true };
  }

  const headAfter = runtime.getHeadHash(ctx.cwd);
  if (headAfter !== headBefore) {
    session.log("stage_update", { stage: EXTERNAL_EVAL_STAGE, detail: `fixes applied in iteration ${String(iteration)}` });
    return { unchangedRounds: 0, complete: null };
  }

  const nextUnchangedRounds = unchangedRounds + 1;
  session.log("stage_update", {
    stage: EXTERNAL_EVAL_STAGE,
    detail: `no changes (${String(nextUnchangedRounds)}/${String(patience)} stalemate rounds)`,
  });
  if (nextUnchangedRounds < patience) {
    return { unchangedRounds: nextUnchangedRounds, complete: null };
  }

  finishStage(session, EXTERNAL_REVIEW_STAGE, "complete", totalUsage, reviewState.usage, `findings reported in iteration ${String(iteration)}`);
  finishStage(session, EXTERNAL_EVAL_STAGE, "complete", totalUsage, evalState.usage, `stalemate after ${String(patience)} rounds`);
  return { unchangedRounds: nextUnchangedRounds, complete: true };
}

function buildDiffCommands(defaultBranch: string, target: ReviewTarget): string {
  if (target === "uncommitted") {
    return [
      "Run these commands to see uncommitted changes:",
      "```bash",
      "git status",
      "git diff",
      "git diff --cached",
      "```",
    ].join("\n");
  }

  if (target === "both") {
    return [
      "Run these commands to see all changes (branch + uncommitted):",
      "```bash",
      `git log ${defaultBranch}..HEAD --oneline`,
      `git diff ${defaultBranch}...HEAD --stat`,
      `git diff ${defaultBranch}...HEAD`,
      "git status",
      "git diff",
      "git diff --cached",
      "```",
    ].join("\n");
  }

  return [
    "Run these commands to understand branch changes:",
    "```bash",
    `git log ${defaultBranch}..HEAD --oneline`,
    `git diff ${defaultBranch}...HEAD --stat`,
    `git diff ${defaultBranch}...HEAD`,
    "```",
  ].join("\n");
}
