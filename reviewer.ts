/**
 * Review pipeline — first pass + external review + iterative loop.
 *
 * Phase 1 (first):      One-shot comprehensive review — all 5 agents, review-first.md.
 * Phase 2.5 (external):  External review loop — different model reviews, main model fixes.
 *                        Iterates until clean, stalemate, or max iterations.
 * Phase 3 (loop):        Iterative critical/major review — 2 agents, review-second.md.
 *                        Repeats while HEAD changes, up to reviewMaxIterations.
 *
 * Pattern follows ralphex: runClaudeReview → runExternalReviewLoop → runClaudeReviewLoop.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadPrompt, expandPrompt } from "./prompt.js";
import { THINKING_LEVELS } from "./types.js";

import type { ProgressLogger } from "./logger.js";
import type { Plan, RalpixConfig, ThinkingLevel } from "./types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPiExecutable(): { command: string; args: string[] } {
  const currentScript: string | undefined = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (typeof currentScript === "string" && currentScript.length > 0 && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

async function writeTempFile(prefix: string, content: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ralpix-review-"));
  const filePath = path.join(tmpDir, `${prefix}.md`);
  await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
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

// ---------------------------------------------------------------------------
// Effort helpers
// ---------------------------------------------------------------------------

function isValidEffort(effort: unknown): effort is ThinkingLevel {
  return typeof effort === "string" && (THINKING_LEVELS as readonly string[]).includes(effort);
}

function isUnsupportedEffortError(stderr: string): boolean {
  return (/unsupported.*(?:thinking|effort|reasoning)/i).test(stderr) ||
    (/thinking.*not.*(?:support|available)/i).test(stderr) ||
    (/invalid.*thinking/i).test(stderr);
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

interface ReviewPhaseResult {
  exitCode: number;
  output: string;
  error: string;
  effortRejected?: boolean;
}

async function spawnPiProcess(
  cwd: string,
  args: string[],
): Promise<ReviewPhaseResult> {
  const invocation = getPiExecutable();

  return new Promise((resolve) => {
    const proc = spawn(invocation.command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        output: stdout,
        error: stderr,
        effortRejected: isUnsupportedEffortError(stderr),
      });
    });

    proc.on("error", (err) => {
      resolve({ exitCode: 1, output: "", error: err.message });
    });
  });
}

async function runReviewProcess(
  cwd: string,
  promptName: "review-first" | "review-second" | "external-review" | "external-eval",
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  phase: "first" | "second" | "external" | "eval",
  iteration: number,
  effort: ThinkingLevel | null,
  modelOverride?: string | null,
  extraVars?: Record<string, string>,
): Promise<ReviewPhaseResult> {
  const template = loadPrompt(promptName, cwd);
  const prompt = expandPrompt(template, {
    GOAL: plan.title,
    PROGRESS_FILE: logger.filePath,
    DEFAULT_BRANCH: defaultBranch,
    ...extraVars,
  });

  let model: string | null;
  if (modelOverride === undefined) {
    /* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions */
    model = (phase === "first" ? config.reviewFirstModel : config.reviewSecondModel) ||
      config.defaultModel ||
      null;
    /* eslint-enable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions */
  } else {
    /* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions */
    model = modelOverride || null;
    /* eslint-enable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/strict-boolean-expressions */
  }

  const invocation = getPiExecutable();
  const args: string[] = [...invocation.args, "--mode", "json", "-p", "--no-session"];

  if (model !== null && model.length > 0) {
    args.push("--model", model);
  }

  if (effort !== null) {
    args.push("--thinking", effort);
  }

  const { dir: tmpDir, filePath: promptFile } = await writeTempFile(
    `review-${phase}-${iteration}`,
    prompt,
  );
  args.push(`@${promptFile}`);

  const result = await spawnPiProcess(cwd, args);

  // Cleanup temp files
  try {
    fs.unlinkSync(promptFile);
  } catch {
    /* ignore */
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch {
    /* ignore */
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 1: First review (one-shot, all 5 agents)
// ---------------------------------------------------------------------------

async function runFirstReview(
  cwd: string,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
): Promise<string> {
  const effort = isValidEffort(config.reviewFirstEffort) ? config.reviewFirstEffort : null;
  const effortSuffix = effort === null ? "" : ` — effort: ${effort}`;
  logger.logReview("first", `STARTED (5 agents, comprehensive)${effortSuffix}`);

  let result = await runReviewProcess(
    cwd, "review-first", config, plan, logger, defaultBranch, "first", 0, effort,
  );

  if (result.effortRejected === true && effort !== null) {
    logger.logReview("first", `effort "${effort}" rejected, retrying without effort`);
    result = await runReviewProcess(
      cwd, "review-first", config, plan, logger, defaultBranch, "first", 0, null,
    );
  }

  if (result.exitCode === 0) {
    const msg = "COMPLETE";
    logger.logReview("first", msg);
    return msg;
  }

  const msg = `ERROR: exit ${result.exitCode} — ${result.error.slice(0, 200)}`;
  logger.logReview("first", msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Phase 2: Review loop (iterative, 2 agents — critical/major only)
// ---------------------------------------------------------------------------

async function runReviewLoop(
  cwd: string,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
): Promise<string> {
  const maxIterations = config.reviewMaxIterations === 0 ? 5 : config.reviewMaxIterations;

  const loopMsg = `STARTED (max ${maxIterations} iterations, 2 agents: quality + implementation)`;
  logger.logReview("loop", loopMsg);

  for (let i = 0; i < maxIterations; i++) {
    const headBefore = getHeadHash(cwd);
    if (headBefore.length === 0) {
      const msg = "ERROR: cannot determine HEAD hash (not a git repo?)";
      logger.logReview("loop", msg);
      return msg;
    }

    const effort = isValidEffort(config.reviewSecondEffort) ? config.reviewSecondEffort : null;
    const effortInfo = effort === null ? "" : ` (effort: ${effort})`;
    logger.logReview("loop", `Iteration ${i + 1}/${maxIterations} — running review...${effortInfo}`);

    let result = await runReviewProcess(
      cwd, "review-second", config, plan, logger, defaultBranch, "second", i, effort,
    );

    if (result.effortRejected === true && effort !== null) {
      logger.logReview("loop", `effort "${effort}" rejected, retrying without effort`);
      result = await runReviewProcess(
        cwd, "review-second", config, plan, logger, defaultBranch, "second", i, null,
      );
    }

    if (result.exitCode !== 0) {
      const msg = `ERROR: exit ${result.exitCode} — ${result.error.slice(0, 200)}`;
      logger.logReview("loop", msg);
      return msg;
    }

    const headAfter = getHeadHash(cwd);
    if (headAfter === headBefore) {
      const msg = `COMPLETE (iteration ${i + 1}) — no changes, review clean`;
      logger.logReview("loop", msg);
      return msg;
    }

    const iterMsg = `Iteration ${i + 1}: fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}), continuing...`;
    logger.logReview("loop", iterMsg);
  }

  const msg = `MAX_ITERATIONS (${maxIterations}) — review loop exhausted`;
  logger.logReview("loop", msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Phase 2.5: External review loop (different model reviews, main model fixes)
// ---------------------------------------------------------------------------

interface JsonEvent {
  type: string;
  message?: {
    role: string;
    content?: Array<{ type: string; text: string }>;
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
function extractLastAssistantText(lines: string[]): string {
  let parts: string[] = [];
  for (const line of lines) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const event: JsonEvent = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        parts = [];
        const content = event.message.content;
        if (content !== undefined) {
          for (const part of content) {
            if (part.type === "text") parts.push(part.text);
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return parts.join("\n");
}

// eslint-disable-next-line sonarjs/cognitive-complexity
async function runExternalReviewLoop(
  cwd: string,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
): Promise<string> {
  const maxIterations = config.externalReviewMaxIterations === 0 ? 5 : config.externalReviewMaxIterations;
  const patience = config.externalReviewPatience === 0 ? 3 : config.externalReviewPatience;

  const externalModel = config.externalReviewModel ?? config.defaultModel;

  if (externalModel === null || externalModel.length === 0) {
    const msg = "SKIPPED — no model configured (externalReviewModel/defaultModel)";
    logger.logExternalReview("loop", msg);
    return msg;
  }

  const startMsg = `STARTED (reviewer: ${externalModel}, max ${maxIterations} iterations, patience: ${patience})`;
  logger.logExternalReview("loop", startMsg);

  let unchangedRounds = 0;
  let previousFindings = "";
  let lastReviewHead = "";

  for (let i = 0; i < maxIterations; i++) {
    // ---- Step 1: External reviewer finds issues ----
    const externalEffort = isValidEffort(config.externalReviewEffort) ? config.externalReviewEffort : null;

    const diffInstruction = lastReviewHead.length > 0
      ? `Run: \`git diff ${lastReviewHead}..HEAD\` to see the latest fix changes.`
      : `Run: \`git diff ${defaultBranch}...HEAD\` to see all changes in this branch.`;

    const reviewTemplate = loadPrompt("external-review", cwd);
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
        "- **Re-verify** each previous finding by reading the relevant file(s) with the `read` tool",
        "  — if the issue is still present, re-report it; if fixed or inaccurate, skip it.",
        "- **Add** new issues discovered in the fix delta or in files you inspected.",
        "- If all previous findings are resolved and no new issues exist, respond with `NO ISSUES FOUND`.",
      ].join("\n");
    }

    const iterLabel = `Iteration ${i + 1}/${maxIterations} — running external reviewer...`;
    logger.logExternalReview("review", iterLabel);

    const invocation = getPiExecutable();
    const reviewArgs = [...invocation.args, "--mode", "json", "-p", "--no-session"];
    if (externalModel.length > 0) reviewArgs.push("--model", externalModel);
    if (externalEffort !== null) reviewArgs.push("--thinking", externalEffort);

    const { dir: rTmpDir, filePath: rPromptFile } = await writeTempFile(
      `external-review-${i}`, reviewPrompt,
    );
    reviewArgs.push(`@${rPromptFile}`);

    let reviewResult = await spawnPiProcess(cwd, reviewArgs);
    try {
      fs.unlinkSync(rPromptFile);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(rTmpDir);
    } catch {
      /* ignore */
    }

    // Retry without effort if rejected
    if (reviewResult.effortRejected === true && externalEffort !== null) {
      const retryMsg = `effort "${externalEffort}" rejected, retrying without effort`;
      logger.logExternalReview("review", retryMsg);
      const retryArgs = reviewArgs.filter(
        (a) => !a.startsWith("@") || !a.includes("external-review"),
      );
      const thinkIdx = retryArgs.indexOf("--thinking");
      if (thinkIdx >= 0) retryArgs.splice(thinkIdx, 2);

      const { dir: r2TmpDir, filePath: r2PromptFile } = await writeTempFile(
        `external-review-${i}-retry`, reviewPrompt,
      );
      retryArgs.push(`@${r2PromptFile}`);

      reviewResult = await spawnPiProcess(cwd, retryArgs);
      try {
        fs.unlinkSync(r2PromptFile);
      } catch {
        /* ignore */
      }
      try {
        fs.rmdirSync(r2TmpDir);
      } catch {
        /* ignore */
      }
    }

    if (reviewResult.exitCode !== 0) {
      const msg = `ERROR: exit ${reviewResult.exitCode}`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    const findings = extractLastAssistantText(reviewResult.output.split("\n"));

    if (findings.length === 0 || (/^no issues found$/i).test(findings.trim()) || findings.trim().length < 10) {
      const msg = `COMPLETE (iteration ${i + 1}) — no issues found`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    previousFindings = findings;
    lastReviewHead = getHeadHash(cwd);

    // ---- Step 2: Main model evaluates and fixes ----
    const headBefore = getHeadHash(cwd);
    const mainEffort = isValidEffort(config.defaultEffort) ? config.defaultEffort : null;
    const mainModel = config.defaultModel ?? null;

    logger.logExternalReview("eval", `Iteration ${i + 1} — evaluating findings...`);

    let evalResult = await runReviewProcess(
      cwd, "external-eval", config, plan, logger, defaultBranch,
      "eval", i, mainEffort, mainModel,
      { FINDINGS: findings },
    );

    if (evalResult.effortRejected === true && mainEffort !== null) {
      const evalMsg = `effort "${mainEffort}" rejected, retrying without effort`;
      logger.logExternalReview("eval", evalMsg);
      evalResult = await runReviewProcess(
        cwd, "external-eval", config, plan, logger, defaultBranch,
        "eval", i, null, mainModel,
        { FINDINGS: findings },
      );
    }

    if (evalResult.exitCode !== 0) {
      const msg = `ERROR: eval exit ${evalResult.exitCode}`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    const evalText = extractLastAssistantText(evalResult.output.split("\n"));

    if (evalText.includes("EXTERNAL_REVIEW_DONE")) {
      const msg = `COMPLETE (iteration ${i + 1}) — all findings resolved`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    // ---- Step 3: Stalemate detection ----
    const headAfter = getHeadHash(cwd);

    if (headAfter === headBefore) {
      unchangedRounds++;
      logger.logExternalReview(
        "eval",
        `no changes (${unchangedRounds}/${patience} stalemate rounds)`,
      );

      if (unchangedRounds >= patience) {
        const msg = `STALEMATE — ${patience} rounds without changes`;
        logger.logExternalReview("eval", msg);
        return msg;
      }
    } else {
      unchangedRounds = 0;
      const hashMsg = `fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`;
      logger.logExternalReview("eval", hashMsg);
    }
  }

  const msg = `MAX_ITERATIONS (${maxIterations})`;
  logger.logExternalReview("loop", msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runReviewPipeline(
  ctx: { cwd: string },
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

  // Phase 1: First review
  const firstResult = await runFirstReview(ctx.cwd, config, plan, logger, defaultBranch);

  // Phase 2.5: External review loop
  let externalResult = "SKIPPED (disabled)";
  if (config.externalReviewEnabled) {
    externalResult = await runExternalReviewLoop(ctx.cwd, config, plan, logger, defaultBranch);
  } else {
    logger.logExternalReview("loop", "SKIPPED (externalReviewEnabled: false)");
  }

  // Phase 3: Review loop
  const loopResult = await runReviewLoop(ctx.cwd, config, plan, logger, defaultBranch);

  return { firstResult, externalResult, loopResult };
}
