/**
 * Review pipeline — first pass + external review + iterative loop.
 */

import { execSync } from "node:child_process";

import { Type } from "typebox";

import { applyModelConfigToSession, buildSessionModelChange, resolveModel } from "./config.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

import type { ProgressLogger } from "./logger.js";
import type { ModelConfig, Plan, RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext, SessionContext } from "@earendil-works/pi-coding-agent";

interface ReviewSessionReport {
  success: boolean;
  summary: string;
}

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

function buildReviewPrompt(
  promptContent: string,
  phase: "first" | "second" | "external" | "eval",
): string {
  const lines = [
    promptContent,
    "",
    "## Completion Contract",
    "Before finishing, call `ralpix_report_review_result` exactly once.",
  ];

  switch (phase) {
    case "external": {
      lines.push(
        "Use `success: true` and put the exact review findings in `summary`.",
        "If the review is clean, set `summary` to exactly `NO ISSUES FOUND`.",
        "Use `success: false` only if you cannot complete the review.",
      );
      break;
    }
    case "eval": {
      lines.push(
        "Use `success: true` with a concise summary of what you evaluated and fixed.",
        "Include `EXTERNAL_REVIEW_DONE` in `summary` when all findings are resolved.",
        "Use `success: false` only if you cannot complete the evaluation.",
      );
      break;
    }
    case "first":
    case "second": {
      lines.push(
        "Use `success: true` with a concise summary when the review pass completes.",
        "Use `success: false` with the blocker or failure reason when you cannot complete the review.",
      );
      break;
    }
  }

  lines.push("Do not end the session without calling this tool.");
  return lines.join("\n");
}

async function runReviewSession(
  ctx: ExtensionCommandContext,
  promptContent: string,
  phase: "first" | "second" | "external" | "eval",
  modelCfg: ModelConfig,
  includeEffort = true,
): Promise<ReviewSessionReport> {
  const state: { report?: ReviewSessionReport } = {};

  await ctx.newSession({
    setup: (sm) => applyModelConfigToSession(sm, modelCfg, includeEffort),
    withSession: async (reviewCtx: SessionContext) => {
      reviewCtx.registerTool({
        name: "ralpix_report_review_result",
        label: "Report Review Result",
        description: "Report the final review status and concise summary.",
        promptSnippet: "Report review result: {{summary}}",
        /* eslint-disable @typescript-eslint/no-unsafe-assignment */
        parameters: Type.Object({
          success: Type.Boolean({
            description: "True when the review completed, false when blocked or failed.",
          }),
          summary: Type.String({
            description: "Short outcome summary or failure reason.",
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
              { type: "text", text: "Review result recorded." },
            ],
          };
        },
      });

      await reviewCtx.sendUserMessage(buildReviewPrompt(promptContent, phase));
      await reviewCtx.waitForIdle();
    },
  });

  return state.report ?? {
    success: false,
    summary: "Session ended without reporting a review result.",
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
    external: "external-review",
    eval: "external-eval",
  } as const;
  const modelCfg = resolveModel(config, phaseToModelKey[phase]);
  return runReviewSession(ctx, prompt, phase, modelCfg, includeEffort);
}

async function runFirstReview(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
): Promise<string> {
  const modelCfg = resolveModel(config, "review-first");
  const effortSuffix = modelCfg.effort === null ? "" : ` — effort: ${modelCfg.effort}`;
  logger.logReview("first", `STARTED (5 agents, comprehensive)${effortSuffix}`);

  const result = await runReviewProcess(
    ctx, "review-first", config, plan, logger, defaultBranch, "first",
  );

  if (result.success) {
    const msg = "COMPLETE";
    logger.logReview("first", msg);
    return msg;
  }

  const msg = `ERROR: ${result.summary.slice(0, 200)}`;
  logger.logReview("first", msg);
  return msg;
}

async function runReviewLoop(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
): Promise<string> {
  const maxIterations = config.reviewMaxIterations === 0 ? 5 : config.reviewMaxIterations;

  logger.logReview("loop", `STARTED (max ${maxIterations} iterations, 2 agents: quality + implementation)`);

  for (let i = 0; i < maxIterations; i++) {
    const headBefore = getHeadHash(ctx.cwd);
    if (headBefore.length === 0) {
      const msg = "ERROR: cannot determine HEAD hash (not a git repo?)";
      logger.logReview("loop", msg);
      return msg;
    }

    const modelCfg = resolveModel(config, "review-second");
    const effortInfo = modelCfg.effort === null ? "" : ` (effort: ${modelCfg.effort})`;
    logger.logReview("loop", `Iteration ${i + 1}/${maxIterations} — running review...${effortInfo}`);

    const result = await runReviewProcess(
      ctx, "review-second", config, plan, logger, defaultBranch, "second",
    );

    if (!result.success) {
      const msg = `ERROR: ${result.summary.slice(0, 200)}`;
      logger.logReview("loop", msg);
      return msg;
    }

    const headAfter = getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      const msg = `COMPLETE (iteration ${i + 1}) — no changes, review clean`;
      logger.logReview("loop", msg);
      return msg;
    }

    logger.logReview(
      "loop",
      `Iteration ${i + 1}: fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}), continuing...`,
    );
  }

  const msg = `MAX_ITERATIONS (${maxIterations}) — review loop exhausted`;
  logger.logReview("loop", msg);
  return msg;
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function runExternalReviewLoop(
  ctx: ExtensionCommandContext,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
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
    return msg;
  }
  const reviewerName = reviewerLabel ?? "(default)";

  logger.logExternalReview(
    "loop",
    `STARTED (reviewer: ${reviewerName}, max ${maxIterations} iterations, patience: ${patience})`,
  );

  let unchangedRounds = 0;
  let previousFindings = "";
  let lastReviewHead = "";

  for (let i = 0; i < maxIterations; i++) {
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

    const reviewResult = await runReviewSession(ctx, reviewPrompt, "external", externalModelCfg);
    if (!reviewResult.success) {
      const msg = `ERROR: ${reviewResult.summary.slice(0, 200)}`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    const findings = reviewResult.summary.trim();
    if (findings.length === 0 || (/^no issues found$/i).test(findings) || findings.length < 10) {
      const msg = `COMPLETE (iteration ${i + 1}) — no issues found`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    previousFindings = findings;
    lastReviewHead = getHeadHash(ctx.cwd);

    const headBefore = getHeadHash(ctx.cwd);
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
    );

    if (!evalResult.success) {
      const msg = `ERROR: ${evalResult.summary.slice(0, 200)}`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    if (evalResult.summary.includes("EXTERNAL_REVIEW_DONE")) {
      const msg = `COMPLETE (iteration ${i + 1}) — all findings resolved`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    const headAfter = getHeadHash(ctx.cwd);
    if (headAfter === headBefore) {
      unchangedRounds++;
      logger.logExternalReview("eval", `no changes (${unchangedRounds}/${patience} stalemate rounds)`);

      if (unchangedRounds >= patience) {
        const msg = `STALEMATE — ${patience} rounds without changes`;
        logger.logExternalReview("eval", msg);
        return msg;
      }
    } else {
      unchangedRounds = 0;
      logger.logExternalReview("eval", `fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`);
    }
  }

  const msg = `MAX_ITERATIONS (${maxIterations})`;
  logger.logExternalReview("loop", msg);
  return msg;
}

export async function runReviewPipeline(
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  plan: Plan,
  config: RalpixConfig,
  logger: ProgressLogger,
): Promise<{ firstResult: string; externalResult: string; loopResult: string }> {
  if (!config.reviewEnabled) {
    const msg = "SKIPPED (review disabled)";
    logger.logReview("first", msg);
    logger.logReview("loop", msg);
    return { firstResult: msg, externalResult: msg, loopResult: msg };
  }

  const defaultBranch = detectDefaultBranch(ctx.cwd);

  const firstResult = await runFirstReview(ctx, config, plan, logger, defaultBranch);

  let externalResult = "SKIPPED (disabled)";
  if (config.externalReviewEnabled) {
    externalResult = await runExternalReviewLoop(ctx, config, plan, logger, defaultBranch);
  } else {
    logger.logExternalReview("loop", "SKIPPED (externalReviewEnabled: false)");
  }

  const loopResult = await runReviewLoop(ctx, config, plan, logger, defaultBranch);

  return { firstResult, externalResult, loopResult };
}
