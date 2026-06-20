# Plan: Full Rewrite — Surface-Agnostic Phases, Unified Event Model, Single JSONL Writer

## Overview

Full rewrite of ralpix from scratch. All TypeScript source files are deleted and rewritten; everything else is retained.

**Deleted (rewritten from scratch):**
- All `*.ts` files in the project root

**Retained as-is:**
- `bundled/` — prompt and agent `.md` files; these are the actual content the subagents run on
- `docs/` — plans and specs
- `AGENTS.md`, `README.md`
- `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`
- `docker/`, `Makefile`

Core pipeline unchanged: brainstorm → plan → execute → review, with the plan markdown file as the central artifact. All orchestration stays in TypeScript/Node.js.

Three hard requirements:

1. **Surface adapter boundary** — phase logic never assumes TUI, Telegram, or web. Surface is swappable.
2. **Single JSONL writer** — one entity owns file writes; all other code emits events.
3. **AgentEvent as universal currency** — everything that happens becomes a typed event; surface adapters render it, the logger writes it.

## Architecture

Four layers:

```
Contract layer    → events.ts, types.ts
                    Pure types. No runtime imports. No side effects.

Runtime layer     → event-bus.ts, logger.ts, utils.ts, tui.ts
                    event-bus routes AgentEvent to all registered emitters.
                    LogWriter writes JSONL. utils.ts holds formatting helpers.
                    TUI adapter renders. Zod validation on emit — throws at
                    the emitter, never at the reader.

Application layer → config.ts, prompt.ts, parser.ts,
                    pi-subprocess.ts, task-review-subprocess.ts,
                    brainstorm.ts, planner.ts, executor.ts, reviewer.ts
                    Phases call session.log() only.
                    Zero imports from tui.ts, chalk, ANSI, or any surface.

CLI layer         → index.ts
                    Assembles emitters, creates sessions per phase,
                    handles CLI commands and session restore.
```

## Design Decisions

- `RunSession` is the only interface phases talk to: `log()`, `choose()`, `confirm()`, `input()`, `close()`, plus shorthands `milestone()`, `statusChanged()`, `usageCheckpoint()`.
- `session.log(type, data)` accepts `(type: string, data?: Record<string, unknown>)`. TypeScript cannot enforce field correctness at the call site — zod catches malformed events at runtime on emit. This is a deliberate tradeoff: ergonomic call sites, runtime safety net. Document this explicitly so callers know type errors are runtime, not compile-time.
- LogWriter writes to `.ralpix/progress/{phase}/{sessionName}.jsonl`. On first run after upgrade, any `.ralpix/progress/*.jsonl` files at the old flat path are migrated to per-phase subdirs (see Task 13).
- Formatting utilities (`fmtTokens`, `formatUsageSummary`, etc.) live in `utils.ts` — not in `logger.ts` — to avoid a dependency from `tui.ts` into the JSONL writer.
- Usage shape `{ step, total, breakdown }` inlined in every terminal event (`task_end`, `attempt_end`, `stage_finish`, `iteration_end`, `round_end`, `answer`).
- `reviewer.ts` emits stage/iteration events directly on session — no `ReviewPipelineHooks` callbacks.
- `pi-subprocess.ts` is its own module (Task 8), written before the phases that depend on it.
- In Stage 3, `adapters/logger-intercom.ts` replaces the direct LogWriter emitter. TUI adapter stays wired directly in Node.js — never goes through intercom.

## Preserved Behaviour

Brainstorm checkpoint/resume, clarification Q&A, critic + AI review + human review of plan drafts, sequential task execution with retry loop, material-failure detection, git commit after task, allDone hallucination guard, branch guardrail, 4-stage review pipeline (first-pass × 5, second-pass loop × 2, external review + eval), standalone review, per-phase model/effort config, `externalReviewEnabled`, `commitEnabled`, plan moved to `completed/` on success, session state restore on `session_start`.

---

## Prerequisite: Behaviour Extraction

**Must complete before deleting any code.**

The existing codebase is the authoritative source of truth for preserved behaviour. Once it is deleted, that reference is gone. Extract the invariants first.

- [ ] Document `allDoneSignal` detection logic: exact string pattern, where it fires, what it prevents
- [ ] Document material-failure detection: what constitutes a material failure, detection conditions, retry vs abort decision
- [ ] Document brainstorm checkpoint/resume: what state is persisted, file location, restore conditions
- [ ] Document `restoreState` / `persistState`: state shape, when each is called, what happens on corrupt state
- [ ] Document retry loop invariants: max retries config, backoff, what resets the attempt counter
- [ ] Document plan review cycle: exact sequence (draft → critic → AI → human), loop exit conditions, reload vs revise distinction
- [ ] Save as `docs/plans/behaviour-spec.md` — this becomes the acceptance test reference for Stage 2

---

## Stage 1: Foundation

**Sequencing rule:** Tasks 1–6 ship first and are tested (Task 6) before any phase file is written. Task 6 must be green before Stage 2 begins.

### Task 1: events.ts + types.ts

- [x] Create `types.ts` with domain types: `Phase`, `ReviewStageId`, `ReviewStageStatus`, `Plan`, `PlanTask`, `ModelConfig`, `RalpixConfig`, `SubprocessUsage`, `RalpixState`, `ReviewPipelineState`
- [x] Create `events.ts` with the full `AgentEvent` union:
  ```
  phase_start / phase_end
  question / answer (+usage)
  approach_selected / section_validated          (brainstorm)
  round_start / round_end (+usage)               (brainstorm, plan)
  draft_generated / review_result                (plan)
  critic_start / critic_end (+usage)             (plan)
  ai_review_start / ai_review_end (+usage)       (plan)
  human_review                                   (plan)
  task_start / attempt_start / attempt_end (+usage) / task_end (+usage)   (execute)
  stage_start / stage_update / stage_finish (+usage)                      (review)
  iteration_start / iteration_end (+usage)       (review)
  eval_iteration_start / eval_iteration_end (+usage)  (review)
  status_changed / milestone / usage_checkpoint
  ```
- [x] Usage shape: `{ step: { input, output, cacheRead, cacheWrite, cost }, total: { input, output, cost }, breakdown?: [{ provider, model, ... }][] }`
- [x] All events carry: `phase: Phase`, `createdAt: string` (ISO), plus event-specific fields
- [x] Export `AgentEventEmitter` interface: `{ emit(event: AgentEvent): void }`
- [x] Zero imports from Node.js or any other module — pure types only

### Task 2: utils.ts + logger.ts

- [x] Create `utils.ts` with formatting helpers: `fmtTokens`, `formatUsageSummary`, `formatUsageBreakdownLines`, `summarizeUsageSnapshot`, `usageToData` — consumed by `tui.ts` and `index.ts`. Lives here so `tui.ts` does not import from the JSONL writer.
- [x] Create `logger.ts` with `LogWriter(cwd: string, phase: Phase, sessionName: string)` constructor
- [x] Writes to `.ralpix/progress/{phase}/{sessionName}.jsonl`
- [x] Single public method: `write(event: AgentEvent): void` — serialises to JSONL line, appends
- [x] `filePath` property exposed for passing to subprocess env (`PROGRESS_FILE`)
- [x] `progressDirForPhase(cwd, phase)` helper
- [x] `createLogWriterEmitter(writer: LogWriter): AgentEventEmitter` — wraps LogWriter as emitter
- [x] No imports from `utils.ts` — logger is a pure writer

### Task 3: event-bus.ts

- [x] `RunSession` interface (all methods on the interface, not just on the implementation):
  ```ts
  log(type: string, data?: Record<string, unknown>): void
  choose(prompt: string, options: string[], config?): Promise<string | null>
  confirm(prompt: string, config?): Promise<boolean>
  input(prompt: string, config?): Promise<string | null>
  milestone(kind: string, message: string): void
  statusChanged(state: string, now: string, next?: string): void
  usageCheckpoint(totalUsageText: string): void
  close(): void
  ```
- [x] `createEventBus(ctx: ExtensionCommandContext, phase: Phase, emitters: AgentEventEmitter[]): RunSession`
- [x] Each `log()` call: build `AgentEvent` with `phase` + `createdAt` → zod validate → `emit()` on all emitters in registration order
- [x] Malformed event throws at `log()` call site, not at any reader
- [x] `milestone()`, `statusChanged()`, `usageCheckpoint()` are shorthands that call `log()` internally — they are on `RunSession` so phases can call them without knowing event types directly

### Task 4: tui.ts

- [x] `createTuiEmitter(ctx: ExtensionCommandContext): AgentEventEmitter`
- [x] Translates every `AgentEvent` into TUI rendering (transcript entries, status widget, notifications)
- [x] `createTokenLedger()` token accumulation helper lives here
- [x] `createSummaryTui` / `ProgressPanel` — TUI primitives consumed only by this file
- [x] Imports from `utils.ts` for formatting; zero imports from phase files or `logger.ts`

### Task 5: config.ts + prompt.ts

- [x] `config.ts`: `loadConfig(cwd)`, `initRalpixHome()`, `ralpixHomeDir()`, `resolveModel(config, phase)`, `resolvePiAgentDir()`, `buildSessionModelChange(from, to)` — all config loading and resolution logic
- [x] `prompt.ts`: `loadPrompt(name)`, `expandPrompt(template, vars)` — prompt file loading and variable expansion
- [x] `planner-prompt.ts`: planner-specific prompt construction logic (if it warrants a separate file; otherwise inline into `prompt.ts`)
- [x] `globals.d.ts`: ambient type declarations for the extension environment
- [x] No phase logic in any of these files

### Task 6: Tests (Stage 1 gate)

Green before any phase file is written. Includes test infrastructure setup.

- [x] Configure vitest, add `tsconfig.test.json` if needed, set up test runner
- [x] Create `test/stubs.ts`: `stubRunSession()` factory returning a `RunSession` with all methods as spies — shared across all phase tests
- [x] `events.test.ts`: zod schema validates each event type; required fields enforced; unknown fields rejected; `createdAt` and `phase` always present
- [x] `event-bus.test.ts`: emitter dispatch order preserved; malformed event throws at `log()`, not later; usage inlined correctly in terminal events; `milestone()` / `statusChanged()` / `usageCheckpoint()` produce correctly shaped events
- [x] `logger.test.ts`: JSONL written to correct subdirectory; `write()` appends, does not overwrite; `filePath` points to correct path
- [x] `utils.test.ts`: `fmtTokens` and `formatUsageSummary` produce expected output for known inputs

---

## Stage 2: Phases

**Sequencing rule:** one module at a time. Each module ships with its own test before the next starts. After Task 9 (brainstorm), a smoke-test gate verifies the CLI is runnable end-to-end before continuing.

### Task 7: parser.ts

- [ ] `parsePlan(content: string): Plan` — markdown → structured task list
- [ ] Handles checkboxes, task IDs, item counts
- [ ] Test fixture set: empty plan, tasks with checkboxes, malformed input, plan with completed tasks

### Task 8: pi-subprocess.ts

- [ ] `runPiSubprocessPrompt(ctx, pi, prompt, config, session): Promise<SubprocessResult>` — core subprocess runner
- [ ] Streaming output handling: progress events forwarded to session as `milestone` events
- [ ] Usage extraction from subprocess output: returns `SubprocessUsage`
- [ ] Error propagation: subprocess crash vs clean failure distinguished
- [ ] `createPiProgressHooks(session, ledger)` — hooks wiring for progress reporting
- [ ] Test: mock subprocess, assert usage extracted correctly; assert progress events forwarded; assert crash vs failure distinction

### Task 9: brainstorm.ts

- [ ] No `LogWriter`, no `ctx.ui`, no chalk/ANSI
- [ ] All output via `session.log()` and `session.choose()` / `session.input()` / `session.confirm()`
- [ ] Events emitted: `phase_start`, `phase_end`, `question`, `answer` (+usage), `round_start`, `round_end` (+usage), `approach_selected`, `section_validated`
- [ ] Checkpoint/resume: state persisted to file between rounds; on resume, loads checkpoint and emits `session_start` equivalent
- [ ] Test: stub `RunSession` from `test/stubs.ts`, assert emitted event sequence and shapes match `behaviour-spec.md`

**Smoke-test gate after Task 9:** wire brainstorm into a minimal `index.ts` stub and run `ralpix brainstorm` against a real pi session. Verify the CLI runs, events appear in TUI, and JSONL is written to the correct path. Do not proceed to Task 10 until this passes.

### Task 10: planner.ts

- [ ] No `LogWriter`, no surface calls
- [ ] Events: `phase_start`, `phase_end`, `question`, `answer` (+usage), `round_start`, `round_end` (+usage), `draft_generated`, `review_result`, `critic_start`, `critic_end` (+usage), `ai_review_start`, `ai_review_end` (+usage), `human_review`
- [ ] Plan review cycle: draft → critic → AI reviewer → human → loop until accepted; loop exit conditions per `behaviour-spec.md`
- [ ] reload vs revise distinction preserved per `behaviour-spec.md`
- [ ] Clarification Q&A preserved
- [ ] Test: assert critic/ai/human events emitted in order for one review cycle; assert loop continues on reject, exits on accept

### Task 11: executor.ts

- [ ] `executeAllTasks(ctx, pi, plan, config, session): Promise<void>`
- [ ] Events: `task_start`, `attempt_start`, `attempt_end` (+usage), `task_end` (+usage)
- [ ] `committed` field in `task_end` when `commitEnabled`
- [ ] Retry loop per `behaviour-spec.md`: max retries from config, attempt counter reset conditions
- [ ] Material-failure detection per `behaviour-spec.md`: detection conditions, retry vs abort decision
- [ ] allDone hallucination guard per `behaviour-spec.md`: exact detection pattern, what it prevents
- [ ] Uses `pi-subprocess.ts` from Task 8
- [ ] Test: stub 2-task plan, assert `task_start → attempt_start → attempt_end → task_end` sequence; retry loop emits multiple `attempt_start`; material failure aborts without further attempts; allDone guard fires on hallucinated signal

### Task 12: reviewer.ts

- [ ] `runReviewPipeline(ctx, pi, plan, config, session, ...): Promise<void>`
- [ ] `runStandaloneReview(ctx, pi, config, session): Promise<void>`
- [ ] Events: `stage_start`, `stage_update`, `stage_finish` (+usage), `iteration_start`, `iteration_end` (+usage), `eval_iteration_start`, `eval_iteration_end` (+usage)
- [ ] No `ReviewPipelineHooks` — reviewer emits directly on session
- [ ] Write `task-review-subprocess.ts` here: external review subprocess runner (same interface pattern as `pi-subprocess.ts`)
- [ ] All config flags honoured: `externalReviewEnabled`, per-phase model/effort
- [ ] Test: stub 2-stage pipeline, assert stage and iteration events in order; assert `stage_finish` carries correct usage; assert `externalReviewEnabled: false` skips external stages with `status: "skipped"`

### Task 13: index.ts

- [ ] CLI commands: `brainstorm`, `plan`, `execute`, `review`, `init`
- [ ] For each phase: `createEventBus(ctx, phase, [createLogWriterEmitter(writer), createTuiEmitter(ctx)])`
- [ ] `persistState` / `restoreState` for session resume
- [ ] `session_start` interrupt detection and resume notification
- [ ] Branch guardrail: offer to create branch when on main/master
- [ ] Plan moved to `docs/plans/completed/` on full success
- [ ] **Migration:** on startup, if `.ralpix/progress/*.jsonl` files exist at the old flat path, move them to `.ralpix/progress/{inferred-phase}/` based on event types present, or `.ralpix/progress/unknown/` if ambiguous. Log one-time warning to stderr. `restoreState` tries both old and new path conventions.
- [ ] `buildStatusWidgetView` helper for TUI widget — lives here permanently (moves to `adapters/tui.ts` only if Stage 3 ships)

---

## Stage 3: Logger Pi Session

**Gate:** Task 14 must produce a written decision before any implementation begins. If the spike reveals blockers, Tasks 15–18 are redesigned or this stage is deferred.

### Task 14: pi-intercom reliability spike (prerequisite)

No code — written decision only. Answers:

- [ ] **Ordering:** when multiple senders call `intercom send` concurrently (e.g. first-pass × 5 agents), does the logger session receive them in a defined order? Is there a race that could interleave JSONL lines?
- [ ] **Failure handling:** what happens when `intercom send` fails (logger not yet started, crashed, unreachable)? Retry mechanism? Fall back to direct `LogWriter.write()`?
- [ ] **Durability:** if the logger pi session is interrupted mid-run, can it resume without losing already-written events? How does this interact with `restoreState`?
- [ ] **TUI attachment:** TUI adapter stays attached to the Node.js process and receives events directly from the event bus — confirm this explicitly and document it.
- [ ] **Deliverable:** written summary `docs/plans/stage3-spike.md` with answers + any design changes required for Tasks 15–18

### Task 15: agents/logger/ — TBD after Task 14

Design determined by Task 14 spike. Sketch only:

- [ ] Logger pi session prompt in `agents/logger/`
- [ ] Accepts `AgentEvent` JSON payloads via `intercom send`
- [ ] Writes to `.ralpix/progress/{phase}/{session}.jsonl` via `LogWriter.write()`
- [ ] Exits on `phase_end` with `phase: "complete"` or explicit shutdown signal

### Task 16: adapters/logger-intercom.ts — TBD after Task 14

- [ ] `AgentEventEmitter` that serialises and sends via intercom
- [ ] Fallback strategy (direct write vs abort) determined by Task 14

### Task 17: adapters/tui.ts + bootstrap — TBD after Task 14

- [ ] Move TUI emitter from `tui.ts` to `adapters/tui.ts`
- [ ] Bootstrap in `index.ts`: start logger session, wait for intercom-ready, signal shutdown on run end
- [ ] Logger session name: `ralpix-logger-{timestamp}`

### Task 18: e2e tests — TBD after Task 14

- [ ] `e2e/resume.test.ts`: interrupt after `task_end`, resume — JSONL appended, `session_start` emitted
- [ ] `e2e/review-pipeline.test.ts`: stub subprocess, assert all stage/iteration events in order
- [ ] `e2e/retry-loop.test.ts`: inject failing task, verify multiple `attempt_start`, no duplicate JSONL lines

---

## Success Criteria

- All 4 phases emit only `AgentEvent` — zero direct surface calls in phase code
- `grep -r "ctx\.ui\|setWidget\|chalk\|ANSI" brainstorm.ts planner.ts executor.ts reviewer.ts` returns zero matches
- JSONL per phase in `.ralpix/progress/{phase}/`
- Old flat-path JSONL files migrated on first run; session resume works across old and new paths
- Usage (step + total + breakdown) inlined in every terminal event
- Plan draft review cycle: critic → AI reviewer → human → loop; reload/revise distinction preserved
- Single JSONL writer (direct LogWriter in Stage 1–2; logger pi session in Stage 3)
- TUI works identically to current — adapter stays in Node.js process, not routed through intercom
- All config flags honoured: `externalReviewEnabled`, `commitEnabled`, `maxRetries`, per-phase model/effort
- Session resume and `session_start` interrupt detection preserved
- Branch guardrail preserved
- Plan moved to `docs/plans/completed/` on full success
- allDone guard and material-failure detection covered by executor tests
- Automated e2e tests cover resume, review pipeline ordering, and retry loop (Stage 3)
