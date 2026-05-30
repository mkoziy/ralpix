# External Review Phase — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add external review phase to ralpix pipeline — a different model/provider independently reviews code changes, finds issues, main model evaluates and fixes them.

**Architecture:** New `runExternalReviewLoop()` in reviewer.ts spawns pi processes with two different models: external model for finding issues, main model for evaluation and fixes. Loop iterates until clean, stalemate, or max iterations. Phase sits between first review (5 agents) and second review (2 agents) in `runReviewPipeline()`.

**Tech Stack:** TypeScript, Node.js child_process (spawn), pi coding agent CLI

---

### Task 1: Add new config fields to types and bundled defaults

**Files:**
- Modify: `types.ts`
- Modify: `bundled/config.json`

**Step 1: Add fields to RalpixConfig interface**

Add these fields to the `RalpixConfig` interface in `types.ts`, right after `reviewSecondEffort`:

```typescript
  /** External review phase settings */
  externalReviewEnabled: boolean;
  externalReviewModel: string | null;
  externalReviewEffort: ThinkingLevel | null;
  externalReviewMaxIterations: number;
  externalReviewPatience: number;
```

**Step 2: Add defaults to bundled/config.json**

Add after `reviewSecondEffort`:

```jsonc
  "externalReviewEnabled": true,
  "externalReviewModel": null,
  "externalReviewEffort": null,
  "externalReviewMaxIterations": 5,
  "externalReviewPatience": 3
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors related to the new fields (may need to update config.ts loadConfig to return all fields — handled in Task 3).

**Step 4: Commit**

```bash
git add types.ts bundled/config.json
git commit -m "feat: add external review config fields to types and defaults"
```

---

### Task 2: Update config.ts to load and validate new fields

**Files:**
- Modify: `config.ts`

**Step 1: Add validation for externalReviewEffort**

In `loadConfig()`, after the existing `validateEffort` calls for `reviewSecondEffort`, add:

```typescript
  config.externalReviewEffort = validateEffort(config.externalReviewEffort, "externalReviewEffort");
```

**Step 2: Verify config loading with new fields**

Create a small test script or mentally verify the merge chain:
- Bundled: `externalReviewEnabled: true`, `externalReviewModel: null`, etc.
- Global override: e.g. `externalReviewModel: "openai/gpt-5.2"`
- Project override: e.g. `externalReviewEnabled: false`

The merge logic (`{ ...base, ...override }`) already handles flat fields — no changes needed to `mergeConfig()`.

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 4: Commit**

```bash
git add config.ts
git commit -m "feat: load and validate external review config fields"
```

---

### Task 3: Add logExternalReview method to ProgressLogger

**Files:**
- Modify: `logger.ts`

**Step 1: Add the method**

After the `logReview` method, add:

```typescript
  logExternalReview(phase: string, result: string): void {
    this.append(`REVIEW_XTRNL ${phase.padEnd(8)} ${result}`);
  }
```

**Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add logger.ts
git commit -m "feat: add logExternalReview method to ProgressLogger"
```

---

### Task 4: Create external-review.md prompt

**Files:**
- Create: `bundled/prompts/external-review.md`

**Step 1: Write the prompt file**

```markdown
# External Code Review

You are an independent code reviewer. Review the code changes below for bugs, security issues, logic errors, edge cases, and code quality problems.

## Goal
{{GOAL}}

## Instructions

{{DIFF_INSTRUCTION}}

## Review Focus
- **Correctness:** Logic errors, off-by-one, null/undefined handling, type errors
- **Security:** Injection vulnerabilities, auth bypass, exposed secrets, unsafe input handling
- **Edge Cases:** Empty/null inputs, boundary conditions, error handling gaps
- **Code Quality:** Clear naming, appropriate abstractions, no dead code

## Output Format
List each finding with:
- **File** and **line number** (approximate if unknown)
- **Severity:** critical / major / minor
- **Description** of the issue
- **Suggested fix** (if applicable)

If you find no issues, respond with exactly: `NO ISSUES FOUND`

## Context
Progress log: {{PROGRESS_FILE}}
```

**Step 2: Commit**

```bash
git add bundled/prompts/external-review.md
git commit -m "feat: add external-review.md prompt template"
```

---

### Task 5: Create external-eval.md prompt

**Files:**
- Create: `bundled/prompts/external-eval.md`

**Step 1: Write the prompt file**

```markdown
# External Review Findings — Evaluation & Fix

You are the primary developer. An external reviewer (different AI model) has reviewed your code changes and found issues. Your job is to evaluate each finding and fix the confirmed ones.

## Goal
{{GOAL}}

## External Review Findings
{{FINDINGS}}

## Instructions

1. **Evaluate each finding** — is it a real issue or a false positive?
2. **For confirmed issues:** fix them in the code. Make minimal, targeted changes.
3. **For false positives:** skip them, note briefly why.
4. **After fixing:** stage and commit changes with message: `fix: address external review findings`
5. **Run validation** if applicable (tests, lints).

## Important
- Only fix confirmed, real issues. Do not make changes for false positives.
- Keep fixes minimal and targeted — do not refactor unrelated code.
- When ALL findings are resolved (fixed or dismissed), end your response with:
  `<<<RALPHEX:EXTERNAL_REVIEW_DONE>>>`

## Context
Progress log: {{PROGRESS_FILE}}
```

**Step 2: Commit**

```bash
git add bundled/prompts/external-eval.md
git commit -m "feat: add external-eval.md prompt template"
```

---

### Task 6: Add runExternalReviewLoop to reviewer.ts

**Files:**
- Modify: `reviewer.ts`

This is the core of the feature. We add a new `runExternalReviewLoop()` function and integrate it into `runReviewPipeline()`.

**Step 1: Add the loop function**

Add this new function after `runReviewLoop` and before the `runReviewPipeline` public API section:

```typescript
// ---------------------------------------------------------------------------
// Phase 2.5: External review loop (different model reviews, main model fixes)
// ---------------------------------------------------------------------------

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
  if (!externalModel) {
    const msg = "SKIPPED — no externalReviewModel or defaultModel configured";
    logger.logExternalReview("loop", msg);
    return msg;
  }

  logger.logExternalReview("loop", `STARTED (model: ${externalModel}, max ${maxIterations} iterations, patience: ${patience})`);

  let unchangedRounds = 0;
  let isFirstIteration = true;

  for (let i = 0; i < maxIterations; i++) {
    // Determine diff scope
    const diffInstruction = isFirstIteration
      ? `Run: \`git diff ${defaultBranch}...HEAD\` to see all changes in this branch.`
      : `Run: \`git diff\` to see uncommitted changes from the previous fix round.`;

    // ---- Step 1: Run external reviewer ----
    logger.logExternalReview("review", `Iteration ${i + 1}/${maxIterations} — running external reviewer...`);
    const externalEffort = isValidEffort(config.externalReviewEffort) ? config.externalReviewEffort : null;

    const reviewTemplate = loadPrompt("external-review", cwd);
    const reviewPrompt = expandPrompt(reviewTemplate, {
      GOAL: plan.title,
      DEFAULT_BRANCH: defaultBranch,
      PROGRESS_FILE: logger.filePath,
      DIFF_INSTRUCTION: diffInstruction,
    });

    let reviewResult = await runReviewProcess(
      cwd, "external-review", config, plan, logger, defaultBranch, "external", i, externalEffort,
    );

    // Fallback if effort rejected
    if (reviewResult.effortRejected && externalEffort) {
      logger.logExternalReview("review", `effort "${externalEffort}" rejected, retrying without effort`);
      reviewResult = await runReviewProcess(
        cwd, "external-review", config, plan, logger, defaultBranch, "external", i, null,
      );
    }

    if (reviewResult.exitCode !== 0) {
      const msg = `ERROR: exit ${reviewResult.exitCode} — ${reviewResult.error.slice(0, 200)}`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    // Extract findings from output
    const findings = extractLastAssistantText(reviewResult.output.split("\n"));

    if (!findings || findings.trim().toUpperCase() === "NO ISSUES FOUND" || findings.trim().length < 10) {
      const msg = `COMPLETE (iteration ${i + 1}) — no issues found`;
      logger.logExternalReview("review", msg);
      return msg;
    }

    // ---- Step 2: Run main model to evaluate and fix ----
    logger.logExternalReview("eval", `Iteration ${i + 1} — evaluating findings...`);

    const headBefore = getHeadHash(cwd);

    const evalTemplate = loadPrompt("external-eval", cwd);
    const evalPrompt = expandPrompt(evalTemplate, {
      GOAL: plan.title,
      PROGRESS_FILE: logger.filePath,
      FINDINGS: findings.slice(0, 8000), // Truncate if too long
    });

    const evalModel = config.defaultModel;
    if (!evalModel) {
      const msg = "ERROR: no defaultModel for eval phase";
      logger.logExternalReview("eval", msg);
      return msg;
    }

    // Use the first/review phase preset for model selection — we want the MAIN model here
    const mainEffort = isValidEffort(config.defaultEffort) ? config.defaultEffort : null;

    // Reuse runReviewProcess with review-first prompt handling but our own prompt
    const invocation = getPiExecutable();
    const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];
    if (evalModel) args.push("--model", evalModel);
    if (mainEffort) args.push("--thinking", mainEffort);

    const { dir: tmpDir, filePath: evalPromptFile } = await writeTempFile(
      `external-eval-${i}`,
      evalPrompt,
    );
    args.push(`@${evalPromptFile}`);

    const evalResult = await new Promise<{ exitCode: number; output: string; error: string }>((resolve) => {
      const proc = spawn(invocation.command, args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        try { fs.unlinkSync(evalPromptFile); } catch { /* ignore */ }
        try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
        resolve({ exitCode: code ?? 1, output: stdout, error: stderr });
      });

      proc.on("error", (err) => {
        try { fs.unlinkSync(evalPromptFile); } catch { /* ignore */ }
        try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
        resolve({ exitCode: 1, output: "", error: err.message });
      });
    });

    if (evalResult.exitCode !== 0) {
      const msg = `ERROR: eval exit ${evalResult.exitCode} — ${evalResult.error.slice(0, 200)}`;
      logger.logExternalReview("eval", msg);
      return msg;
    }

    // Check for DONE signal
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
      logger.logExternalReview("eval", `Iteration ${i + 1}: no changes detected (${unchangedRounds}/${patience} stalemate rounds)`);

      if (unchangedRounds >= patience) {
        const msg = `STALEMATE — ${patience} rounds without changes, exiting loop`;
        logger.logExternalReview("eval", msg);
        return msg;
      }
    } else {
      unchangedRounds = 0;
      logger.logExternalReview("eval", `Iteration ${i + 1}: fixes applied (${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)})`);
    }

    isFirstIteration = false;
  }

  const msg = `MAX_ITERATIONS (${maxIterations}) — external review loop exhausted`;
  logger.logExternalReview("loop", msg);
  return msg;
}
```

Wait — this is getting too complex with inline eval spawning. Let me instead refactor `runReviewProcess` to accept a custom model parameter, or create a simpler helper for spawning with arbitrary model.

Actually, looking at the existing code more carefully, `runReviewProcess` already takes `promptName` and `phase`. We can extend it. But for the eval step, we need to use the MAIN model (defaultModel) with a different prompt (external-eval.md). The cleanest approach:

1. Make `runReviewProcess` accept an optional model override
2. Use that for both the external review (with externalReviewModel) and eval (with defaultModel)

Let me write a cleaner version.

**Revised approach:** Add optional `modelOverride` parameter to `runReviewProcess`:

In `runReviewProcess`, change the model determination:

```typescript
async function runReviewProcess(
  cwd: string,
  promptName: string,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  phase: "first" | "second" | "external" | "eval",
  iteration: number,
  effort: ThinkingLevel | null,
  modelOverride?: string | null,  // NEW: override model selection
): Promise<ReviewPhaseResult> {
  // ... (load template, expand) ...

  // Determine model — use override if provided
  let model: string | null;
  if (modelOverride !== undefined) {
    model = modelOverride || null;
  } else {
    model = phase === "first" ? config.reviewFirstModel : config.reviewSecondModel
      || config.defaultModel || null;
  }

  // ... (rest unchanged) ...
}
```

This is cleaner. Let me adjust.

**Step 1 (revised): Add modelOverride to runReviewProcess**

In the existing `runReviewProcess` function, change the model determination section. Find:

```typescript
  // Determine model
  const model =
    phase === "first" ? config.reviewFirstModel : config.reviewSecondModel
    || config.defaultModel
    || null;
```

Replace with:

```typescript
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
```

And add `modelOverride?: string | null` to the function signature after `effort`:

```typescript
async function runReviewProcess(
  cwd: string,
  promptName: string,
  config: RalpixConfig,
  plan: Plan,
  logger: ProgressLogger,
  defaultBranch: string,
  phase: "first" | "second" | "external" | "eval",
  iteration: number,
  effort: ThinkingLevel | null,
  modelOverride?: string | null,
): Promise<ReviewPhaseResult> {
```

**Step 2: Add runExternalReviewLoop function**

Add the function after `runReviewLoop`. Here is the clean version using the modelOverride approach:

```typescript
// ---------------------------------------------------------------------------
// Phase 2.5: External review loop
// ---------------------------------------------------------------------------

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
  const mainModel = config.defaultModel;

  if (!externalModel || !mainModel) {
    const msg = "SKIPPED — no model configured (externalReviewModel/defaultModel)";
    logger.logExternalReview("loop", msg);
    return msg;
  }

  logger.logExternalReview("loop",
    `STARTED (reviewer: ${externalModel}, main: ${mainModel}, max ${maxIterations} iterations, patience: ${patience})`);

  let unchangedRounds = 0;
  let isFirstIteration = true;

  for (let i = 0; i < maxIterations; i++) {
    // ---- Step 1: External reviewer finds issues ----
    const externalEffort = isValidEffort(config.externalReviewEffort) ? config.externalReviewEffort : null;

    const reviewTemplate = loadPrompt("external-review", cwd);
    const reviewPrompt = expandPrompt(reviewTemplate, {
      GOAL: plan.title,
      DEFAULT_BRANCH: defaultBranch,
      PROGRESS_FILE: logger.filePath,
      DIFF_INSTRUCTION: isFirstIteration
        ? `Run: \`git diff ${defaultBranch}...HEAD\``
        : `Run: \`git diff\` to see uncommitted changes from the previous fix round.`,
    });

    logger.logExternalReview("review", `Iteration ${i + 1}/${maxIterations} — running external reviewer...`);

    let reviewResult = await runReviewProcess(
      cwd, "external-review", config, plan, logger, defaultBranch,
      "external", i, externalEffort, externalModel,
    );

    if (reviewResult.effortRejected && externalEffort) {
      logger.logExternalReview("review", `effort "${externalEffort}" rejected, retrying`);
      reviewResult = await runReviewProcess(
        cwd, "external-review", config, plan, logger, defaultBranch,
        "external", i, null, externalModel,
      );
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

    const evalTemplate = loadPrompt("external-eval", cwd);
    const evalPrompt = expandPrompt(evalTemplate, {
      GOAL: plan.title,
      PROGRESS_FILE: logger.filePath,
      FINDINGS: findings.slice(0, 8000),
    });

    logger.logExternalReview("eval", `Iteration ${i + 1} — evaluating findings...`);

    const evalResult = await runReviewProcess(
      cwd, "external-eval", config, plan, logger, defaultBranch,
      "eval", i, mainEffort, mainModel,
    );

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
```

**Step 3: Integrate into runReviewPipeline**

In `runReviewPipeline()`, after the first review and before the loop review, add the external review call. The current order in `runReviewPipeline` is:

```typescript
  // Phase 1: First review
  const firstResult = await runFirstReview(...);

  // Phase 2: Review loop
  const loopResult = await runReviewLoop(...);
```

Change to:

```typescript
  // Phase 1: First review
  const firstResult = await runFirstReview(...);

  // Phase 2.5: External review loop (if enabled)
  let externalResult = "SKIPPED (disabled)";
  if (config.externalReviewEnabled) {
    externalResult = await runExternalReviewLoop(ctx.cwd, config, plan, logger, defaultBranch);
  } else {
    logger.logExternalReview("loop", "SKIPPED (externalReviewEnabled: false)");
  }

  // Phase 3: Review loop (critical/major)
  const loopResult = await runReviewLoop(...);
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No type errors.

**Step 5: Commit**

```bash
git add reviewer.ts
git commit -m "feat: add external review loop to review pipeline"
```

---

### Task 7: End-to-end verification

**Files:**
- None (test run)

**Step 1: Create a test git repo with a minimal plan**

```bash
cd /tmp
mkdir ralpix-ext-review-test && cd ralpix-ext-review-test
git init
git commit --allow-empty -m "initial commit"
mkdir -p docs/plans
```

Write a minimal test plan:

```markdown
# Plan: External Review Test

## Overview
Test that external review phase works.

### Task 1: Create a simple file
- [ ] Create hello.txt with "Hello World"
- [ ] Verify the file exists
```

**Step 2: Run ralpix with external review enabled**

```bash
cd /tmp/ralpix-ext-review-test
# Ensure config has externalReviewModel set
mkdir -p .ralpix
cat > .ralpix/config.json << 'EOF'
{
  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",
  "externalReviewMaxIterations": 2,
  "externalReviewPatience": 2,
  "reviewEnabled": true
}
EOF

# Run (this requires pi to be available)
# /ralpix docs/plans/test-plan.md
```

**Step 3: Verify**

- [ ] Task executes and commits
- [ ] External review phase starts in progress log
- [ ] Progress log shows `REVIEW_XTRNL` entries
- [ ] Second review phase runs after external review

**Step 4: Test with external review disabled**

```bash
cat > .ralpix/config.json << 'EOF'
{
  "externalReviewEnabled": false
}
EOF
# Run again — external review should be skipped
```

**Step 5: Commit any remaining changes**

```bash
git add -A
git commit -m "test: e2e verification of external review phase"
```

---

## Summary

| Task | Files | Effort |
|------|-------|--------|
| 1. Config fields | types.ts, bundled/config.json | Small |
| 2. Config loading | config.ts | Small |
| 3. Logger method | logger.ts | Trivial |
| 4. external-review.md | bundled/prompts/ | Small |
| 5. external-eval.md | bundled/prompts/ | Small |
| 6. Reviewer loop | reviewer.ts | Large |
| 7. E2E verification | — | Medium |
