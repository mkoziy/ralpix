/**
 * Review pipeline — first pass + external review + iterative loop.
 */

import { execSync } from "node:child_process";

import { buildSessionModelChange, resolveModel, resolvePiAgentDir } from "./config.js";
import { createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

import type { ProgressLogger } from "./logger.js";
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
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
}

const REVIEW_STAGES = {
  firstPass: "first-pass",
  secondPass: "second-pass",
  externalReview: "external-review",
  externalEval: "external-eval",
} as const;

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
): Promise<ReviewSessionReport> {
  const result = await runPiSubprocessPrompt(
    ctx.cwd,
    buildReviewPrompt(promptContent, phase),
    modelCfg,
    includeEffort,
    30 * 60 * 1000,
    createPiProgressHooks(onProgress, onUsage),
    piAgentDir,
    config,
  );
  const report = parseReviewSessionReport(result.lastAssistantText);
  if (report !== null) return report;

  const stderr = result.error.trim();
  const assistantText = result.lastAssistantText.trim();
  let detail = `pi exited with code ${String(result.exitCode)}`;
  if (assistantText.length > 0) detail = assistantText;
  if (stderr.length > 0) detail = stderr;

  return {
    success: false,
    summary: `Review session did not report a structured result. ${detail}`.slice(0, 500),
  };
}

async function runReviewProcess(
  ctx: ExtensionCommandContext,
  promptName: "review-first" | "review-second" | "external-review" | "external-eval",
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  phase: "first" | "second" | "external" | "eval",
  includeEffort = true,
  extraVars?: Record<string, string>,
  onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void,
): Promise<ReviewSessionReport> {
  const template = loadPrompt(promptName, ctx.cwd);
  const prompt = expandPrompt(template, {
    GOAL: plan.title,
    PROGRESS_FILE: logger.filePath,
    DEFAULT_BRANCH: defaultBranch,
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
  return runReviewSession(ctx, prompt, phase, modelCfg, piAgentDir, config, includeEffort, (detail) => {
    logger.logReview("loop", `${phase}: ${detail}`);
  }, onUsage);
}

async function runFirstReview(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  hooks?: ReviewPipelineHooks,
): Promise<string> {
  const modelCfg = resolveModel(config, "review-first");
  const effortSuffix = modelCfg.effort === null ? "" : ` — effort: ${modelCfg.effort}`;
  hooks?.onStageStart?.(REVIEW_STAGES.firstPass, "checking all completed tasks");
  logger.logReview("first", `STARTED (5 agents, comprehensive)${effortSuffix}`);

  const result = await runReviewProcess(
    ctx, "review-first", config, plan, logger, defaultBranch, "first", true, undefined, hooks?.onUsage,
  );

  if (result.success) {
    const detail = result.summary.slice(0, 120);
    const msg = "COMPLETE";
    logger.logReview("first", msg);
    hooks?.onStageFinish?.(REVIEW_STAGES.firstPass, "complete", detail);
    return msg;
  }

  const msg = `ERROR: ${result.summary.slice(0, 200)}`;
  logger.logReview("first", msg);
  hooks?.onStageFinish?.(REVIEW_STAGES.firstPass, "failed", result.summary.slice(0, 120));
  return msg;
}

async function runReviewLoop(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  hooks?: ReviewPipelineHooks,
): Promise<string> {
  const maxIterations = config.reviewMaxIterations === 0 ? 5 : config.reviewMaxIterations;

  hooks?.onStageStart?.(REVIEW_STAGES.secondPass, `quality review — iteration 1/${maxIterations}`);
  logger.logReview("loop", `STARTED (max ${maxIterations} iterations, 2 agents: quality + implementation)`);

  for (let i = 0; i < maxIterations; i++) {
    hooks?.onStageUpdate?.(REVIEW_STAGES.secondPass, `quality review — iteration ${i + 1}/${maxIterations}`);
    const headBefore = getHeadHash(ctx.cwd);
    if (headBefore.length === 0) {
      const msg = "ERROR: cannot determine HEAD hash (not a git repo?)";
      logger.logReview("loop", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "failed", "cannot determine git HEAD");
      return msg;
    }

    const modelCfg = resolveModel(config, "review-second");
    const effortInfo = modelCfg.effort === null ? "" : ` (effort: ${modelCfg.effort})`;
    logger.logReview("loop", `Iteration ${i + 1}/${maxIterations} — running review...${effortInfo}`);

    const result = await runReviewProcess(
      ctx, "review-second", config, plan, logger, defaultBranch, "second", true, undefined, hooks?.onUsage,
    );

    if (!result.success) {
      const msg = `ERROR: ${result.summary.slice(0, 200)}`;
      logger.logReview("loop", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "failed", result.summary.slice(0, 120));
      return msg;
    }

    const headAfter = getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      const msg = `COMPLETE (iteration ${i + 1}) — no changes, review clean`;
      logger.logReview("loop", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "complete", `review clean at iteration ${i + 1}`);
      return msg;
    }

    hooks?.onStageUpdate?.(REVIEW_STAGES.secondPass, `fixes applied in iteration ${i + 1}`);
    logger.logReview(
      "loop",
      `Iteration ${i + 1}: fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}), continuing...`,
    );
  }

  const msg = `MAX_ITERATIONS (${maxIterations}) — review loop exhausted`;
  logger.logReview("loop", msg);
  hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "complete", `max iterations reached (${maxIterations})`);
  return msg;
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function runExternalReviewLoop(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  hooks?: ReviewPipelineHooks,
): Promise<string> {
  const maxIterations = config.externalReviewMaxIterations === 0 ? 5 : config.externalReviewMaxIterations;
  const patience = config.externalReviewPatience === 0 ? 3 : config.externalReviewPatience;

  const externalModelCfg = resolveModel(config, "external-review");
  const reviewerLabel =
    buildSessionModelChange(externalModelCfg)?.model ??
    externalModelCfg.model ??
    externalModelCfg.provider;

  if ((reviewerLabel ?? "").length === 0) {
    const msg = "SKIPPED — no model configured (externalReviewModel/defaultModel)";
    logger.logExternalReview("loop", msg);
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "skipped", "no external model configured");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "no findings to evaluate");
    return msg;
  }
  const reviewerName = reviewerLabel ?? "(default)";
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);

  logger.logExternalReview(
    "loop",
    `STARTED (reviewer: ${reviewerName}, max ${maxIterations} iterations, patience: ${patience})`,
  );

  let unchangedRounds = 0;
  let previousFindings = "";
  let lastReviewHead = "";

  for (let i = 0; i < maxIterations; i++) {
    hooks?.onStageStart?.(REVIEW_STAGES.externalReview, `auditing changes — iteration ${i + 1}/${maxIterations}`);
    const diffInstruction = lastReviewHead.length > 0
      ? `Run: \`git diff ${lastReviewHead}..HEAD\` to see the latest fix changes.`
      : `Run: \`git diff ${defaultBranch}...HEAD\` to see all changes in this branch.`;

    const reviewTemplate = loadPrompt("external-review", ctx.cwd);
    let reviewPrompt = expandPrompt(reviewTemplate, {
      GOAL: plan.title,
      DEFAULT_BRANCH: defaultBranch,
      PROGRESS_FILE: logger.filePath,
      DIFF_INSTRUCTION: diffInstruction,
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

    logger.logExternalReview("review", `Iteration ${i + 1}/${maxIterations} — running external reviewer...`);

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
    );
    if (!reviewResult.success) {
      const msg = `ERROR: ${reviewResult.summary.slice(0, 200)}`;
      logger.logExternalReview("review", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "failed", reviewResult.summary.slice(0, 120));
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "failed", "external reviewer failed");
      return msg;
    }

    const findings = reviewResult.summary.trim();
    if (findings.length === 0 || (/^no issues found$/i).test(findings) || findings.length < 10) {
      const msg = `COMPLETE (iteration ${i + 1}) — no issues found`;
      logger.logExternalReview("review", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "complete", "no issues found");
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "no findings to evaluate");
      return msg;
    }

    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "complete", `findings reported in iteration ${i + 1}`);
    previousFindings = findings;
    lastReviewHead = getHeadHash(ctx.cwd);

    const headBefore = getHeadHash(ctx.cwd);
    hooks?.onStageStart?.(REVIEW_STAGES.externalEval, `fixing findings — iteration ${i + 1}/${maxIterations}`);
    logger.logExternalReview("eval", `Iteration ${i + 1} — evaluating findings...`);

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
    );

    if (!evalResult.success) {
      const msg = `ERROR: ${evalResult.summary.slice(0, 200)}`;
      logger.logExternalReview("eval", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "failed", evalResult.summary.slice(0, 120));
      return msg;
    }

    if (evalResult.summary.includes("EXTERNAL_REVIEW_DONE")) {
      const msg = `COMPLETE (iteration ${i + 1}) — all findings resolved`;
      logger.logExternalReview("eval", msg);
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", "all findings resolved");
      return msg;
    }

    const headAfter = getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      unchangedRounds++;
      logger.logExternalReview("eval", `no changes (${unchangedRounds}/${patience} stalemate rounds)`);
      hooks?.onStageUpdate?.(REVIEW_STAGES.externalEval, `stalemate ${unchangedRounds}/${patience}`);

      if (unchangedRounds >= patience) {
        const msg = `STALEMATE — ${patience} rounds without changes`;
        logger.logExternalReview("eval", msg);
        hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", `stalemate after ${patience} rounds`);
        return msg;
      }
    } else {
      unchangedRounds = 0;
      logger.logExternalReview("eval", `fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`);
      hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", `fixes applied in iteration ${i + 1}`);
    }
  }

  const msg = `MAX_ITERATIONS (${maxIterations})`;
  logger.logExternalReview("loop", msg);
  hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "complete", `max iterations reached (${maxIterations})`);
  hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "complete", `max iterations reached (${maxIterations})`);
  return msg;
}

export async function runReviewPipeline(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  plan: Plan,
  config: RalpixConfig,
  logger: ProgressLogger,
  hooks?: ReviewPipelineHooks,
): Promise<{ firstResult: string; externalResult: string; loopResult: string }> {
  if (!config.reviewEnabled) {
    const msg = "SKIPPED (review disabled)";
    logger.logReview("first", msg);
    logger.logReview("loop", msg);
    hooks?.onStageFinish?.(REVIEW_STAGES.firstPass, "skipped", "review disabled");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "skipped", "review disabled");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "review disabled");
    hooks?.onStageFinish?.(REVIEW_STAGES.secondPass, "skipped", "review disabled");
    return { firstResult: msg, externalResult: msg, loopResult: msg };
  }

  const defaultBranch = detectDefaultBranch(ctx.cwd);

  const firstResult = await runFirstReview(ctx, config, plan, logger, defaultBranch, hooks);

  let externalResult = "SKIPPED (disabled)";
  if (config.externalReviewEnabled) {
    externalResult = await runExternalReviewLoop(ctx, config, plan, logger, defaultBranch, hooks);
  } else {
    logger.logExternalReview("loop", "SKIPPED (externalReviewEnabled: false)");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalReview, "skipped", "external review disabled");
    hooks?.onStageFinish?.(REVIEW_STAGES.externalEval, "skipped", "external review disabled");
  }

  const loopResult = await runReviewLoop(ctx, config, plan, logger, defaultBranch, hooks);

  return { firstResult, externalResult, loopResult };
}
