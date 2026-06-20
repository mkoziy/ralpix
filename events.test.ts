import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, EventUsage } from "./events.js";
import type { Phase } from "./types.js";

function base(phase: Phase): { phase: Phase; createdAt: string } {
  return { phase, createdAt: "2026-06-20T00:00:00.000Z" };
}

// Helper that receives EventUsage with erased literal narrowing — lets us do
// genuine null / undefined checks on the optional breakdown field.
function assertBreakdown(usage: EventUsage): void {
  assert.ok(usage.breakdown != null);
  assert.equal(usage.breakdown.length, 1);
  const entry = usage.breakdown[0];
  assert.ok(entry != null);
  assert.equal(entry.provider, "anthropic");
  assert.equal(entry.model, "claude-sonnet-4-6");
  assert.equal(entry.input, 100);
  assert.equal(entry.output, 50);
  assert.equal(entry.cacheRead, 0);
  assert.equal(entry.cacheWrite, 0);
  assert.equal(entry.cost, 0.001);
}

// ---------------------------------------------------------------------------
// Base fields — every AgentEvent must carry phase + createdAt
// ---------------------------------------------------------------------------

void test("phase_start carries required base fields", () => {
  const event: AgentEvent = { type: "phase_start", ...base("brainstorm") };
  assert.equal(event.type, "phase_start");
  assert.equal(event.phase, "brainstorm");
  assert.ok(event.createdAt.length > 0);
  assert.equal(event.label, undefined);
});

void test("phase_end carries optional label", () => {
  const withLabel: AgentEvent = { type: "phase_end", ...base("plan"), label: "done" };
  assert.equal(withLabel.type, "phase_end");
  assert.equal(withLabel.label, "done");

  const withoutLabel: AgentEvent = { type: "phase_end", ...base("plan") };
  assert.equal(withoutLabel.type, "phase_end");
  assert.equal(withoutLabel.label, undefined);
});

// ---------------------------------------------------------------------------
// EventUsage shape — step, total, optional breakdown
// ---------------------------------------------------------------------------

void test("EventUsage step includes all token counters", () => {
  const usage: EventUsage = {
    step: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.001 },
    total: { input: 1000, output: 500, cost: 0.01 },
  };
  assert.equal(usage.step.input, 100);
  assert.equal(usage.step.output, 50);
  assert.equal(usage.step.cacheRead, 10);
  assert.equal(usage.step.cacheWrite, 5);
  assert.equal(usage.step.cost, 0.001);
  assert.equal(usage.total.input, 1000);
  assert.equal(usage.total.output, 500);
  assert.equal(usage.total.cost, 0.01);
  assert.equal(usage.breakdown, undefined);
});

void test("EventUsage accepts breakdown array", () => {
  const usage: EventUsage = {
    step: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    total: { input: 100, output: 50, cost: 0.001 },
    breakdown: [
      { provider: "anthropic", model: "claude-sonnet-4-6", input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    ],
  };
  assert.equal(usage.step.input, 100);
  assert.equal(usage.total.cost, 0.001);
  assertBreakdown(usage);
});

// ---------------------------------------------------------------------------
// Brainstorm events
// ---------------------------------------------------------------------------

void test("approach_selected carries approach string", () => {
  const event: AgentEvent = { type: "approach_selected", ...base("brainstorm"), approach: "incremental refactor" };
  assert.equal(event.type, "approach_selected");
  assert.equal(event.phase, "brainstorm");
  assert.equal(event.approach, "incremental refactor");
});

void test("section_validated carries section, passed, optional detail", () => {
  const passed: AgentEvent = {
    type: "section_validated",
    ...base("brainstorm"),
    section: "auth",
    passed: true,
  };
  assert.equal(passed.type, "section_validated");
  assert.equal(passed.section, "auth");
  assert.equal(passed.passed, true);
  assert.equal(passed.detail, undefined);

  const failed: AgentEvent = {
    type: "section_validated",
    ...base("brainstorm"),
    section: "api",
    passed: false,
    detail: "missing rate limiting",
  };
  assert.equal(failed.type, "section_validated");
  assert.equal(failed.section, "api");
  assert.equal(failed.passed, false);
  assert.equal(failed.detail, "missing rate limiting");
});

void test("round_end carries round number and usage", () => {
  const usage: EventUsage = {
    step: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.0005 },
    total: { input: 200, output: 80, cost: 0.002 },
  };
  const event: AgentEvent = {
    type: "round_end",
    ...base("brainstorm"),
    round: 2,
    usage,
  };
  assert.equal(event.type, "round_end");
  assert.equal(event.round, 2);
  assert.equal(event.usage.step.input, 50);
  assert.equal(event.usage.total.cost, 0.002);
});

// ---------------------------------------------------------------------------
// Plan events
// ---------------------------------------------------------------------------

void test("draft_generated carries digest", () => {
  const event: AgentEvent = {
    type: "draft_generated",
    ...base("plan"),
    digest: "abc123",
  };
  assert.equal(event.type, "draft_generated");
  assert.equal(event.digest, "abc123");
});

void test("review_result source is ai | critic | user", () => {
  const fromAi: AgentEvent = {
    type: "review_result",
    ...base("plan"),
    source: "ai",
    action: "accept",
  };
  assert.equal(fromAi.type, "review_result");
  assert.equal(fromAi.source, "ai");
  assert.equal(fromAi.action, "accept");

  const fromUser: AgentEvent = {
    type: "review_result",
    ...base("plan"),
    source: "user",
    action: "reject",
    digest: "rev-1",
  };
  assert.equal(fromUser.type, "review_result");
  assert.equal(fromUser.source, "user");
  assert.equal(fromUser.action, "reject");
  assert.equal(fromUser.digest, "rev-1");
});

// ---------------------------------------------------------------------------
// Execute events
// ---------------------------------------------------------------------------

void test("task_start carries taskId, taskNumber, taskTitle, itemCount", () => {
  const event: AgentEvent = {
    type: "task_start",
    ...base("execute"),
    taskId: "task-1",
    taskNumber: 1,
    taskTitle: "Add tests",
    itemCount: 3,
  };
  assert.equal(event.type, "task_start");
  assert.equal(event.taskId, "task-1");
  assert.equal(event.taskNumber, 1);
  assert.equal(event.taskTitle, "Add tests");
  assert.equal(event.itemCount, 3);
});

void test("attempt_end carries usage and success flag", () => {
  const usage: EventUsage = {
    step: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
    total: { input: 400, output: 200, cost: 0.004 },
  };
  const event: AgentEvent = {
    type: "attempt_end",
    ...base("execute"),
    taskId: "task-1",
    attempt: 1,
    success: true,
    usage,
  };
  assert.equal(event.type, "attempt_end");
  assert.equal(event.taskId, "task-1");
  assert.equal(event.attempt, 1);
  assert.equal(event.success, true);
  assert.equal(event.usage.total.cost, 0.004);
});

void test("task_end includes committed and detail fields", () => {
  const usage: EventUsage = {
    step: { input: 300, output: 150, cacheRead: 0, cacheWrite: 0, cost: 0.003 },
    total: { input: 600, output: 300, cost: 0.006 },
    breakdown: [],
  };
  const event: AgentEvent = {
    type: "task_end",
    ...base("execute"),
    taskId: "task-1",
    taskNumber: 1,
    taskTitle: "Add tests",
    success: true,
    committed: true,
    usage,
  };
  assert.equal(event.type, "task_end");
  assert.equal(event.taskId, "task-1");
  assert.equal(event.taskNumber, 1);
  assert.equal(event.taskTitle, "Add tests");
  assert.equal(event.success, true);
  assert.equal(event.committed, true);
  assert.equal(event.detail, undefined);
  assert.ok(Array.isArray(event.usage.breakdown));
  assert.equal(event.usage.breakdown.length, 0);
});

// ---------------------------------------------------------------------------
// Review events
// ---------------------------------------------------------------------------

void test("stage_finish carries stage, status, and usage", () => {
  const usage: EventUsage = {
    step: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    total: { input: 5000, output: 2500, cost: 0.05 },
  };
  const event: AgentEvent = {
    type: "stage_finish",
    ...base("review"),
    stage: "first-pass",
    status: "complete",
    usage,
  };
  assert.equal(event.type, "stage_finish");
  assert.equal(event.stage, "first-pass");
  assert.equal(event.status, "complete");
  assert.equal(event.usage.step.input, 1000);
});

void test("iteration_end carries stage, iteration number, and usage", () => {
  const usage: EventUsage = {
    step: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.002 },
    total: { input: 800, output: 400, cost: 0.008 },
  };
  const event: AgentEvent = {
    type: "iteration_end",
    ...base("review"),
    stage: "second-pass",
    iteration: 3,
    usage,
  };
  assert.equal(event.type, "iteration_end");
  assert.equal(event.stage, "second-pass");
  assert.equal(event.iteration, 3);
  assert.equal(event.usage.step.output, 100);
});

// ---------------------------------------------------------------------------
// Status / milestone / usage_checkpoint
// ---------------------------------------------------------------------------

void test("status_changed carries state, now, optional next", () => {
  const event: AgentEvent = {
    type: "status_changed",
    ...base("execute"),
    state: "running",
    now: "Task 1: Add tests",
    next: "Task 2: Run tests",
  };
  assert.equal(event.type, "status_changed");
  assert.equal(event.state, "running");
  assert.equal(event.now, "Task 1: Add tests");
  assert.equal(event.next, "Task 2: Run tests");
});

void test("milestone carries kind and message", () => {
  const event: AgentEvent = {
    type: "milestone",
    ...base("execute"),
    kind: "RESULT",
    message: "Task complete",
  };
  assert.equal(event.type, "milestone");
  assert.equal(event.kind, "RESULT");
  assert.equal(event.message, "Task complete");
});

void test("usage_checkpoint carries totalUsageText", () => {
  const event: AgentEvent = {
    type: "usage_checkpoint",
    ...base("brainstorm"),
    totalUsageText: "in 2.1k  out 480  $0.032",
  };
  assert.equal(event.type, "usage_checkpoint");
  assert.equal(event.totalUsageText, "in 2.1k  out 480  $0.032");
});

// ---------------------------------------------------------------------------
// question / answer
// ---------------------------------------------------------------------------

void test("question carries promptId, message, optional next", () => {
  const event: AgentEvent = {
    type: "question",
    ...base("plan"),
    promptId: "prompt-1",
    message: "Choose auth approach",
  };
  assert.equal(event.type, "question");
  assert.equal(event.phase, "plan");
  assert.equal(event.promptId, "prompt-1");
  assert.equal(event.message, "Choose auth approach");
  assert.equal(event.next, undefined);
});

void test("answer carries optional usage", () => {
  const usage: EventUsage = {
    step: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.0001 },
    total: { input: 100, output: 50, cost: 0.001 },
  };
  const event: AgentEvent = {
    type: "answer",
    ...base("plan"),
    promptId: "prompt-1",
    message: "Use session cookies",
    usage,
  };
  assert.equal(event.type, "answer");
  assert.equal(event.promptId, "prompt-1");
  assert.equal(event.message, "Use session cookies");
  assert.equal(event.usage?.step.input, 10);
});
