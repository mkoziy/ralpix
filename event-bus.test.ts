import assert from "node:assert/strict";
import test from "node:test";

import {
  createEventBus,
  createLogWriterEmitter,
} from "./event-bus.js";

import type { AgentEvent, AgentEventEmitter } from "./events.js";
import type { LogWriter } from "./logger.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Minimal ctx mock — hasUI: false keeps createSummaryTui in no-op mode
// (no setWidget or ctx.ui.custom calls are made at runtime)
// ---------------------------------------------------------------------------

function makeMockCtx(): ExtensionCommandContext {
  const ctx: unknown = {
    hasUI: false,
    cwd: "/tmp/test",
    ui: {
      notify: () => { return; },
      select: () => { throw new Error("select not called in tests"); },
      confirm: () => { throw new Error("confirm not called in tests"); },
      input: () => { throw new Error("input not called in tests"); },
      custom: () => { throw new Error("custom not called in tests"); },
      setStatus: () => { return; },
      setWidget: () => { return; },
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  };
  return ctx as ExtensionCommandContext;
}

// ---------------------------------------------------------------------------
// createLogWriterEmitter — strips phase/createdAt/type, calls logger.write
// ---------------------------------------------------------------------------

void test("createLogWriterEmitter dispatches event type as event name", () => {
  const calls: Array<{ event: string; data: Record<string, unknown> }> = [];
  const mockLogger = {
    write(event: string, data: Record<string, unknown> = {}) {
      calls.push({ event, data });
    },
  } as unknown as LogWriter;

  const emitter = createLogWriterEmitter(mockLogger);
  emitter.emit({
    type: "milestone",
    phase: "execute",
    createdAt: "2026-06-20T10:00:00.000Z",
    kind: "RESULT",
    message: "Task 1 complete",
  });

  assert.equal(calls.length, 1);
  assert.ok(calls[0] != null);
  assert.equal(calls[0].event, "milestone");
});

void test("createLogWriterEmitter strips type, phase, createdAt from data", () => {
  const calls: Array<{ event: string; data: Record<string, unknown> }> = [];
  const mockLogger = {
    write(event: string, data: Record<string, unknown> = {}) {
      calls.push({ event, data });
    },
  } as unknown as LogWriter;

  const emitter = createLogWriterEmitter(mockLogger);
  emitter.emit({
    type: "task_start",
    phase: "execute",
    createdAt: "2026-06-20T10:00:00.000Z",
    taskId: "t1",
    taskNumber: 1,
    taskTitle: "Add tests",
    itemCount: 3,
  });

  assert.ok(calls[0] != null);
  const data = calls[0].data;
  assert.equal("type" in data, false);
  assert.equal("phase" in data, false);
  assert.equal("createdAt" in data, false);
  assert.equal(data["taskId"], "t1");
  assert.equal(data["itemCount"], 3);
});

// ---------------------------------------------------------------------------
// createEventBus — emitter dispatch order
// ---------------------------------------------------------------------------

void test("createEventBus dispatches log() to external emitters in order", () => {
  const received: Array<{ emitter: number; type: string }> = [];

  const emitter1: AgentEventEmitter = {
    emit(event) {
      received.push({ emitter: 1, type: event.type });
    },
  };
  const emitter2: AgentEventEmitter = {
    emit(event) {
      received.push({ emitter: 2, type: event.type });
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter1, emitter2]);
  session.log("phase_start");

  assert.equal(received.length, 2);
  assert.deepEqual(received[0], { emitter: 1, type: "phase_start" });
  assert.deepEqual(received[1], { emitter: 2, type: "phase_start" });
});

void test("createEventBus log() emitted event has phase and createdAt", () => {
  const received: AgentEvent[] = [];
  const emitter: AgentEventEmitter = {
    emit(event) {
      received.push(event);
    },
  };

  const session = createEventBus(makeMockCtx(), "brainstorm", [emitter]);
  session.log("phase_start");

  assert.ok(received[0] != null);
  assert.equal(received[0].type, "phase_start");
  assert.equal(received[0].phase, "brainstorm");
  assert.ok(received[0].createdAt.length > 0);
});

void test("createEventBus log() merges data fields into event", () => {
  const received: AgentEvent[] = [];
  const emitter: AgentEventEmitter = {
    emit(event) {
      received.push(event);
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter]);
  session.log("milestone", { kind: "RESULT", message: "Done" });

  assert.ok(received[0] != null);
  const event = received[0];
  if (event.type === "milestone") {
    assert.equal(event.kind, "RESULT");
    assert.equal(event.message, "Done");
  } else {
    assert.fail(`expected milestone event, got ${event.type}`);
  }
});

// ---------------------------------------------------------------------------
// createEventBus — unknown event type throws at emit time (not at read time)
// ---------------------------------------------------------------------------

void test("session.log throws immediately for unknown event type", () => {
  const session = createEventBus(makeMockCtx(), "execute", []);
  assert.throws(
    () => { session.log("completely_unknown_event_type_xyz"); },
    (err: unknown) => err instanceof Error && err.message.includes("completely_unknown_event_type_xyz"),
  );
});

void test("unknown event type does not reach emitters before throw", () => {
  let emitterCalled = false;
  const emitter: AgentEventEmitter = {
    emit() {
      emitterCalled = true;
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter]);
  try {
    session.log("not_a_real_event");
  } catch {
    // expected
  }
  assert.equal(emitterCalled, false);
});

// ---------------------------------------------------------------------------
// createEventBus — message/status/usage delegate to log()
// ---------------------------------------------------------------------------

void test("session.message maps all kinds to correct AgentEvent milestone kinds", () => {
  const received: AgentEvent[] = [];
  const emitter: AgentEventEmitter = {
    emit(event) {
      received.push(event);
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter]);

  const cases: Array<{ kind: Parameters<typeof session.message>[0]; expected: string }> = [
    { kind: "info", expected: "INFO" },
    { kind: "success", expected: "OK" },
    { kind: "warning", expected: "WARN" },
    { kind: "error", expected: "ERR" },
    { kind: "result", expected: "RESULT" },
  ];

  for (const { kind, expected } of cases) {
    received.length = 0;
    session.message(kind, "test");
    assert.ok(received[0] != null);
    const event = received[0];
    if (event.type === "milestone") {
      assert.equal(event.kind, expected, `message(${kind}) should produce kind ${expected}`);
    } else {
      assert.fail(`expected milestone event, got ${event.type}`);
    }
  }
});

void test("session.status produces status_changed AgentEvent", () => {
  const received: AgentEvent[] = [];
  const emitter: AgentEventEmitter = {
    emit(event) {
      received.push(event);
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter]);
  session.status("running", "Executing task 1", "Task 2 next");

  assert.ok(received[0] != null);
  const event = received[0];
  if (event.type === "status_changed") {
    assert.equal(event.state, "running");
    assert.equal(event.now, "Executing task 1");
    assert.equal(event.next, "Task 2 next");
  } else {
    assert.fail(`expected status_changed event, got ${event.type}`);
  }
});

void test("session.usage produces usage_checkpoint AgentEvent", () => {
  const received: AgentEvent[] = [];
  const emitter: AgentEventEmitter = {
    emit(event) {
      received.push(event);
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter]);
  session.usage("in 1.5k  out 300  $0.012");

  assert.ok(received[0] != null);
  const event = received[0];
  if (event.type === "usage_checkpoint") {
    assert.equal(event.totalUsageText, "in 1.5k  out 300  $0.012");
  } else {
    assert.fail(`expected usage_checkpoint event, got ${event.type}`);
  }
});

// ---------------------------------------------------------------------------
// createEventBus — phase tracking
// ---------------------------------------------------------------------------

void test("session.phase() updates the phase on subsequently emitted events", () => {
  const received: AgentEvent[] = [];
  const emitter: AgentEventEmitter = {
    emit(event) {
      received.push(event);
    },
  };

  const session = createEventBus(makeMockCtx(), "execute", [emitter]);
  session.log("phase_start");
  session.phase("review");
  session.log("phase_start");

  assert.ok(received[0] != null);
  assert.ok(received[1] != null);
  assert.equal(received[0].phase, "execute");
  assert.equal(received[1].phase, "review");
});
