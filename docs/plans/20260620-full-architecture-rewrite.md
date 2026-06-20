# Plan: Staged Refactor — Surface-Agnostic Phases, Unified Event Model, Single JSONL Writer

## Overview

Staged refactor of ralpix internals. The core concept stays: brainstorm → plan → execute → review, with the plan markdown file as the central artifact. Control flow and feature behaviour are preserved in TypeScript throughout — this plan does not move orchestration out of Node.js.

Two hard requirements drive Stage 1–3:
1. **Surface adapter boundary** — phase logic never assumes TUI, Telegram, or web. Surface is swappable.
2. **Single JSONL writer** — one logger entity owns file writes; all other code emits events.

A third goal — **agent-native orchestration** (moving orchestration into pi sessions) — is explicitly out of scope for this plan. It is a separate, speculative project requiring its own feasibility spike. See [Future Scope](#future-scope-agent-native-orchestration) below.

Existing behaviour preserved: brainstorm checkpoint/resume, clarification Q&A, critic + AI review + human review of plan drafts, sequential task execution with retry loop, material-failure detection, git commit after task, all-done hallucination guard, branch guardrail, 4-stage review pipeline (first-pass × 5, second-pass loop × 2, external review + eval), standalone review, per-phase model/effort config, `externalReviewEnabled`, `commitEnabled`, plan moved to `completed/` on success, session state restore on `session_start`.

## Design Decisions

- `AgentEvent` is the universal currency — everything that happens becomes an event, surface adapters render it, logger writes it.
- `session.ts` is replaced by `event-bus.ts` — a typed emitter that phases write to and adapters subscribe from.
- `logger.ts` shrinks to a pure file writer; logic moves into the event bus.
- `tui.ts` becomes a pure TUI adapter that only reads `AgentEvent` — no business logic.
- Phase files (`brainstorm.ts`, `planner.ts`, `executor.ts`, `reviewer.ts`) emit only `AgentEvent` — no `LogWriter`, no `ctx.ui` calls, no surface references.
- JSONL subdirectories per phase: `.ralpix/progress/{phase}/{session}.jsonl`. A migration task (Task 2) handles existing files at the old flat path.
- Usage inlined into every terminal event (`task_end`, `stage_finish`, `iteration_end`, `round_end`, `answer`) as `{ step, total, breakdown }` — no separate `*_usage` events.
- Plan review cycle: planner draft → critic agent → AI reviewer → human review → loop until accepted.
- In Stage 3, a dedicated logger pi session becomes the single JSONL writer; all other pi sessions send `AgentEvent` JSON via `intercom send`. Stage 3 does not begin until a reliability spike (Task 13) answers the open questions about pi-intercom ordering, failure handling, and TUI attachment.

## Stage Overview

- **Stage 1** — Event contract + JSONL unification (TypeScript, no architecture change)
- **Stage 2** — Surface adapter split (TUI becomes a plugin, phases are surface-blind)
- **Stage 3** — Logger pi session (single writer, events routed via pi-intercom) — gated on Task 13 spike

---

## Stage 1: Event Contract + JSONL Unification

**Sequencing rule:** Tasks 1–3 ship first and are tested (Task 4) before any phase file is touched. Then Tasks 5–8 migrate phases one at a time; each phase gets its own test before the next starts. Task 9 cleans up the entry point last.

### Task 1: Define AgentEvent type contract

- [x] Create `events.ts` with the full `AgentEvent` union:
  ```
  phase_start / phase_end
  question / answer
  approach_selected / section_validated        (brainstorm)
  round_start / round_end (+usage)             (brainstorm, plan)
  draft_generated / review_result              (plan)
  task_start / attempt_start / attempt_end (+usage) / task_end (+usage)   (execute)
  stage_start / stage_update / stage_finish (+usage)                      (review)
  iteration_start / iteration_end (+usage)     (review)
  status_changed / milestone / usage_checkpoint
  ```
- [x] All events carry: `phase`, `createdAt` (ISO string), event-specific fields
- [x] Usage shape: `{ step: { input, output, cacheRead, cacheWrite, cost }, total: { input, output, cost }, breakdown: [{ provider, model, ... }][] }`
- [x] Export `AgentEventEmitter` interface: `emit(event: AgentEvent): void`
- [x] Delete old `UiEvent`, `UiTranscriptEntry`, `UiPresentationState`, `UiCurrentSummary` from `types.ts` — replaced by `AgentEvent`

### Task 2: Upgrade LogWriter — subdirectories per phase + migrate existing files

- [x] Add `phase: Phase` to `LogWriter` constructor; write to `.ralpix/progress/{phase}/{sessionName}.jsonl`
- [x] Replace `progressDirForCwd(cwd)` with `progressDirForPhase(cwd, phase)`
- [x] Remove all phase-specific helper methods (`logTaskStart`, `logTaskEnd`, `logTaskInfo`, `logTaskUsage`, `logReviewStageStart`, `logReviewStageUpdate`, `logReviewStageFinish`, `logReviewStepUsage`, `logReviewStart`, `logReviewComplete`, `logReviewUsage`, `logStart`, `logComplete`) — callers will use `session.log()` instead
- [x] Keep only `write(event: string, data?: Record<string, unknown>): void` as the base method
- [x] Update `PROGRESS_FILE` env var passed to subprocesses to reflect new path
- [x] **Migration:** on startup, if `.ralpix/progress/*.jsonl` files exist at the old flat path, move them into `.ralpix/progress/{inferred-phase}/` based on event types present, or into `.ralpix/progress/unknown/` if ambiguous. Log a one-time warning to stderr. Session resume (`restoreState`) must try both old and new path conventions until migration is complete.

### Task 3: Replace session.ts with event-bus.ts

- [x] Create `event-bus.ts` exporting `createEventBus(emitters: AgentEventEmitter[]): RunSession`
- [x] `RunSession` gains `log(event: string, data?: Record<string, unknown>): void` — emits typed `AgentEvent` to all registered emitters
- [x] **Runtime validation:** wrap `emit()` with a zod schema check (or equivalent) that throws at the emit site for malformed events — never at the reader. This catches missed or mis-shaped events during phase migration (Tasks 5–8) rather than silently writing bad JSONL.
- [x] `RunSession.message/status/usage` reimplemented as `log()` calls producing `milestone`, `status_changed`, `usage_checkpoint` events
- [x] `createCliSession` becomes `createEventBus` with two built-in emitters: LogWriter emitter + TUI emitter
- [x] LogWriter emitter: translates `AgentEvent` → `logger.write(phase, event, data)` with usage inlined
- [x] TUI emitter: translates `AgentEvent` → current TUI rendering (unchanged behaviour)
- [x] All callers of `createCliSession` updated to `createEventBus`
- [x] Delete `session.ts`

### Task 4: Tests for Tasks 1–3 (gate)

Complete and green before touching any phase file.

- [x] Add `events.test.ts`: verify `AgentEvent` shape for each event type — required fields present, usage shape correct, unknown fields rejected by zod
- [x] Add `event-bus.test.ts`: verify emitter dispatch order, usage inlining, that a malformed event throws at emit time not at read time
- [x] Update `pi-subprocess.test.ts` and `task-review-subprocess.test.ts` for new `RunSession` signatures

### Task 5: Refactor brainstorm.ts

- [ ] Remove `const logger = new LogWriter(...)` — session owns the logger now
- [ ] All inner functions drop `logger: LogWriter` parameter; use `session.log()` instead
- [ ] Split `brainstorm/question` (log when question extracted) + `brainstorm/answer` (log after answer received) — already correct, verify timing
- [ ] Add `brainstorm/round_end` with inline usage after each subprocess call (replaces `brainstorm/usage`)
- [ ] `approach_selected` and `section_validated` remain, routed through `session.log()`
- [ ] Add test: run brainstorm against a stub session, assert emitted events match `AgentEvent` shapes defined in Task 1

### Task 6: Refactor planner.ts

- [ ] Remove `const logger = new LogWriter(...)` — session owns it
- [ ] All inner functions (`runPlanAgentSubprocess`, `runPlanReviewSubprocess`, `runCriticSubprocess`, `runAcceptedPlanFlow`) drop `logger: LogWriter`; use `session.log()`
- [ ] Split `plan/clarification` into `plan/question` (logged immediately when model asks) + `plan/answer` (logged after user responds, includes usage snapshot)
- [ ] Add `plan/round_end` with inline usage after each subprocess round
- [ ] `plan/draft_generated`, `plan/review_result` (with `source: "ai" | "critic" | "user"`, `action`, digest fields) remain
- [ ] Plan review cycle events: `plan/critic_start`, `plan/critic_end` (with digest + usage), `plan/ai_review_start`, `plan/ai_review_end` (with digest + usage), `plan/human_review` (accept/reject/reload/revise + usage total)
- [ ] Add test: assert emitted plan events match expected shapes; verify review cycle emits critic/ai/human events in order

### Task 7: Refactor executor.ts

- [ ] Drop `logger: LogWriter` parameter from `executeTask` and `executeAllTasks`
- [ ] Use `session.log()` for all events
- [ ] Add `execute/attempt_start` event (attempt number, model label)
- [ ] `execute/attempt_end` with inline usage (step since attempt start, total)
- [ ] `execute/task_end` with inline usage (step since task start, total, breakdown)
- [ ] Material tool failure detection remains unchanged
- [ ] allDoneSignal hallucination guard remains unchanged
- [ ] `tryCommit` result included in `task_end` event data
- [ ] Add test: mock a 2-task plan, assert `task_start`/`attempt_start`/`attempt_end`/`task_end` sequence; verify retry loop emits multiple `attempt_start` events

### Task 8: Refactor reviewer.ts

- [ ] Drop `logger: LogWriter` parameter from all inner functions (`runFirstPass`, `runSecondPass`, `runExternalReview`, `runExternalEval`)
- [ ] Use `session.log()` for all events
- [ ] Add `review/iteration_start` + `review/iteration_end` (with inline step/total/breakdown usage) inside `runSecondPass` and `runExternalReview` loops
- [ ] `review/stage_finish` includes inline total-stage usage
- [ ] External eval iteration events: `review/eval_iteration_start`, `review/eval_iteration_end` (+usage)
- [ ] `ReviewPipelineHooks` (`onStageStart`, `onStageUpdate`, `onStageFinish`) replaced by `AgentEvent` emissions on the shared session
- [ ] Add test: assert stage events emitted in order for a 2-stage pipeline; verify iteration events wrap each loop body

### Task 9: Clean up index.ts

- [ ] Remove `new LogWriter(...)` for execute phase — session owns it
- [ ] `onStageStart/Update/Finish` callbacks on `runReviewPipeline` removed — reviewer emits events directly on session
- [ ] `runReviewPipeline` signature simplified: no hooks, takes session
- [ ] `buildStatusWidgetView` remains for TUI widget (moves into TUI adapter in Stage 2)
- [ ] Session state persistence (`persistState`, `restoreState`) unchanged
- [ ] `session_start` resume notification unchanged

---

## Stage 2: Surface Adapter Split

### Task 10: Extract TUI adapter

- [ ] Create `adapters/tui.ts` implementing `AgentEventEmitter`
- [ ] Move all TUI rendering logic out of `event-bus.ts` and `index.ts` into the adapter
- [ ] `buildStatusWidgetView` moves here
- [ ] `ProgressPanel`, `createProgressTui` from `tui.ts` consumed only by this adapter
- [ ] Adapter subscribes to `AgentEvent` stream; no phase-specific imports
- [ ] `tui.ts` retains only `createTokenLedger` and token ledger helpers (or moves them to `ledger.ts`)

### Task 11: Define surface adapter interface

- [ ] `adapters/interface.ts` exports `SurfaceAdapter: { emit(event: AgentEvent): void; close(): void }`
- [ ] `createEventBus(adapters: SurfaceAdapter[])` — event bus takes an array of adapters
- [ ] TUI adapter registered by default in CLI context
- [ ] Do NOT create stub files for Telegram/web — the interface being defined here is the extension point. Stubs with TODOs add no value and will rot.

### Task 12: Phase code audit — verify surface blindness

- [ ] `grep -r "ctx\.ui\|setWidget\|notify\|ANSI\|chalk\|color" brainstorm.ts planner.ts executor.ts reviewer.ts` must return zero matches after this stage
- [ ] All surface-specific formatting lives only in `adapters/`

---

## Stage 3: Logger Pi Session

**Gate:** Task 13 (reliability spike) must complete before any implementation begins. If the spike reveals blockers, Stage 3 is redesigned or deferred.

### Task 13: pi-intercom reliability spike (prerequisite)

This task produces a written decision, not code. Answer all of the following before proceeding:

- [ ] **Message ordering:** when multiple senders call `intercom send` concurrently (e.g. first-pass × 5 review agents), does the logger session receive them in a defined order? Is there a race that could interleave JSONL lines?
- [ ] **Failure handling:** what happens when `intercom send` fails (logger session not yet started, crashed, or unreachable)? Is there a retry mechanism? Should the adapter fall back to direct `LogWriter.write()`?
- [ ] **Session durability:** if the logger pi session is interrupted mid-run, can it resume without losing already-written events? How does this interact with the existing `restoreState` resume path?
- [ ] **TUI attachment:** in Stage 3+, the logger session runs as a separate pi session. The TUI adapter is a Node.js emitter registered in the event bus (Stage 2). Confirm the TUI adapter stays attached to the Node.js process and does NOT go through pi-intercom — it continues to receive events directly from the event bus. Document this explicitly.
- [ ] **Deliverable:** a written summary of answers and any design changes required for Tasks 14–16.

### Task 14: Logger agent design

- [ ] Create `agents/logger/` with logger pi session prompt
- [ ] Logger accepts `AgentEvent` JSON payloads via `intercom send` from any session
- [ ] Logger writes to `.ralpix/progress/{phase}/{session}.jsonl` using the same `LogWriter.write()` primitive
- [ ] Logger stays alive for the duration of a ralpix run; exits when it receives `phase_end` with `phase: "complete"` or a shutdown signal
- [ ] Logger is the ONLY entity that calls `LogWriter.write()` in Stage 3+
- [ ] If `intercom send` fails (per spike findings): adapter falls back to direct `LogWriter.write()` and emits a `status_changed` warning event — run does not abort

### Task 15: Logger adapter for event bus

- [ ] Create `adapters/logger-intercom.ts` implementing `SurfaceAdapter`
- [ ] On `emit(event)`: serialize event to JSON, send via `intercom send` to the named logger session
- [ ] Replace the direct LogWriter emitter from Stage 1 with this intercom adapter in production context
- [ ] Direct LogWriter emitter kept for tests and standalone mode (no pi-intercom available)
- [ ] TUI adapter remains wired directly in the Node.js event bus — it does not go through intercom (per Task 13 finding)

### Task 16: Logger pi session bootstrap

- [ ] CLI bootstrapper starts logger session before any phase begins
- [ ] Logger session name deterministic per run: `ralpix-logger-{timestamp}`
- [ ] Bootstrapper waits for logger to become intercom-connected before proceeding
- [ ] On run end: bootstrapper signals logger to flush and exit

### Task 17: End-to-end integration tests

Manual smoke test plus automated regression coverage. Both required.

**Automated (added to CI):**
- [ ] `e2e/resume.test.ts`: start a run, interrupt after `task_end`, resume — verify JSONL appended correctly and `session_start` event emitted
- [ ] `e2e/review-pipeline.test.ts`: run review pipeline with stubbed subprocess, assert all stage/iteration events emitted in order
- [ ] `e2e/retry-loop.test.ts`: inject a failing task, verify multiple `attempt_start` events then `task_end` with failure, no duplicate JSONL lines

**Manual smoke test:**
- [ ] `ralpix brainstorm` → `ralpix plan` → `ralpix execute` → `ralpix review` full flow
- [ ] Verify JSONL files land in `.ralpix/progress/{phase}/`
- [ ] Verify TUI shows progress for all phases (TUI adapter, not logger session)
- [ ] Verify plan review cycle: critic + AI review + human accept/reject
- [ ] Verify retry loop and material failure detection
- [ ] Verify external review pipeline (if configured)
- [ ] Verify session resume after interrupt

---

## Future Scope: Agent-Native Orchestration

Moving orchestration into pi sessions (an "orchestrator pi session" that replaces `index.ts`) is a separate project with different risk profile — it replaces deterministic TypeScript control flow with non-deterministic agent behaviour, which cannot be unit-tested the same way. It also requires Stage 3's pi-intercom architecture to be stable first.

This work belongs in a separate plan document after Stage 3 ships and the intercom transport is proven. Do not add tasks here.

---

## Success Criteria

- All 4 phases emit only `AgentEvent` — zero direct surface calls in phase code
- JSONL per phase in `.ralpix/progress/{phase}/`
- Existing flat-path JSONL files migrated on first run; session resume works across old and new paths
- Usage (step + total + breakdown) inlined in every terminal event
- Plan draft review cycle: critic → AI reviewer → human review → loop
- Single JSONL writer (logger session in Stage 3; direct LogWriter in Stage 1–2)
- TUI works identically to current — TUI adapter stays in Node.js process, not routed through intercom
- All existing config flags honoured: `externalReviewEnabled`, `commitEnabled`, `maxRetries`, per-phase model/effort
- `session_start` interrupt detection and resume notification preserved
- Plan moved to `docs/plans/completed/` on full success
- Branch guardrail (offer to create branch on main/master) preserved
- Automated e2e tests cover resume, review pipeline ordering, and retry loop
