/**
 * Review pipeline — first pass + external review + iterative loop.
 */

import { execSync } from "node:child_process";

import { buildSessionModelChange, resolveModel, resolvePiAgentDir } from "./config.js";
import { LogWriter } from "./logger.js";
import { createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
import { createProgressTui, createTokenLedger } from "./tui.js";

import type { ProgressStep } from "./tui.js";
import type {
  ModelConfig,
  Plan,
  RalpixConfig,
  ReviewStageId,
  ReviewStageStatus,
  SubprocessUsage,
} from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface ReviewSessionReport {
  success: boolean;
  summary: string;
}

export interface ReviewPipelineHooks {
  onStageStart?: (stage: ReviewStageId, detail?: string) => void;
  onStageUpdate?: (stage: ReviewStageId, detail: string) => void;
  onStageFinish?: (
    stage: ReviewStageId,
    status: Exclude<ReviewStageStatus, "pending" | "active">,
    detail?: string,
  ) => void;
  /** Full review report text from a completed stage (findings, verdict, etc.) */
  onStageReport?: (stage: ReviewStageId, report: string) => void;
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
}

const REVIEW_STAGES = {
  firstPass: "first-pass",
  secondPass: "second-pass",
  externalReview: "external-review",
  externalEval: "external-eval",
} as const;

const REVIEW_STAGE_LABELS: Record<ReviewStageId, string> = {
  "first-pass": "Comprehensive review",
  "external-review": "External audit",
  "external-eval": "Resolve findings",
  "second-pass": "Quality & fix loop",
};

const REVIEW_DISABLED_REASON = "review disabled";

function detectDefaultBranch(cwd: string): string {
  try {
    const remoteHead = execSync(
      "git symbolic-ref refs/remotes/origin/HEAD --short",
      { cwd, encoding: "utf-8" },
    ).trim();
    if (remoteHead.length > 0) return remoteHead;
  } catch {
    // No remote or origin/HEAD not set
  }

  try {
    const output = execSync("git branch", { cwd, encoding: "utf-8" });
    if (output.includes("main")) return "main";
    if (output.includes("master")) return "master";
  } catch {
    // not a git repo
  }
  return "main";
}

function getHeadHash(cwd: string): string {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function getCurrentBranch(cwd: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

function getBranchDiffCommands(defaultBranch: string): string {
  return `Run these commands to understand branch changes:
\`\`\`bash
git log ${defaultBranch}..HEAD --oneline
git diff ${defaultBranch}...HEAD --stat
git diff ${defaultBranch}...HEAD
\`\`\`
If \`${defaultBranch}\` doesn't exist, try \`master\` or \`origin/main\`.`;
}

function getUncommittedDiffCommands(): string {
  return `Run these commands to see uncommitted changes:
\`\`\`bash
git status
git diff
git diff --cached
\`\`\``;
}

function getBothDiffCommands(defaultBranch: string): string {
  return `Run these commands to see all changes (branch + uncommitted):
\`\`\`bash
git log ${defaultBranch}..HEAD --oneline
git diff ${defaultBranch}...HEAD --stat
git diff ${defaultBranch}...HEAD
git status
git diff
git diff --cached
\`\`\`
If \`${defaultBranch}\` doesn't exist, try \`master\` or \`origin/main\`.`;
}

function buildDiffCommands(defaultBranch: string, reviewTarget: "branch" | "uncommitted" | "both"): string {
  switch (reviewTarget) {
    case "branch": {
      return getBranchDiffCommands(defaultBranch);
    }
    case "uncommitted": {
      return getUncommittedDiffCommands();
    }
    case "both": {
      return getBothDiffCommands(defaultBranch);
    }
  }
}

function getFirstPassFixInstructions(reviewOnly: boolean): string {
  if (reviewOnly) {
    return `## Step 4: Report Only
Do NOT make any code changes, file edits, or git commits. Only analyze and report your findings.`;
  }
  return `## Step 4: Fix Issues
For each critical and major issue, fix it using the available tools.
After each fix, verify it compiles and works.
Commit with: \`ralpix: review - fix <brief description>\``;
}

function getSecondPassFixInstructions(reviewOnly: boolean): string {
  if (reviewOnly) {
    return `## Step 4: Report Only
Do NOT make any code changes. Report remaining findings only.`;
  }
  return `## Step 4: Fix Remaining Issues
If verdict is \`NEEDS_WORK\`, fix the identified issues and commit each fix.`;
}

export function buildReviewPrompt(
  promptContent: string,
  phase: "first" | "second" | "external" | "eval",
): string {
  const lines = [
    promptContent,
    "",
    "## Completion Contract",
    "End your final response with this exact block and nothing after it:",
    "<RALPIX_REVIEW_RESULT>",
    "Success: true|false",
    "Summary: <one-line concise summary>",
    "</RALPIX_REVIEW_RESULT>",
  ];

  switch (phase) {
    case "external": {
      lines.push(
        "Use `Success: true` and put the exact review findings in `Summary`.",
        "If the review is clean, set `Summary` to exactly `NO ISSUES FOUND`.",
        "Use `Success: false` only if you cannot complete the review.",
      );
      break;
    }
    case "eval": {
      lines.push(
        "Use `Success: true` with a concise summary of what you evaluated and fixed.",
        "Include `EXTERNAL_REVIEW_DONE` in `Summary` when all findings are resolved.",
        "Use `Success: false` only if you cannot complete the evaluation.",
      );
      break;
    }
    case "first":
    case "second": {
      lines.push(
        "Use `Success: true` with a concise summary when the review pass completes.",
        "Use `Success: false` with the blocker or failure reason when you cannot complete the review.",
      );
      break;
    }
  }

  lines.push("Do not end your response without this block.");
  return lines.join("\n");
}

export function parseReviewSessionReport(text: string): ReviewSessionReport | null {
  const match = (/<ralpix_review_result>\s*([\S\s]*?)\s*<\/ralpix_review_result>/i).exec(text);
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

async function runReviewSessionOnce(
  ctx: ExtensionCommandContext,
  promptContent: string,
  phase: "first" | "second" | "external" | "eval",
  modelCfg: ModelConfig,
  piAgentDir: string | null,
  config: RalpixConfig,
  includeEffort = true,
  onProgress?: (detail: string) => void,
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void,
  timeoutMs = 30 * 60 * 1000,
): Promise<ReviewSessionReport> {
  const result = await runPiSubprocessPrompt(
    ctx.cwd,
    buildReviewPrompt(promptContent, phase),
    modelCfg,
    includeEffort,
    timeoutMs,
    createPiProgressHooks(onProgress, onUsage),
    piAgentDir,
    config,
  );

  const report = parseReviewSessionReport(result.lastAssistantText);
  if (report !== null) return report;

  const stderr = result.error.trim();
  const assistantText = result.lastAssistantText.trim();
  const isTimeout = result.exitCode === 143 || result.exitCode === 137 || result.exitCode === 9;

  if (isTimeout) {
    const partial = parseReviewSessionReport(result.lastAssistantText);
    if (partial !== null) return partial;

    let summary = `Review session timed out (exit code ${String(result.exitCode)})`;
    if (assistantText.length > 0) summary += `. Partial output: ${assistantText.slice(0, 200)}`;
    if (stderr.length > 0) summary += ` | stderr: ${stderr.slice(0, 200)}`;
    return { success: false, summary: summary.slice(0, 500) };
  }

  let detail = `pi exited with code ${String(result.exitCode)}`;
  if (assistantText.length > 0) detail = assistantText;
  if (stderr.length > 0) detail = stderr;

  return {
    success: false,
    summary: `Review session did not report a structured result. ${detail}`.slice(0, 500),
  };
}

async function runReviewSession(
  ctx: ExtensionCommandContext,
  promptContent: string,
  phase: "first" | "second" | "external" | "eval",
  modelCfg: ModelConfig,
  piAgentDir: string | null,
  config: RalpixConfig,
  includeEffort = true,
  onProgress?: (detail: string) => void,
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void,
  timeoutMs = 30 * 60 * 1000,
): Promise<ReviewSessionReport> {
  const maxRetries = config.reviewMaxRetries;
  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1 && onProgress != null) {
      onProgress(`retrying (attempt ${attempt}/${maxRetries + 1})`);
    }

    const report = await runReviewSessionOnce(
      ctx, promptContent, phase, modelCfg, piAgentDir, config, includeEffort, onProgress, onUsage,
      timeoutMs,
    );
    if (report.success) return report;

    lastError = report.summary;
    if (attempt <= maxRetries) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return { success: false, summary: lastError };
}

function stageForPhase(phase: "first" | "second" | "external" | "eval"): ReviewStageId {
  switch (phase) {
    case "first": {
      return REVIEW_STAGES.firstPass;
    }
    case "second": {
      return REVIEW_STAGES.secondPass;
    }
    case "external": {
      return REVIEW_STAGES.externalReview;
    }
    case "eval": {
      return REVIEW_STAGES.externalEval;
    }
  }
}

async function runReviewProcess(
  ctx: ExtensionCommandContext,
  promptName: "review-first" | "review-second" | "external-review" | "external-eval",
  config: RalpixConfig,
  plan: Plan,
  logger: LogWriter,
  defaultBranch: string,
  phase: "first" | "second" | "external" | "eval",
  includeEffort = true,
  extraVars?: Record<string, string>,
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void,
  timeoutMs = 30 * 60 * 1000,
  reviewOnly = false,
  diffCommands?: string,
): Promise<ReviewSessionReport> {
  const template = loadPrompt(promptName, ctx.cwd);

  const diffCommandsText = diffCommands ?? buildDiffCommands(defaultBranch, "branch");
  const fixInstructions = phase === "first"
    ? getFirstPassFixInstructions(reviewOnly)
    : (phase === "second"
      ? getSecondPassFixInstructions(reviewOnly)
      : "");

  const prompt = expandPrompt(template, {
    GOAL: plan.title,
    PROGRESS_FILE: logger.filePath,
    DEFAULT_BRANCH: defaultBranch,
    DIFF_COMMANDS: diffCommandsText,
    FIX_INSTRUCTIONS: fixInstructions,
    ...extraVars,
  });

  const phaseToModelKey = {
    first: "review-first",
    second: "review-second",
    external: REVIEW_STAGES.externalReview,
    eval: REVIEW_STAGES.externalEval,
  } as const;
  const modelCfg = resolveModel(config, phaseToModelKey[phase]);
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);
  const stage = stageForPhase(phase);
  return runReviewSession(ctx, prompt, phase, modelCfg, piAgentDir, config, includeEffort, (detail) => {
    logger.logReviewStageUpdate(stage, detail, { phase });
  }, onUsage, timeoutMs);
}

async function runFirstReview(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: LogWriter,
  defaultBranch: string,
  hooks?: ReviewPipelineHooks,
  reviewOnly = false,
  diffCommands?: string,
): Promise<string> {
  const modelCfg = resolveModel(config, "review-first");
  const effortSuffix = modelCfg.effort === null ? "" : ` — effort: ${modelCfg.effort}`;
  hooks?.onStageStart?.(REVIEW_STAGES.firstPass, "checking all completed tasks");
  logger.logReviewStageStart(REVIEW_STAGES.firstPass, "checking all completed tasks", {
    agents: 5,
    mode: reviewOnly ? "review-only" : "review-and-fix",
    ...(modelCfg.effort === null ? {} : { effort: modelCfg.effort }),
  });
  logger.logReviewStageUpdate(REVIEW_STAGES.firstPass, `started (5 agents, comprehensive)${effortSuffix}`);

  const timeoutMs = config.reviewTimeoutMs ?? 30 * 60 * 1000;
  const result = await runReviewProcess(
    ctx, "review-first", config, plan, logger, defaultBranch, "first", true, undefined, hooks?.onUsage,
    timeoutMs,
    reviewOnly,
    diffCommands,
  );

  if (result.success) {
    const detail = result.summary.slice(0, 120);
    const msg = "COMPLETE";
    logger.logReviewStageFinish(REVIEW_STAGES.firstPass, "complete", detail, { result: msg });
    hooks?.onStageFinish?.(REVIEW_STAGES.firstPass, "complete", detail);
    hooks?.onStageReport?.(REVIEW_STAGES.firstPass, result.summary);
    return msg;
  }

  const msg = `ERROR: ${result.summary.slice(0, 200)}`;
  logger.logReviewStageFinish(REVIEW_STAGES.firstPass, "failed", result.summary.slice(0, 120), { result: msg });
  hooks?.onStageFinish?.(REVIEW_STAGES.firstPass, "failed", result.summary.slice(0, 120));
  return msg;
}

async function runReviewLoop(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: LogWriter,
  defaultBranch: string,
  hooks?: ReviewPipelineHooks,
  reviewOnly = false,
  diffCommands?: string,
): Promise<string> {
  const maxIterations = config.reviewMaxIterations === 0 ? 10 : config.reviewMaxIterations;

  hooks?.onStageStart?.(REVIEW_STAGES.secondPass, `quality review — iteration 1/${maxIterations}`);
  const timeoutMs = config.reviewTimeoutMs ?? 30 * 60 * 1000;
  logger.logReviewStageStart(REVIEW_STAGES.secondPass, `quality review — iteration 1/${maxIterations}`, {
    maxIterations,
    mode: reviewOnly ? "review-only" : "review-and-fix",
  });
  logger.logReviewStageUpdate(REVIEW_STAGES.secondPass, `started (max ${maxIterations} iterations, 2 agents: quality + implementation)`);

  for (let i = 0; i < maxIterations; i++) {
    hooks?.onStageUpdate?.(REVIEW_STAGES.secondPass, `quality review — iteration ${i + 1}/${maxIterations}`);
    const headBefore = getHeadHash(ctx.cwd);
    if (headBefore.length === 0) {
      const msg = "ERROR: cannot determine HEAD hash (not a git repo?)";
      logger.logReviewStageFinish(REVIEW_STAGES.secondPass, "failed", "cannot determine git HEAD", { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "failed", "cannot determine git HEAD");
      return msg;
    }

    const modelCfg = resolveModel(config, "review-second");
    const effortInfo = modelCfg.effort === null ? "" : ` (effort: ${modelCfg.effort})`;
    logger.logReviewStageUpdate(REVIEW_STAGES.secondPass, `iteration ${i + 1}/${maxIterations} — running review...${effortInfo}`);

    const result = await runReviewProcess(
      ctx, "review-second", config, plan, logger, defaultBranch, "second", true, undefined, hooks?.onUsage,
      timeoutMs,
      reviewOnly,
      diffCommands,
    );

    if (!result.success) {
      const msg = `ERROR: ${result.summary.slice(0, 200)}`;
      logger.logReviewStageFinish(REVIEW_STAGES.secondPass, "failed", result.summary.slice(0, 120), { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "failed", result.summary.slice(0, 120));
      return msg;
    }

    if (reviewOnly) {
      const msg = "COMPLETE (review-only) — findings reported";
      logger.logReviewStageFinish(REVIEW_STAGES.secondPass, "complete", "review-only pass complete", { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "complete", "review-only pass complete");
      hooks?.onStageReport?.(REVIEW_STAGES.secondPass, result.summary);
      return msg;
    }

    const headAfter = getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      const msg = `COMPLETE (iteration ${i + 1}) — no changes, review clean`;
      logger.logReviewStageFinish(REVIEW_STAGES.secondPass, "complete", `review clean at iteration ${i + 1}`, { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "complete", `review clean at iteration ${i + 1}`);
      hooks?.onStageReport?.(REVIEW_STAGES.secondPass, result.summary);
      return msg;
    }

    hooks?.onStageUpdate?.(REVIEW_STAGES.secondPass, `fixes applied in iteration ${i + 1}`);
    logger.logReviewStageUpdate(
      REVIEW_STAGES.secondPass,
      `iteration ${i + 1}: fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}), continuing...`,
    );
  }

  const msg = `MAX_ITERATIONS (${maxIterations}) — review loop exhausted`;
  logger.logReviewStageFinish(REVIEW_STAGES.secondPass, "complete", `max iterations reached (${maxIterations})`, {
    result: msg,
  });
  hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "complete", `max iterations reached (${maxIterations})`);
  return msg;
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function runExternalReviewLoop(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: LogWriter,
  defaultBranch: string,
  hooks?: ReviewPipelineHooks,
  reviewOnly = false,
  diffCommands?: string,
): Promise<string> {
  const maxIterations = config.externalReviewMaxIterations === 0 ? 10 : config.externalReviewMaxIterations;
  const patience = config.externalReviewPatience === 0 ? 3 : config.externalReviewPatience;

  const externalModelCfg = resolveModel(config, "external-review");
  const reviewerLabel =
    buildSessionModelChange(externalModelCfg)?.model ??
    externalModelCfg.model ??
    externalModelCfg.provider;

  if ((reviewerLabel ?? "").length === 0) {
    const msg = "SKIPPED — no model configured (externalReviewModel/defaultModel)";
    logger.logReviewStageFinish(REVIEW_STAGES.externalReview, "skipped", "no external model configured", { result: msg });
    logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "skipped", "no findings to evaluate");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "skipped", "no external model configured");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "no findings to evaluate");
    return msg;
  }
  const reviewerName = reviewerLabel ?? "(default)";
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);
  const timeoutMs = config.reviewTimeoutMs ?? 30 * 60 * 1000;

  logger.logReviewStageStart(REVIEW_STAGES.externalReview, `auditing changes — iteration 1/${maxIterations}`, {
    reviewer: reviewerName,
    maxIterations,
    patience,
    mode: reviewOnly ? "review-only" : "review-and-fix",
  });
  logger.logReviewStageUpdate(
    REVIEW_STAGES.externalReview,
    `started (reviewer: ${reviewerName}, max ${maxIterations} iterations, patience: ${patience})`,
  );

  let unchangedRounds = 0;
  let previousFindings = "";
  let lastReviewHead = "";

  for (let i = 0; i < maxIterations; i++) {
    hooks?.onStageStart?.(REVIEW_STAGES.externalReview, `auditing changes — iteration ${i + 1}/${maxIterations}`);

    const reviewTemplate = loadPrompt("external-review", ctx.cwd);
    const diffCommandsText = (() => {
      if (lastReviewHead.length > 0) {
        return `Run these commands to see the latest fix changes:
\`\`\`bash
git diff ${lastReviewHead}..HEAD --stat
git diff ${lastReviewHead}..HEAD
\`\`\``;
      }
      return diffCommands ?? buildDiffCommands(defaultBranch, "branch");
    })();
    let reviewPrompt = expandPrompt(reviewTemplate, {
      GOAL: plan.title,
      DEFAULT_BRANCH: defaultBranch,
      PROGRESS_FILE: logger.filePath,
      DIFF_COMMANDS: diffCommandsText,
    });

    if (previousFindings.length > 0) {
      reviewPrompt += [
        `\n## Previous Review Findings\n\n${previousFindings}\n\n`,
        "**Guidance for this round:**",
        "- The diff above shows only the latest fix changes (not the full branch).",
        "- **Re-verify** each previous finding by reading the relevant file(s) with the `read` tool.",
        "- Re-report unresolved issues, skip resolved or inaccurate ones, and add any new issues you find.",
        "- If everything is clean, report `NO ISSUES FOUND`.",
      ].join("\n");
    }

    logger.logReviewStageUpdate(REVIEW_STAGES.externalReview, `iteration ${i + 1}/${maxIterations} — running external reviewer...`);

    const reviewResult = await runReviewSession(
      ctx,
      reviewPrompt,
      "external",
      externalModelCfg,
      piAgentDir,
      config,
      true,
      undefined,
      hooks?.onUsage,
      timeoutMs,
    );
    if (!reviewResult.success) {
      const msg = `ERROR: ${reviewResult.summary.slice(0, 200)}`;
      logger.logReviewStageFinish(REVIEW_STAGES.externalReview, "failed", reviewResult.summary.slice(0, 120), { result: msg });
      logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "failed", "external reviewer failed");
      hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "failed", reviewResult.summary.slice(0, 120));
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "failed", "external reviewer failed");
      return msg;
    }

    const findings = reviewResult.summary.trim();
    if (findings.length === 0 || (/^no issues found$/i).test(findings) || findings.length < 10) {
      const msg = `COMPLETE (iteration ${i + 1}) — no issues found`;
      logger.logReviewStageFinish(REVIEW_STAGES.externalReview, "complete", "no issues found", { result: msg });
      logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "skipped", "no findings to evaluate");
      hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "complete", "no issues found");
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "no findings to evaluate");
      hooks?.onStageReport?.(REVIEW_STAGES.externalReview, findings);
      return msg;
    }

    logger.logReviewStageFinish(REVIEW_STAGES.externalReview, "complete", `findings reported in iteration ${i + 1}`);
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "complete", `findings reported in iteration ${i + 1}`);
    hooks?.onStageReport?.(REVIEW_STAGES.externalReview, findings);
    previousFindings = findings;
    lastReviewHead = getHeadHash(ctx.cwd);

    if (reviewOnly) {
      const msg = "COMPLETE (review-only) — findings reported, no fixes applied";
      logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "skipped", "review-only mode", { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "review-only mode");
      return msg;
    }

    const headBefore = getHeadHash(ctx.cwd);
    hooks?.onStageStart?.(REVIEW_STAGES.externalEval, `fixing findings — iteration ${i + 1}/${maxIterations}`);
    logger.logReviewStageStart(REVIEW_STAGES.externalEval, `fixing findings — iteration ${i + 1}/${maxIterations}`);
    logger.logReviewStageUpdate(REVIEW_STAGES.externalEval, `iteration ${i + 1} — evaluating findings...`);

    const evalResult = await runReviewProcess(
      ctx,
      "external-eval",
      config,
      plan,
      logger,
      defaultBranch,
      "eval",
      true,
      { FINDINGS: findings },
      hooks?.onUsage,
      timeoutMs,
    );

    if (!evalResult.success) {
      const msg = `ERROR: ${evalResult.summary.slice(0, 200)}`;
      logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "failed", evalResult.summary.slice(0, 120), { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "failed", evalResult.summary.slice(0, 120));
      return msg;
    }

    if (evalResult.summary.includes("EXTERNAL_REVIEW_DONE")) {
      const msg = `COMPLETE (iteration ${i + 1}) — all findings resolved`;
      logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "complete", "all findings resolved", { result: msg });
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", "all findings resolved");
      return msg;
    }

    const headAfter = getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      unchangedRounds++;
      logger.logReviewStageUpdate(REVIEW_STAGES.externalEval, `no changes (${unchangedRounds}/${patience} stalemate rounds)`);
      hooks?.onStageUpdate?.(REVIEW_STAGES.externalEval, `stalemate ${unchangedRounds}/${patience}`);

      if (unchangedRounds >= patience) {
        const msg = `STALEMATE — ${patience} rounds without changes`;
        logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "complete", `stalemate after ${patience} rounds`, { result: msg });
        hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", `stalemate after ${patience} rounds`);
        return msg;
      }
    } else {
      unchangedRounds = 0;
      logger.logReviewStageUpdate(REVIEW_STAGES.externalEval, `fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`);
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", `fixes applied in iteration ${i + 1}`);
      logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "complete", `fixes applied in iteration ${i + 1}`);
    }
  }

  const msg = `MAX_ITERATIONS (${maxIterations})`;
  logger.logReviewStageFinish(REVIEW_STAGES.externalReview, "complete", `max iterations reached (${maxIterations})`, {
    result: msg,
  });
  logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "complete", `max iterations reached (${maxIterations})`);
  hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "complete", `max iterations reached (${maxIterations})`);
  hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", `max iterations reached (${maxIterations})`);
  return msg;
}

export async function runReviewPipeline(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  plan: Plan,
  config: RalpixConfig,
  logger: LogWriter,
  hooks?: ReviewPipelineHooks,
  reviewOnly = false,
  diffCommands?: string,
): Promise<{ firstResult: string; externalResult: string; loopResult: string }> {
  logger.logReviewStart({
    goal: plan.title,
    planPath: plan.path,
    mode: reviewOnly ? "review-only" : "review-and-fix",
  });

  if (!config.reviewEnabled) {
    const msg = "SKIPPED (review disabled)";
    logger.logReviewComplete({ status: "skipped", reason: REVIEW_DISABLED_REASON });
    hooks?.onStageFinish?.(REVIEW_STAGES.firstPass, "skipped", REVIEW_DISABLED_REASON);
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "skipped", REVIEW_DISABLED_REASON);
    hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", REVIEW_DISABLED_REASON);
    hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "skipped", REVIEW_DISABLED_REASON);
    return { firstResult: msg, externalResult: msg, loopResult: msg };
  }

  const defaultBranch = detectDefaultBranch(ctx.cwd);

  const firstResult = await runFirstReview(
    ctx, config, plan, logger, defaultBranch, hooks, reviewOnly, diffCommands,
  );

  let externalResult = "SKIPPED (disabled)";
  if (config.externalReviewEnabled) {
    externalResult = await runExternalReviewLoop(
      ctx, config, plan, logger, defaultBranch, hooks, reviewOnly, diffCommands,
    );
  } else {
    logger.logReviewStageFinish(REVIEW_STAGES.externalReview, "skipped", "external review disabled");
    logger.logReviewStageFinish(REVIEW_STAGES.externalEval, "skipped", "external review disabled");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "skipped", "external review disabled");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "external review disabled");
  }

  const loopResult = await runReviewLoop(ctx, config, plan, logger, defaultBranch, hooks, reviewOnly, diffCommands);
  logger.logReviewComplete({ status: "complete", firstResult, externalResult, loopResult });

  return { firstResult, externalResult, loopResult };
}

// ---------------------------------------------------------------------------
// Standalone review (no plan required)
// ---------------------------------------------------------------------------

export async function runStandaloneReview(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  config: RalpixConfig,
  reviewTarget: "branch" | "uncommitted" | "both",
  reviewOnly: boolean,
): Promise<{ firstResult: string; externalResult: string; loopResult: string }> {
  const defaultBranch = detectDefaultBranch(ctx.cwd);
  const currentBranch = getCurrentBranch(ctx.cwd) ?? "current";

  const targetLabel = reviewTarget === "branch"
    ? `branch ${currentBranch}`
    : (reviewTarget === "uncommitted"
      ? "uncommitted changes"
      : "branch + uncommitted changes");
  const modeLabel = reviewOnly ? "Review-only" : "Review + fix";
  const title = `${modeLabel}: ${targetLabel}`;

  const timestamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const stem = `review-${timestamp}-${currentBranch.replaceAll("/", "-")}`;
  const logger = new LogWriter(ctx.cwd, stem);

  const plan: Plan = {
    path: "",
    title,
    overview: "",
    context: "",
    successCriteria: [],
    tasks: [],
    extraSections: {},
  };

  const diffCommands = buildDiffCommands(defaultBranch, reviewTarget);

  // ---- TUI ----------------------------------------------------------------
  const ledger = createTokenLedger();
  const progressTui = createProgressTui(ctx, "ralpix-review", `ralpix: ${title}`);
  progressTui.setPhase("reviewing");
  progressTui.refresh();

  const stageLedgers = new Map<ReviewStageId, ReturnType<typeof createTokenLedger>>();
  const stageReports = new Map<ReviewStageId, string>();
  let activeStage: ReviewStageId | null = null;

  const recordUsage = (provider: string, model: string, usage: SubprocessUsage): void => {
    ledger.add(provider, model, usage);
    progressTui.setTotalUsage(ledger.snapshot());
    if (activeStage !== null) {
      const stageLedger = stageLedgers.get(activeStage) ?? createTokenLedger();
      stageLedger.add(provider, model, usage);
      stageLedgers.set(activeStage, stageLedger);
    }
    progressTui.refresh();
  };

  const pushReportStep = (_stage: ReviewStageId, report: string): void => {
    const trimmed = report.trim();
    if (trimmed.length === 0) return;
    // Truncate to TUI-friendly chunks; full text goes in the notification
    const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
    const lines = preview.split("\n").filter((line) => line.trim().length > 0).slice(0, 6);
    if (lines.length === 0) return;
    for (const line of lines) {
      progressTui.pushStep({ title: line });
    }
    progressTui.refresh();
  };

  const hooks: ReviewPipelineHooks = {
    onStageStart(stage, detail) {
      activeStage = stage;
      stageLedgers.set(stage, createTokenLedger());
      const label = REVIEW_STAGE_LABELS[stage];
      const detailText = detail != null && detail.length > 0 ? ` — ${detail}` : "";
      progressTui.setCurrent(`${label}${detailText}`);
      progressTui.refresh();
    },
    onStageUpdate(stage, detail) {
      activeStage = stage;
      const label = REVIEW_STAGE_LABELS[stage];
      const detailText = detail.length > 0 ? ` — ${detail}` : "";
      progressTui.setCurrent(`${label}${detailText}`);
      progressTui.refresh();
    },
    onStageFinish(stage, status, detail) {
      activeStage = null;
      const stageLedger = stageLedgers.get(stage);
      const stepUsage = stageLedger?.snapshot();
      const detailedStepUsage = stageLedger?.detailedSnapshot();
      const lines = stageLedger?.usageLines() ?? [];
      const label = REVIEW_STAGE_LABELS[stage];
      const statusSuffix = status === "failed" ? " (failed)" : "";
      const detailSuffix = detail != null && detail.length > 0 ? ` — ${detail}` : "";
      if (detailedStepUsage !== undefined) {
        logger.logReviewStepUsage(stage, detailedStepUsage, ledger.detailedSnapshot(), stageLedger?.breakdown() ?? []);
      }
      const step: ProgressStep = {
        title: `${label}${statusSuffix}${detailSuffix}`,
        ...(stepUsage === undefined ? {} : { usageSummary: stepUsage }),
        ...(lines.length > 0 ? { usageLines: lines } : {}),
      };
      progressTui.pushStep(step);
      const report = stageReports.get(stage);
      if (report !== undefined) {
        pushReportStep(stage, report);
      }
      progressTui.setCurrent("");
      progressTui.refresh();
      stageLedgers.delete(stage);
    },
    onStageReport(stage, report) {
      stageReports.set(stage, report);
    },
    onUsage: recordUsage,
  };

  const result = await runReviewPipeline(ctx, _pi, plan, config, logger, hooks, reviewOnly, diffCommands);

  // ---- Finalize TUI -------------------------------------------------------
  const totalLines = ledger.usageLines();
  progressTui.pushStep({
    title: `Review complete — ${modeLabel}`,
    usageSummary: ledger.snapshot(),
    ...(totalLines.length > 0 ? { usageLines: totalLines } : {}),
  });
  progressTui.setPhase("complete");
  progressTui.setCurrent("");
  progressTui.refresh();

  // ---- Build rich notification with findings --------------------------------
  const reportParts: string[] = [];
  for (const stage of ["first-pass", "external-review", "second-pass"] as ReviewStageId[]) {
    const report = stageReports.get(stage);
    if (report !== undefined && report.trim().length > 0) {
      reportParts.push(`\n--- ${REVIEW_STAGE_LABELS[stage]} ---\n${report.trim()}`);
    }
  }

  const summaryLines = [
    `Review complete: ${title}`,
    `  First pass:     ${result.firstResult}`,
    `  External audit: ${result.externalResult}`,
    `  Second pass:    ${result.loopResult}`,
    `  Log:            ${logger.filePath}`,
  ];

  const notifyText = reportParts.length > 0
    ? `${summaryLines.join("\n")}\n${reportParts.join("\n")}`
    : summaryLines.join("\n");
  ctx.ui.notify(notifyText, "success");

  return result;
}
