import assert from "node:assert/strict";
import test from "node:test";

import { createEventBus } from "./event-bus.js";

import type { AgentEvent, AgentEventEmitter } from "./events.js";
import type { RunSession } from "./event-bus.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockCtx(): ExtensionCommandContext {
  const ctx: unknown = {
    hasUI: false,
    cwd: "/tmp/test",
    ui: {
      notify: () => { return; },
      select: async () => null,
      confirm: async () => null,
      input: async () => null,
      custom: () => { return; },
      setStatus: () => { return; },
      setWidget: () => { return; },
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  };
  return ctx as ExtensionCommandContext;
}

function makeCapturingSession(): { session: RunSession; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const emitter: AgentEventEmitter = { emit(e) { events.push(e); } };
  const session = createEventBus(makeMockCtx(), "plan", [emitter]);
  return { session, events };
}

function makeMinimalUsage() {
  return {
    step: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    total: { input: 200, output: 100, cost: 0.002 },
  };
}

// ---------------------------------------------------------------------------
// New plan event type shapes
// ---------------------------------------------------------------------------

void test("critic_start event has phase and createdAt", () => {
  const { session, events } = makeCapturingSession();
  session.log("critic_start");

  assert.equal(events.length, 1);
  const e = events[0];
  assert.ok(e != null);
  assert.equal(e.type, "critic_start");
  assert.equal(e.phase, "plan");
  assert.ok(typeof e.createdAt === "string" && e.createdAt.length > 0);
});

void test("critic_end event has digest and usage fields", () => {
  const { session, events } = makeCapturingSession();
  const usage = makeMinimalUsage();
  session.log("critic_end", { digest: "Critic: no critical issues", usage });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "critic_end") {
    assert.equal(e.digest, "Critic: no critical issues");
    assert.equal(e.usage.step.input, 100);
    assert.equal(e.usage.total.input, 200);
  } else {
    assert.fail(`expected critic_end, got ${e.type}`);
  }
});

void test("ai_review_start event has phase and createdAt", () => {
  const { session, events } = makeCapturingSession();
  session.log("ai_review_start");

  const e = events[0];
  assert.ok(e != null);
  assert.equal(e.type, "ai_review_start");
  assert.equal(e.phase, "plan");
});

void test("ai_review_end event has digest and usage fields", () => {
  const { session, events } = makeCapturingSession();
  const usage = makeMinimalUsage();
  session.log("ai_review_end", { digest: "Review: APPROVE — no issues", usage });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "ai_review_end") {
    assert.equal(e.digest, "Review: APPROVE — no issues");
    assert.ok(typeof e.usage.step.cost === "number");
    assert.ok(typeof e.usage.total.cost === "number");
  } else {
    assert.fail(`expected ai_review_end, got ${e.type}`);
  }
});

void test("human_review event has action field", () => {
  const { session, events } = makeCapturingSession();
  session.log("human_review", { action: "accept" });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "human_review") {
    assert.equal(e.action, "accept");
    assert.equal(e.phase, "plan");
  } else {
    assert.fail(`expected human_review, got ${e.type}`);
  }
});

void test("human_review emits correct action for each user choice", () => {
  const actions = ["accept", "reject", "reload", "revise"] as const;
  for (const action of actions) {
    const { session, events } = makeCapturingSession();
    session.log("human_review", { action });
    const e = events[0];
    assert.ok(e != null);
    if (e.type === "human_review") {
      assert.equal(e.action, action, `expected action="${action}"`);
    } else {
      assert.fail(`expected human_review, got ${e.type}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Plan generation event shapes
// ---------------------------------------------------------------------------

void test("round_end event has round number and usage with step and total", () => {
  const { session, events } = makeCapturingSession();
  const usage = makeMinimalUsage();
  session.log("round_end", { round: 1, usage });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "round_end") {
    assert.equal(e.round, 1);
    assert.equal(e.usage.step.output, 50);
    assert.equal(e.usage.total.output, 100);
  } else {
    assert.fail(`expected round_end, got ${e.type}`);
  }
});

void test("round_end event carries breakdown when provided", () => {
  const { session, events } = makeCapturingSession();
  const usage = {
    ...makeMinimalUsage(),
    breakdown: [{ provider: "anthropic", model: "claude-3-5-sonnet", input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 }],
  };
  session.log("round_end", { round: 2, usage });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "round_end") {
    assert.ok(Array.isArray(e.usage.breakdown));
    assert.equal(e.usage.breakdown?.length, 1);
    assert.equal(e.usage.breakdown?.[0]?.provider, "anthropic");
  } else {
    assert.fail(`expected round_end, got ${e.type}`);
  }
});

void test("draft_generated event has digest string", () => {
  const { session, events } = makeCapturingSession();
  session.log("draft_generated", { digest: '"My Plan" - 5 tasks, 20 items', round: 1 });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "draft_generated") {
    assert.ok(e.digest.includes("5 tasks"));
  } else {
    assert.fail(`expected draft_generated, got ${e.type}`);
  }
});

void test("question event has promptId and message fields", () => {
  const { session, events } = makeCapturingSession();
  session.log("question", { promptId: "r1", message: "Should this be a monorepo?" });

  const e = events[0];
  assert.ok(e != null);
  if (e.type === "question") {
    assert.equal(e.promptId, "r1");
    assert.equal(e.message, "Should this be a monorepo?");
    assert.equal(e.phase, "plan");
  } else {
    assert.fail(`expected question, got ${e.type}`);
  }
});

void test("answer event has promptId and message, question and answer share same promptId", () => {
  const { session, events } = makeCapturingSession();
  session.log("question", { promptId: "r2", message: "What database?" });
  session.log("answer", { promptId: "r2", message: "PostgreSQL" });

  const q = events.find((e) => e.type === "question");
  const a = events.find((e) => e.type === "answer");
  assert.ok(q != null && a != null);
  if (q.type === "question" && a.type === "answer") {
    assert.equal(q.promptId, "r2");
    assert.equal(a.promptId, "r2");
    assert.equal(a.message, "PostgreSQL");
  }
});

// ---------------------------------------------------------------------------
// Review cycle ordering
// ---------------------------------------------------------------------------

void test("review cycle emits ai_review_start, ai_review_end, critic_start, critic_end, human_review in order", () => {
  const { session, events } = makeCapturingSession();
  const usage = makeMinimalUsage();

  // Simulate the review cycle sequence emitted by planner.ts
  session.log("ai_review_start");
  session.log("ai_review_end", { digest: "Review: APPROVE — no issues", usage });
  session.log("critic_start");
  session.log("critic_end", { digest: "Critic: no critical issues", usage });
  session.log("human_review", { action: "accept" });

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["ai_review_start", "ai_review_end", "critic_start", "critic_end", "human_review"]);
});

void test("phase_start and phase_end bracket the plan session", () => {
  const { session, events } = makeCapturingSession();

  session.log("phase_start", { label: "create" });
  session.log("round_start", { round: 1 });
  session.log("round_end", { round: 1, usage: makeMinimalUsage() });
  session.log("phase_end", { label: "accepted" });

  assert.equal(events[0]?.type, "phase_start");
  assert.equal(events[events.length - 1]?.type, "phase_end");
  const first = events[0];
  const last = events[events.length - 1];
  if (first?.type === "phase_start") {
    assert.equal(first.label, "create");
  }
  if (last?.type === "phase_end") {
    assert.equal(last.label, "accepted");
  }
});

// ---------------------------------------------------------------------------
// Unknown event type guard
// ---------------------------------------------------------------------------

void test("session.log throws for unknown plan-specific event names", () => {
  const { session } = makeCapturingSession();
  assert.throws(
    () => { session.log("plan_clarification_old"); },
    (err: unknown) => err instanceof Error && err.message.includes("plan_clarification_old"),
  );
});
