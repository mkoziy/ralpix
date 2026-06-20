# Stage 3 Spike: `pi-intercom` Reliability

## Decision

Do not implement Stage 3 exactly as currently sketched.

`pi-intercom` is usable as a best-effort coordination channel between `pi` sessions, but the current broker/client model is not durable enough to become ralpix's only progress-log transport without additional ralpix-owned sequencing and replay machinery.

Recommended path:

1. Keep the Stage 1-2 direct `LogWriter` path as the production logging path for now.
2. Treat Stage 3 as a redesign, not a straight implementation task.
3. If Stage 3 is revived, add a ralpix-owned durable spool + ack protocol before any logger-session rollout.

## Evidence Reviewed

- ralpix architecture and state-resume flow in `index.ts`, `logger.ts`, and `docs/plans/20260620-full-architecture-rewrite-v2.md`
- `pi-intercom` README and runtime code from `nicobailon/pi-intercom`
- local transport experiment against the current `pi-intercom` broker with 5 concurrent senders

## Findings

### Ordering

Result: whole messages are preserved, but cross-sender ordering is not defined.

- `pi-intercom` frames each payload as one length-prefixed JSON message, so a receiver sees complete messages, not partial JSON fragments.
- The broker writes each delivered message to the logger session socket as a single framed payload.
- That means JSONL line corruption inside the logger is avoidable as long as the logger is the only process calling `LogWriter.write()`.
- However, there is no global ordering contract across concurrent senders. The broker handles whatever socket becomes readable first.
- In the local concurrency experiment, arrival order changed from round to round under random small delays. The order was nondeterministic across senders.

Implication for ralpix:

- Append order in the logger file would represent broker arrival order, not a canonical event order.
- If Stage 3 needs deterministic replay, ralpix must stamp events before transport with a monotonic `seq` generated in the Node.js event bus.

Decision:

- Assume only per-message atomicity.
- Do not assume global total order across concurrent senders.
- Add `seq` and preserve `createdAt` if Stage 3 continues.

### Failure Handling

Result: broker startup is retried, but message delivery is still best-effort and can fail permanently.

- `pi-intercom` will try to auto-start its local broker.
- The extension has reconnect backoff for broken broker connections.
- `send()` still fails if the target logger session is not connected, disconnects, times out, or the socket is already down.
- There is no durable outbound queue and no automatic resend of an application message after a failed `send()`.
- Delivery acknowledgements only confirm broker acceptance and forwarding attempt, not "logger wrote this event to disk".

Implication for ralpix:

- A plain `AgentEventEmitter` over `intercom send` is not enough for a single-writer guarantee.
- Falling back directly to `LogWriter.write()` from the sender would reintroduce multiple writers and race the logger session.

Decision:

- Do not use direct-write fallback as the default recovery path.
- If logger transport is unavailable, either:
  - keep Stage 1-2 direct logging as the production mode, or
  - introduce a ralpix-owned local spool that retries until a logger ack confirms the event reached disk.

### Durability

Result: already-written JSONL lines survive, but in-flight events can be lost.

- `LogWriter.write()` is append-only, so events already flushed by the logger session remain durable on disk.
- `pi-intercom` broker state is in memory only. Connected sessions and undelivered messages are not journaled.
- If the logger session or broker dies after the sender emitted an event but before the logger wrote it, that event is lost.
- Current `restoreState()` resumes ralpix phase state and points at an existing progress file, but it does not reconstruct missing progress events.

Implication for ralpix:

- Stage 3 cannot currently preserve the Stage 2 resume story.
- Resume would continue from the last saved plan/state checkpoint, but the JSONL transcript could have silent gaps.

Decision:

- Do not ship Stage 3 without ralpix-owned delivery guarantees.
- Minimum safe design:
  - sender-side spool on disk
  - event `seq`
  - logger ack after `LogWriter.write()`
  - replay of unacked events on reconnect/resume

### TUI Attachment

Result: TUI should stay in the Node.js process and must not go through `pi-intercom`.

- This is already the correct architectural boundary in Stage 2.
- TUI rendering is synchronous local UI work tied to the main ralpix process and its extension context.
- Routing TUI events through a logger `pi` session would add latency, duplicate rendering concerns, and create a new failure mode where logs continue but UI stops updating.

Decision:

- Keep `createTuiEmitter(ctx)` attached directly to the Node.js event bus.
- If Stage 3 ever ships, only the log-writing adapter changes. The TUI adapter does not move onto intercom.

## Required Redesign For Tasks 15-18

Tasks 15-18 should not be implemented as originally written. Replace them with the following requirements:

### Revised Task 15: Logger Protocol

- Define a ralpix logger protocol with:
  - `runId`
  - `phase`
  - `sessionName`
  - `seq`
  - event payload
  - ack message containing `seq` after disk write
- Logger session may still use `pi-intercom`, but it must ack only after `LogWriter.write()` succeeds.

### Revised Task 16: Durable Sender Adapter

- `adapters/logger-intercom.ts` must maintain a sender-side spool under `.ralpix/progress/pending/`.
- On emit:
  - assign `seq`
  - write pending record locally
  - send over intercom
  - remove pending record only after ack
- Reconnect/retry logic belongs to ralpix, not just `pi-intercom`.

### Revised Task 17: Bootstrap And Readiness

- `index.ts` must start the logger session before any phase emits runtime events.
- Bootstrap must wait for an explicit logger-ready handshake, not just broker availability.
- TUI stays local.
- Shutdown must drain or persist any unacked pending events before exit.

### Revised Task 18: E2E Coverage

- Add e2e tests for:
  - concurrent senders with stable `seq` replay
  - logger crash before ack
  - broker crash and reconnect
  - resume with pending events replayed and no duplicate JSONL lines

## Verdict

`pi-intercom` is acceptable for human/agent coordination messages.

It is not, by itself, a sufficient transport for ralpix's only JSONL writer. Without a ralpix-owned acked spool, Stage 3 weakens ordering guarantees, weakens resume durability, and risks silent transcript gaps.
