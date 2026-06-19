# Plan: Unified Transcript UI Contract for All Ralpix Phases

## Overview
Fix the actual UX failure first: `ralpix` history is hard to follow because `pi` widgets are height-constrained and cannot serve as a reliable transcript pane. The first implementation goal is a unified append-only main transcript plus a compact sticky summary in TUI across brainstorm, plan creation, execution, and review. The design must leave a clean path toward Telegram/HTML surfaces later, but that future extensibility must not force a large speculative refactor before the TUI transcript problem is solved.

## Context
- `README.md` currently promises a readable live transcript and sticky current-status line across phases.
- `session.ts` is the current shared interaction layer for `brainstorm.ts`, `planner.ts`, `executor.ts`, `reviewer.ts`, and `index.ts`.
- `session.message()` currently forwards messages to `ctx.ui.notify(...)`, while `session.status()` owns the sticky status line.
- `tui.ts` already contains a reusable `ProgressPanel`/`createProgressTui()` implementation, but it is not wired into the shared session path.
- Future targets include non-TUI consumers such as Telegram delivery and an HTML progress server, so phase code must not format itself directly for terminal-only consumption.
- `pi` documentation confirms:
  - widgets are only above/below-editor blocks of lines;
  - no widget height or scrolling API exists;
  - height controls such as `maxHeight` exist only for overlays, not widgets.
- The repository already has structured JSONL logging via `LogWriter`, so transcript/UI changes should not weaken log fidelity.

## Design Decisions
- Deliver this in two stages:
  - Stage 1: unify TUI transcript + sticky summary behavior using the smallest viable shared contract.
  - Stage 2: extract additional surface adapters only after Stage 1 works and the boundaries are proven.
- Separate semantic UI events from rendering concerns.
- Keep the main transcript as the canonical user-visible history for all phases.
- Keep current-status UI summary-only, never the primary history surface.
- Preserve `session.ts` as the migration façade so existing phase code can move incrementally instead of all at once.
- Keep prompt content phase-specific, but standardize prompt lifecycle: prompt requested, prompt answered, prompt cancelled or resumed.
- Keep TUI `setWidget()` usage compact and deterministic: no more than a small fixed summary block.
- Treat text formatting as renderer behavior, not as the core contract.
- Use the same semantic event stream to drive transcript, sticky summary, and JSONL logging so they do not drift apart.
- Usage/cost details belong to transcript milestones and compact summary checkpoints, not to high-frequency status churn.

## Abstraction Boundary

Introduce three layers:

1. **Phase orchestration layer**
   Emits semantic events like question asked, answer recorded, task started, retry scheduled, review stage finished.

2. **UI state / presentation layer**
   Owns normalized append-only transcript entries and current summary state.
   This layer is the canonical source for:
   - transcript feed
   - current phase/state
   - current focus
   - next expected action
   - usage summary

3. **Surface adapters**
   Render the shared UI state to a specific surface:
   - TUI adapter now
   - future Telegram adapter
   - future HTML/server adapter

The orchestration layer must never directly assume:
- terminal width
- widget placement
- ANSI colors
- footer/status APIs
- Telegram message chunking
- HTML templates

Those belong strictly to adapters.

For the first implementation pass, only the TUI adapter is required. Telegram/HTML are design constraints on the abstraction boundary, not deliverables in this plan.

## Migration Strategy

- Keep `session.ts` as the only shared façade used by phase code.
- Preserve existing high-level entry points such as `session.message(...)` and `session.status(...)` during migration.
- Reimplement those entry points over a new semantic event and presentation-state builder instead of rewriting every phase call site first.
- Move phase code onto explicit semantic helpers incrementally only after the façade-backed transcript and summary behavior are stable.
- Do not require a flag day rewrite across `brainstorm.ts`, `planner.ts`, `executor.ts`, and `reviewer.ts`.

## Semantic Event Contract

The core contract is structured events, not a baked text format:

```typescript
type UiEvent =
  | { type: "question_asked"; phase: UiPhase; promptId: string; message: string; createdAt: string }
  | { type: "answer_recorded"; phase: UiPhase; promptId: string; message: string; createdAt: string }
  | { type: "prompt_cancelled"; phase: UiPhase; promptId: string; reason: string; createdAt: string }
  | { type: "state_changed"; phase: UiPhase; state: UiState; now: string; next?: string; createdAt: string }
  | { type: "milestone"; phase: UiPhase; kind: UiTranscriptKind; message: string; createdAt: string }
  | { type: "usage_checkpoint"; phase: UiPhase; totalUsageText: string; createdAt: string };
```

Rules:
- Phase code emits semantic events or uses façade methods that produce them.
- Transcript entries and sticky summary are derived from events.
- JSONL logging must continue to capture the same work units or better fidelity from the same event stream.
- Renderers may choose their own text layout; the event model must stay renderer-agnostic.

## UI Contract

### Main Transcript

Every phase produces append-only transcript entries using the same normalized structure:

```typescript
interface UiTranscriptEntry {
  phase: "brainstorm" | "plan" | "execute" | "review";
  kind: "INFO" | "Q" | "A" | "STEP" | "TASK" | "STAGE" | "RESULT" | "OK" | "WARN" | "ERR";
  message: string;
  createdAt: string;
}
```

Surfaces may format that structure differently. A plain-text renderer may choose a default format such as:

```text
[phase] [kind] message
```

Allowed `phase` values:
- `brainstorm`
- `plan`
- `execute`
- `review`

Allowed `kind` values:
- `INFO`
- `Q`
- `A`
- `STEP`
- `TASK`
- `STAGE`
- `RESULT`
- `OK`
- `WARN`
- `ERR`

Examples of plain-text rendering:

```text
[brainstorm] Q What auth boundary should this feature use?
[brainstorm] A Use the existing session cookie
[brainstorm] STEP Approach selected: middleware-first
[plan] INFO Generating draft
[plan] RESULT Draft: "JWT auth" - 4 tasks, 11 items
[execute] TASK Task 2: Implement middleware
[execute] OK Attempt 1: completed
[review] STAGE External audit
[review] WARN Major issue found in refresh flow
```

### Sticky Summary

All phases expose the same compact current-summary state:

```typescript
interface UiCurrentSummary {
  phase: "brainstorm" | "plan" | "execute" | "review";
  state: "thinking" | "waiting" | "running" | "retrying" | "reviewing" | "complete" | "failed";
  now: string;
  next?: string;
  totalUsageText?: string;
}
```

The TUI adapter renders it in this compact block shape:

```text
ralpix: <phase> | <state>
Now: <current focus>
Next: <expected user/system action>
Total: in <tokens> out <tokens> $<cost>
```

Rules:
- Maximum 4 lines.
- Never used for long history.
- Driven by shared UI state, not phase-specific ad hoc strings.

### Prompt and Resume Behavior

When a phase needs user input:
- the phase emits a prompt-request event with a stable `promptId`;
- the transcript records the visible question;
- the dialog/selector/input is shown;
- the answer, cancellation, or resume outcome is recorded against the same `promptId`;
- control returns to the same transcript flow.

For non-interactive or remote surfaces:
- prompts may be serialized and handed to a transport-specific responder;
- the resulting answer still re-enters the shared transcript and summary state the same way.

Checkpointed and resumable flows must preserve prompt ordering and identity. In particular:
- unfinished brainstorm checkpoints must restore transcript history and current summary without duplicating prior prompt/answer pairs;
- cancelled prompts must be visible in logs and recoverable by the orchestrator;
- transcript order must remain deterministic even when status and prompt updates happen close together.

### Noise Control

Do not log spinner-like updates at high frequency. Only log meaningful transitions:
- round started/completed
- task attempt started/completed/failed
- review stage started/completed/failed
- user prompt issued
- user answer captured
- section/approach/draft accepted or revised
- usage/cost checkpoint after a completed unit of work

## Invariants
- The same TUI interaction model must apply to brainstorm, plan creation, execution, and review.
- The same underlying UI event/state model must be suitable for every surface, even though only TUI is implemented in this plan.
- The full user-visible history must remain available in the main transcript stream regardless of phase.
- Widgets must not be used as scrollable history panes.
- `session.ts` remains the shared contract layer for message and status behavior.
- `session.ts` must evolve toward a surface-agnostic presentation contract instead of a terminal-only helper.
- JSONL logging remains unchanged in fidelity or becomes strictly better, never worse.
- Existing command semantics for `/ralpix`, `/ralpix plan`, `/ralpix brainstorm`, and `/ralpix review` must remain intact.
- Summary rendering must remain compact under narrow terminal widths and never exceed its fixed line budget.
- Prompt cancellation and checkpoint resume must not corrupt transcript ordering.

## Success Criteria
- [ ] All four phases emit user-visible history through the shared `session.ts` façade rather than phase-specific transcript formatting.
- [ ] Full history is readable from the main transcript without depending on widget height.
- [ ] The TUI sticky summary stays within its fixed small line budget for all phases.
- [ ] Questions and answers appear in transcript order deterministically, including resumed flows.
- [ ] Shared phase events are representable without TUI-specific assumptions.
- [ ] At least one non-TUI renderer or sink test proves the contract is not TUI-shaped.
- [ ] `README.md` accurately describes the unified transcript/status behavior.
- [ ] `npm run check` passes after implementation.

### Task 1: Define Semantic Event and Presentation Contract

**Files:**
- Modify: `session.ts`
- Modify: `types.ts`

- [ ] Add explicit shared concepts for semantic UI events, transcript entries, prompts, and current summary state.
- [ ] Normalize message kinds to the final shared vocabulary used across every phase.
- [ ] Separate semantic event emission from any specific rendering API.
- [ ] Ensure the shared contract can express round, task, stage, section, retry, and prompt lifecycle updates without phase-specific hacks.
- [ ] Keep the core contract structured and renderer-agnostic.

### Task 2: Add Shared Presentation State Builder

**Files:**
- Modify: `session.ts`
- Modify: `types.ts`

- [ ] Build a shared presentation state object that derives transcript entries and current summary details from semantic events.
- [ ] Ensure façade methods in `session.ts` write into this shared state builder first.
- [ ] Keep formatting and layout concerns out of the builder.
- [ ] Preserve ordering guarantees between transcript entries, prompt outcomes, and summary updates.

### Task 3: Migrate `session.ts` Without a Flag Day

**Files:**
- Modify: `session.ts`
- Modify: call sites only if required

- [ ] Preserve current high-level session entry points while reimplementing them over the new event/state layer.
- [ ] Avoid a simultaneous rewrite of all phase modules.
- [ ] Introduce explicit semantic helper methods only where they materially improve clarity.
- [ ] Keep legacy-compatible behavior until all phases are moved onto the shared path.

### Task 4: Add a Reusable TUI Adapter

**Files:**
- Modify: `session.ts`
- Modify: `tui.ts`

- [ ] Rework the existing progress widget code into a compact sticky summary block suitable for all phases.
- [ ] Keep the sticky block intentionally short: phase, state, current focus, next action, total usage.
- [ ] Avoid any design that depends on widget height or scrolling.
- [ ] Ensure the renderer handles width constraints and predictable truncation cleanly.

### Task 5: Move Full History to the Main Transcript

**Files:**
- Modify: `session.ts`
- Modify: `index.ts`
- Modify: `brainstorm.ts`
- Modify: `planner.ts`
- Modify: `executor.ts`
- Modify: `reviewer.ts`

- [ ] Make transcript messages append in a unified shared format instead of phase-specific free-form notifications.
- [ ] Ensure questions, answers, retries, selections, completions, and failures are visible in the transcript.
- [ ] Stop treating widget output as a primary history view.
- [ ] Keep warning/error notifications prominent where useful, but do not depend on them for history.

### Task 6: Normalize Phase Event Emission

**Files:**
- Modify: `brainstorm.ts`
- Modify: `planner.ts`
- Modify: `executor.ts`
- Modify: `reviewer.ts`

- [ ] Map brainstorm events to the shared vocabulary: question, answer, approach selection, section validation, round completion, checkpoint resume.
- [ ] Map plan creation events to the shared vocabulary: clarification, draft generated, review result, acceptance/revision.
- [ ] Map execution events to the shared vocabulary: task start, attempt start, retry, completion, failure.
- [ ] Map review events to the shared vocabulary: stage start, findings, fix iteration, completion, failure.
- [ ] Remove wording drift so equivalent events read similarly across phases.

### Task 7: Define Prompt/Resume Semantics Explicitly

**Files:**
- Modify: `session.ts`
- Modify: `types.ts`
- Modify: `brainstorm.ts`
- Modify: other phase files as needed

- [ ] Define prompt request/response/cancel semantics with stable prompt identifiers.
- [ ] Define how resumed checkpoints restore transcript and summary state without duplication.
- [ ] Ensure prompt results can be correlated across TUI now and non-TUI transports later.
- [ ] Keep transport-specific prompt UI out of the core contract.

### Task 8: Prepare for Additional Surface Adapters

**Files:**
- Modify: `types.ts`
- Modify: `session.ts`
- Add: new surface adapter module(s) if needed

- [ ] Introduce minimal adapter-oriented interfaces such as renderer or output-sink abstractions.
- [ ] Ensure the TUI adapter is one implementation, not the default shape of the core domain.
- [ ] Add at least one non-TUI sink or test double to prove the contract is not TUI-shaped.
- [ ] Keep transport-specific concerns isolated from transcript semantics.

### Task 9: Update Documentation

**Files:**
- Modify: `README.md`

- [ ] Replace over-broad widget/transcript wording with precise behavior.
- [ ] Document that the transcript is append-only and primary, while the TUI widget is only one rendering of the compact summary.
- [ ] Mention the consistency guarantee across brainstorm, plan creation, execution, and review.
- [ ] Note that the core event/state contract is future-surface-friendly without promising shipped Telegram/HTML adapters yet.
- [ ] Avoid promising any widget-based long-history behavior that `pi` cannot guarantee.

### Task 10: Validate the Unified Flow

**Files:**
- Modify: tests as needed

- [ ] Add or update tests around semantic event mapping, transcript ordering, summary state behavior, and adapter isolation.
- [ ] Add coverage for prompt correlation and resumed transcript reconstruction where feasible.
- [ ] Run `npm run check`.
- [ ] Manually verify at least one flow each for brainstorm, plan creation, execution, and review.
- [ ] Confirm no phase regresses into a custom one-off TUI behavior.
