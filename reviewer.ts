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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Plan, RalpixConfig, ThinkingLevel } from "./types.js";
import { THINKING_LEVELS } from "./types.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
import { ProgressLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPiExecutable(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
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
    const output = execSync("git branch", { cwd, encoding: "utf-8" });
    if (output.includes("main")) return "main";
    if (output.includes("master")) return "master";
  } catch {
    // not a git repo
  }
  return "main";
}

/**
 * Get the current HEAD commit hash. Returns empty string on failure.
 */
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
  return /unsupported.*(thinking|effort|reasoning)/i.test(stderr) ||
    /thinking.*not.*(support|available)/i.test(stderr) ||
    /invalid.*thinking/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Spawn a single review phase (one-shot)
// ---------------------------------------------------------------------------

interface ReviewPhaseResult {
  exitCode: number;
  output: string;
  error: string;
  effortRejected?: boolean;
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
  // Load and expand the review prompt
  const template = loadPrompt(promptName, cwd);
  const prompt = expandPrompt(template, {
    GOAL: plan.title,
    PROGRESS_FILE: logger.filePath,
    DEFAULT_BRANCH: defaultBranch,
    ...extraVars,
  });

  // Determine model — use override if provided, otherwise phase-based
  let model: string | null;
  if (modelOverride !== undefined) {
    model = modelOverride || null;
  } else {
    model =
      (phase === "first" ? config.reviewFirstModel : config.reviewSecondModel)
      || config.defaultModel
      || null;
  }

  // Build spawn args
  const invocation = getPiExecutable();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];

  if (model) {
    args.push("--model", model);
  }

  if (effort) {
    args.push("--thinking", effort);
  }

  const { dir: tmpDir, filePath: promptFile } = await writeTempFile(
    `review-${phase}-${iteration}`,
    prompt,
  );
  args.push(`@${promptFile}`);

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
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      resolve({
        exitCode: code ?? 1,
        output: stdout,
        error: stderr,
        effortRejected: isUnsupportedEffortError(stderr),
      });
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
      try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
      resolve({
        exitCode: 1,
        output: "",
        error: err.message,
      });
    });
  });
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
  logger.logReview("first", `STARTED (5 agents, comprehensive)${effort ? ` — effort: ${effort}` : ""}`);

  let result = await runReviewProcess(
    cwd, "review-first", config, plan, logger, defaultBranch, "first", 0, effort,
  );

  // Graceful fallback if effort was rejected
  if (result.effortRejected && effort) {
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
  const maxIterations = config.reviewMaxIterations || 5;

  logger.logReview("loop", `STARTED (max ${maxIterations} iterations, 2 agents: quality + implementation)`);

  for (let i = 0; i < maxIterations; i++) {
    // Capture HEAD before review
    const headBefore = getHeadHash(cwd);
    if (!headBefore) {
      const msg = "ERROR: cannot determine HEAD hash (not a git repo?)";
      logger.logReview("loop", msg);
      return msg;
    }

    const effort = isValidEffort(config.reviewSecondEffort) ? config.reviewSecondEffort : null;
    logger.logReview("loop", `Iteration ${i + 1}/${maxIterations} — running review...${effort ? ` (effort: ${effort})` : ""}`);

    let result = await runReviewProcess(
      cwd, "review-second", config, plan, logger, defaultBranch, "second", i, effort,
    );

    // Graceful fallback if effort was rejected
    if (result.effortRejected && effort) {
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

    // Check if any changes were committed
    const headAfter = getHeadHash(cwd);

    if (headAfter === headBefore) {
      const msg = `COMPLETE (iteration ${i + 1}) — no changes, review clean`;
      logger.logReview("loop", msg);
      return msg;
    }

    logger.logReview("loop", `Iteration ${i + 1}: fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}), continuing...`);
  }

  const msg = `MAX_ITERATIONS (${maxIterations}) — review loop exhausted`;
  logger.logReview("loop", msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Phase 2.5: External review loop (different model reviews, main model fixes)
// ---------------------------------------------------------------------------

/**
 * Read last assistant text from JSON-line messages.
 */
function extractLastAssistantText(lines: string[]): string {
  const texts: string[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        for (const part of event.message.content ?? []) {
          if (part.type === "text") texts.push(part.text);
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return texts.join("\n");
}

async function runExternalReviewLoop(
  cwd: string,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
): Promise<string> {
  const maxIterations = config.externalReviewMaxIterations || 5;
  const patience = config.externalReviewPatience || 3;

  const externalModel = config.externalReviewModel || config.defaultModel;

  // mainModel is optional — when null, runReviewProcess omits --model and pi
  // picks its own default, consistent with how the other review phases behave.
  const mainModel = config.defaultModel || null;

  if (!externalModel) {
    const msg = "SKIPPED — no model configured (externalReviewModel/defaultModel)";
    logger.logExternalReview("loop", msg);
    return msg;
  }

  logger.logExternalReview("loop",
    `STARTED (reviewer: ${externalModel}, max ${maxIterations} iterations, patience: ${patience})`);

  let unchangedRounds = 0;
  let isFirstIteration = true;

  for (let i = 0; i < maxIterations; i++) {
    // ---- Step 1: External reviewer finds issues ----
    const externalEffort = isValidEffort(config.externalReviewEffort) ? config.externalReviewEffort : null;

    // Build diff instruction based on iteration
    const diffInstruction = isFirstIteration
      ? `Run: \`git diff ${defaultBranch}...HEAD\` to see all changes in this branch.`
      : `Run: \`git diff\` to see uncommitted changes from the previous fix round.`;

    // Load and expand the external review prompt with diff instruction
    const reviewTemplate = loadPrompt("external-review", cwd);
    const reviewPrompt = expandPrompt(reviewTemplate, {
      GOAL: plan.title,
      DEFAULT_BRANCH: defaultBranch,
      PROGRESS_FILE: logger.filePath,
      DIFF_INSTRUCTION: diffInstruction,
    });

    logger.logExternalReview("review", `Iteration ${i + 1}/${maxIterations} — running external reviewer...`);

    // Use writeTempFile + spawn directly since we need custom prompt expansion
    const invocation = getPiExecutable();
    const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];
    if (externalModel) args.push("--model", externalModel);
    if (externalEffort) args.push("--thinking", externalEffort);

    const { dir: rTmpDir, filePath: rPromptFile } = await writeTempFile(
      `external-review-${i}`, reviewPrompt,
    );
    args.push(`@${rPromptFile}`);

    let reviewResult = await new Promise<{ exitCode: number; output: string; error: string; effortRejected?: boolean }>((resolve) => {
      const proc = spawn(invocation.command, args, {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      proc.on("close", (code) => {
        try { fs.unlinkSync(rPromptFile); } catch { /* ignore */ }
        try { fs.rmdirSync(rTmpDir); } catch { /* ignore */ }
        resolve({
          exitCode: code ?? 1, output: stdout, error: stderr,
          effortRejected: isUnsupportedEffortError(stderr),
        });
      });
      proc.on("error", (err) => {
        try { fs.unlinkSync(rPromptFile); } catch { /* ignore */ }
        try { fs.rmdirSync(rTmpDir); } catch { /* ignore */ }
        resolve({ exitCode: 1, output: "", error: err.message });
      });
    });

    // Retry without effort if rejected
    if (reviewResult.effortRejected && externalEffort) {
      logger.logExternalReview("review", `effort "${externalEffort}" rejected, retrying without effort`);
      // Copy fully built args, strip --thinking flag, and replace old prompt file
      const retryArgs = args.filter(a => !a.startsWith("@") || !a.includes("external-review"));
      const thinkIdx = retryArgs.indexOf("--thinking");
      if (thinkIdx >= 0) retryArgs.splice(thinkIdx, 2);

      const { dir: r2TmpDir, filePath: r2PromptFile } = await writeTempFile(
        `external-review-${i}-retry`, reviewPrompt,
      );
      retryArgs.push(`@${r2PromptFile}`);

      reviewResult = await new Promise<{ exitCode: number; output: string; error: string; effortRejected?: boolean }>((resolve) => {
        const proc2 = spawn(invocation.command, retryArgs, {
          cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
        });
        let out2 = ""; let err2 = "";
        proc2.stdout.on("data", (data: Buffer) => { out2 += data.toString(); });
        proc2.stderr.on("data", (data: Buffer) => { err2 += data.toString(); });
        proc2.on("close", (code2) => {
          try { fs.unlinkSync(r2PromptFile); } catch { /* ignore */ }
          try { fs.rmdirSync(r2TmpDir); } catch { /* ignore */ }
          resolve({ exitCode: code2 ?? 1, output: out2, error: err2 });
        });
        proc2.on("error", (err2) => {
          try { fs.unlinkSync(r2PromptFile); } catch { /* ignore */ }
          try { fs.rmdirSync(r2TmpDir); } catch { /* ignore */ }
          resolve({ exitCode: 1, output: "", error: err2.message });
        });
      });
    }

    if (reviewResult.exitCode !== 0) {
      const msg = `ERROR: exit ${reviewResult.exitCode}`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    const findings = extractLastAssistantText(reviewResult.output.split("\n"));

    if (!findings || /^no issues found$/i.test(findings.trim()) || findings.trim().length < 10) {
      const msg = `COMPLETE (iteration ${i + 1}) — no issues found`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    // ---- Step 2: Main model evaluates and fixes ----
    const headBefore = getHeadHash(cwd);
    const mainEffort = isValidEffort(config.defaultEffort) ? config.defaultEffort : null;

    logger.logExternalReview("eval", `Iteration ${i + 1} — evaluating findings...`);

    const evalResult = await runReviewProcess(
      cwd, "external-eval", config, plan, logger, defaultBranch,
      "eval", i, mainEffort, mainModel,
      { FINDINGS: findings.slice(0, 8000) },
    );

    if (evalResult.exitCode !== 0) {
      const msg = `ERROR: eval exit ${evalResult.exitCode}`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    const evalText = extractLastAssistantText(evalResult.output.split("\n"));

    // Check for DONE signal
    if (evalText.includes("EXTERNAL_REVIEW_DONE")) {
      const msg = `COMPLETE (iteration ${i + 1}) — all findings resolved`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    // ---- Step 3: Stalemate detection ----
    const headAfter = getHeadHash(cwd);

    if (headAfter === headBefore) {
      unchangedRounds++;
      logger.logExternalReview("eval",
        `no changes (${unchangedRounds}/${patience} stalemate rounds)`);

      if (unchangedRounds >= patience) {
        const msg = `STALEMATE — ${patience} rounds without changes`;
        logger.logExternalReview("eval", msg);
        return msg;
      }
    } else {
      unchangedRounds = 0;
      logger.logExternalReview("eval",
        `fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`);
    }

    isFirstIteration = false;
  }

  const msg = `MAX_ITERATIONS (${maxIterations})`;
  logger.logExternalReview("loop", msg);
  return msg;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full review pipeline:
 *   1. First review (one-shot, all 5 agents)
 *   2. External review loop (different model, if enabled)
 *   3. Review loop (iterative, 2 agents, critical/major only)
 */
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

  // Phase 1: First review — one-shot comprehensive (all 5 agents)
  const firstResult = await runFirstReview(ctx.cwd, config, plan, logger, defaultBranch);

  // Phase 2.5: External review loop (different model, if enabled)
  let externalResult = "SKIPPED (disabled)";
  if (config.externalReviewEnabled) {
    externalResult = await runExternalReviewLoop(ctx.cwd, config, plan, logger, defaultBranch);
  } else {
    logger.logExternalReview("loop", "SKIPPED (externalReviewEnabled: false)");
  }

  // Phase 3: Review loop — iterative critical/major (2 agents)
  const loopResult = await runReviewLoop(ctx.cwd, config, plan, logger, defaultBranch);

  return { firstResult, externalResult, loopResult };
}
