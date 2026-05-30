# Plan: JSONL Logs with Tokens and Pricing

## Overview
Implement unified append-only JSONL logging for all ralpix commands and phases: brainstorm, plan creation, execution, and review. Replace the current text `ProgressLogger` with a resilient `LogWriter` that records structured events suitable for future HTML parsing, including steps, provider/model, token usage, cache tokens, total usage, and pricing/cost.

## Context
- Current progress logging is implemented in `logger.ts` as `ProgressLogger`, writing `.txt` files under `.ralpix/progress/`.
- Execution and review already pass a shared logger through `index.ts`, `executor.ts`, and `reviewer.ts`.
- Brainstorm and plan creation currently track token/cost usage through `createTokenLedger()` but do not persist progress logs.
- Existing usage data includes:
  - `input`
  - `output`
  - `cacheRead`
  - `cacheWrite`
  - `cost`
- `tui.ts` imports `fmtTokens` and `UsageSummary` from `logger.ts`, so these exports must remain.
- `README.md` currently documents `.txt` progress logs and must be updated to `.jsonl`.

## Key Layout

Each JSONL line must be one complete JSON object:

```typescript
interface JsonlEntry {
  ts: string;
  phase: "brainstorm" | "plan" | "execute" | "review";
  event: string;
  data: Record<string, unknown>;
}
```

Usage payloads must explicitly preserve pricing and tokens:

```typescript
interface JsonlUsageData {
  provider?: string;
  model?: string;
  step?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost: number;
  };
  total?: {
    input: number;
    output: number;
    cost: number;
  };
  breakdown?: Array<{
    provider: string;
    model: string;
    input: number;
    output: number;
    cost: number;
  }>;
}
```

Log files are append-only:

```text
.ralpix/progress/<sessionName>.jsonl
```

Session names:
- Brainstorm: `brainstorm-YYYYMMDD`
- Plan creation: `plan-YYYYMMDD`
- Plan execution + review: `<planStem>`
- Standalone review: existing `review-YYYYMMDD-<branch>` stem

## Invariants
- Logging failures must never crash or interrupt ralpix commands.
- `LogWriter.write()` always appends one valid JSON object per line.
- Usage events must save both token counts and pricing/cost wherever available.
- Execute and review for a plan must share the same JSONL file.
- No `.txt` progress log should be created by the new logger.
- Existing TUI token formatting helpers must remain available.

## Success Criteria
- [ ] Brainstorm, plan creation, execute, and review commands append structured JSONL events under `.ralpix/progress/`.
- [ ] Execute and review phases for a plan share one `<planStem>.jsonl` file.
- [ ] Usage events include token counts and pricing: `input`, `output`, `cost`, and cache token details where available.
- [ ] JSONL lines include timestamps, phase, event name, and structured data with task/stage details.
- [ ] Logging errors are caught and reported to stderr without failing commands.
- [ ] README progress log documentation references `.jsonl`, includes the schema, and documents token/pricing fields.
- [x] `npm run check` passes.

### Task 1: Replace ProgressLogger with LogWriter

**Files:**
- Modify: `logger.ts`
- Modify: `types.ts`

- [x] Remove `ProgressLogger` and text-file formatting/write logic from `logger.ts`.
- [x] Add `Phase`, `JsonlEntry`, and reusable JSONL usage payload types.
- [x] Implement `LogWriter` with `filePath = join(progressDirForCwd(cwd), `${sessionName}.jsonl`)`.
- [x] Make `LogWriter.write(phase, event, data)` append one JSON line and catch directory/write errors without throwing.
- [x] Preserve `UsageSummary`, `fmtTokens`, `formatUsageSummary`, and `progressDirForCwd` exports for existing TUI usage.

### Task 2: Add Structured Usage Helpers

**Files:**
- Modify: `logger.ts`
- Modify: `tui.ts`
- Modify: `index.ts`

- [ ] Add helper logic to convert usage summaries and provider/model breakdowns into JSON-safe objects.
- [ ] Ensure usage payloads include pricing via `cost`.
- [ ] Preserve token fields already tracked by subprocess usage: `input`, `output`, `cacheRead`, and `cacheWrite`.
- [ ] Keep existing human-readable usage formatting for TUI display unchanged.
- [ ] Avoid storing only formatted strings when structured token/cost numbers are available.

### Task 3: Convert Execution Logging to JSONL

**Files:**
- Modify: `index.ts`
- Modify: `executor.ts`

- [ ] Replace `ProgressLogger` imports/usages with `LogWriter`.
- [ ] In `runPlan`, write an `execute/start` event containing plan title, task count, and plan path.
- [ ] Replace task lifecycle logs with `execute/task_start`, `execute/task_info`, and `execute/task_end` events.
- [ ] Write `execute/task_usage` events containing task id, step usage, total usage, provider/model breakdown, token counts, and cost.
- [ ] Keep `RalpixState.progressFile` pointed at the new `.jsonl` path.
- [ ] Write `execute/complete` when plan execution and final review flow completes.

### Task 4: Convert Review Logging to JSONL

**Files:**
- Modify: `reviewer.ts`
- Modify: `index.ts`

- [ ] Update `runReviewPipeline`, standalone review, and helper functions to accept/use `LogWriter`.
- [ ] Map review progress messages to `review/stage_start`, `review/stage_update`, and `review/stage_finish` events with stage identifiers and details.
- [ ] Record review usage as `review/stage_usage` events with step usage, total usage, provider/model breakdown, token counts, and cost.
- [ ] Ensure standalone `/ralpix review` creates a `.jsonl` log and writes `review/start` and `review/complete`.
- [ ] Update prompt variables that use `PROGRESS_FILE` so they receive the JSONL log path.

### Task 5: Add JSONL Logging to Brainstorm

**Files:**
- Modify: `brainstorm.ts`

- [ ] Create a `LogWriter` at the start of `runBrainstorm` using `brainstorm-YYYYMMDD`.
- [ ] Write `brainstorm/start` with the requested description.
- [ ] Write per-round events such as `round_start`, `question`, `answer`, `approach_selected`, and `section_validated`.
- [ ] Write `brainstorm/usage` after subprocess rounds with step usage, total usage, provider/model breakdown, token counts, and cost.
- [ ] Write `brainstorm/end` with `status: "complete"` or `status: "cancelled"` before returning.

### Task 6: Add JSONL Logging to Plan Creation

**Files:**
- Modify: `planner.ts`

- [ ] Create a `LogWriter` at the start of `runPlanCreation` using `plan-YYYYMMDD`.
- [ ] Write `plan/start` with description, update/create mode, existing plan path if present, and whether brainstorm context was provided.
- [ ] Write `plan/round_start`, `plan/clarification`, `plan/draft_generated`, and `plan/review_result` events from the existing generation/review loop.
- [ ] Write `plan/usage` after each subprocess launch with step usage, total usage, provider/model breakdown, token counts, and cost.
- [ ] Write `plan/end` with `accepted`, `rejected`, `cancelled`, or `failed` status and `planPath` when available.

### Task 7: Update Documentation and Validate

**Files:**
- Modify: `README.md`

- [ ] Replace `.txt` progress log references with `.jsonl`.
- [ ] Update the Progress Logs section to document the JSONL schema and include example lines.
- [ ] Explicitly document that usage events save tokens and pricing/cost.
- [ ] Mention that logs are append-only and intended for future HTML parsing.
- [ ] Run `npm run check`.
- [ ] Manually inspect TypeScript import/type errors around `LogWriter`, `Phase`, `JsonlEntry`, and usage payload types.
