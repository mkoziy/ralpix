import { describe, expect, it, vi } from "vitest";

import { createEventBus } from "../event-bus.js";

import type { AgentEventEmitter } from "../events.js";

function makeCtx() {
  return {
    cwd: "/tmp/test",
    hasUI: false,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
    sessionManager: {
      appendModelChange: vi.fn(),
      appendThinkingLevelChange: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
    },
    newSession: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeEmitter() {
  const events: unknown[] = [];
  const emitter: AgentEventEmitter = {
    emit(e) {
      events.push(e);
    },
  };
  return { emitter, events };
}

describe("createEventBus — log()", () => {
  it("emits a valid event to all registered emitters in order", () => {
    const ctx = makeCtx();
    const { emitter: e1, events: ev1 } = makeEmitter();
    const { emitter: e2, events: ev2 } = makeEmitter();
    const session = createEventBus(ctx, "execute", [e1, e2]);

    session.log("phase_start");

    expect(ev1).toHaveLength(1);
    expect(ev2).toHaveLength(1);
    expect((ev1[0] as { type: string }).type).toBe("phase_start");
    expect((ev2[0] as { type: string }).type).toBe("phase_start");
  });

  it("attaches phase and createdAt automatically", () => {
    const ctx = makeCtx();
    const { emitter, events } = makeEmitter();
    const session = createEventBus(ctx, "brainstorm", [emitter]);

    session.log("phase_start");

    const event = events[0] as { phase: string; createdAt: string };
    expect(event.phase).toBe("brainstorm");
    expect(typeof event.createdAt).toBe("string");
    expect(() => new Date(event.createdAt)).not.toThrow();
  });

  it("throws at log() call site when event is malformed, not later", () => {
    const ctx = makeCtx();
    const { emitter, events } = makeEmitter();
    const session = createEventBus(ctx, "execute", [emitter]);

    expect(() => session.log("phase_start", { unexpectedField: "x", round: "not-a-number" as unknown as number })).toThrow();
    expect(() => session.log("round_end", { round: "bad" as unknown as number, usage: null as unknown as object })).toThrow();
    expect(events).toHaveLength(0);
  });

  it("emits data fields merged with base", () => {
    const ctx = makeCtx();
    const { emitter, events } = makeEmitter();
    const session = createEventBus(ctx, "plan", [emitter]);

    session.log("milestone", { kind: "OK", message: "done" });

    const event = events[0] as { type: string; kind: string; message: string; phase: string };
    expect(event.type).toBe("milestone");
    expect(event.kind).toBe("OK");
    expect(event.message).toBe("done");
    expect(event.phase).toBe("plan");
  });

  it("throws for unknown event type", () => {
    const ctx = makeCtx();
    const session = createEventBus(ctx, "execute", []);
    expect(() => session.log("not_a_real_event")).toThrow();
  });
});

describe("createEventBus — dispatch order", () => {
  it("calls emitters in registration order", () => {
    const ctx = makeCtx();
    const order: string[] = [];
    const e1: AgentEventEmitter = {
      emit() {
        order.push("first");
      },
    };
    const e2: AgentEventEmitter = {
      emit() {
        order.push("second");
      },
    };
    const session = createEventBus(ctx, "execute", [e1, e2]);

    session.log("phase_start");

    expect(order).toEqual(["first", "second"]);
  });
});

describe("createEventBus — shorthands", () => {
  it("milestone() emits milestone event", () => {
    const ctx = makeCtx();
    const { emitter, events } = makeEmitter();
    const session = createEventBus(ctx, "execute", [emitter]);

    session.milestone("OK", "task done");

    const event = events[0] as { type: string; kind: string; message: string };
    expect(event.type).toBe("milestone");
    expect(event.kind).toBe("OK");
    expect(event.message).toBe("task done");
  });

  it("statusChanged() emits status_changed event with optional next", () => {
    const ctx = makeCtx();
    const { emitter, events } = makeEmitter();
    const session = createEventBus(ctx, "execute", [emitter]);

    session.statusChanged("running", "doing work");
    session.statusChanged("waiting", "asking user", "review");

    const e1 = events[0] as { type: string; state: string; now: string; next?: string };
    expect(e1.type).toBe("status_changed");
    expect(e1.state).toBe("running");
    expect(e1.now).toBe("doing work");
    expect(e1.next).toBeUndefined();

    const e2 = events[1] as { type: string; next?: string };
    expect(e2.next).toBe("review");
  });

  it("usageCheckpoint() emits usage_checkpoint event", () => {
    const ctx = makeCtx();
    const { emitter, events } = makeEmitter();
    const session = createEventBus(ctx, "execute", [emitter]);

    session.usageCheckpoint("in 1k out 2k $0.01");

    const event = events[0] as { type: string; totalUsageText: string };
    expect(event.type).toBe("usage_checkpoint");
    expect(event.totalUsageText).toBe("in 1k out 2k $0.01");
  });
});
