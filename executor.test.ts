import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeAllTasks, executeTask } from "./executor.js";
import { createEventBus } from "./event-bus.js";

import type { AgentEvent, AgentEventEmitter } from "./events.js";
import type { RunSession } from "./event-bus.js";
import type { Plan, PlanTask, RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockCtx(cwd: string): ExtensionCommandContext {
  const ctx: unknown = {
    hasUI: false,
    cwd,
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

const MOCK_PI: ExtensionAPI = {} as ExtensionAPI;

function makeCapturingSession(ctx: ExtensionCommandContext): { session: RunSession; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const emitter: AgentEventEmitter = { emit(e) { events.push(e); } };
  const session = createEventBus(ctx, "execute", [emitter]);
  return { session, events };
}

const MINIMAL_CONFIG: RalpixConfig = {
  maxRetries: 0,
  commitEnabled: false,
  commitMessageTemplate: "task {{taskNumber}}: {{taskTitle}}",
  externalReviewEnabled: false,
  brainstormEnabled: false,
  plansDir: "docs/plans",
  defaultModel: null,
  defaultProvider: null,
  defaultEffort: null,
  piAgentDir: null,
  reviewEnabled: false,
  reviewFirstModel: null,
  reviewSecondModel: null,
  reviewFirstEffort: null,
  reviewSecondEffort: null,
  reviewMaxRetries: 0,
  reviewTimeoutMs: null,
  brainstormTimeoutMs: null,
  reviewMaxIterations: 2,
  externalReviewModel: null,
  externalReviewEffort: null,
  externalReviewMaxIterations: 3,
  externalReviewPatience: 2,
  planModel: null,
  planEffort: null,
  brainstormModel: null,
  brainstormEffort: null,
  epistemicEnabled: false,
  trainingCutoff: null,
  highRiskLibraries: null,
};

function makePlanTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: "task-1",
    number: 1,
    title: "Add tests",
    description: "Write unit tests",
    items: [],
    status: "pending",
    ...overrides,
  };
}

function writePlanFile(dir: string, tasks: Array<{ id: string; title: string }>): string {
  const taskSections = tasks.map((t, i) =>
    `### Task ${String(i + 1)}: ${t.title}\n\n- [ ] Do something\n`,
  ).join("\n");
  const content = `# Plan: Test Plan\n\n## Overview\nTest plan.\n\n${taskSections}`;
  const planPath = join(dir, "plan.md");
  writeFileSync(planPath, content, "utf-8");
  return planPath;
}

function makePlan(planPath: string, tasks: PlanTask[]): Plan {
  return {
    path: planPath,
    title: "Test Plan",
    overview: "Test plan.",
    context: "",
    successCriteria: [],
    tasks,
    extraSections: {},
  };
}

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "executor-test-"));
  return { dir, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------------------
// task_start / attempt_start / attempt_end / task_end sequence
// ---------------------------------------------------------------------------

void test("executeTask emits task_start then attempt_start then attempt_end then task_end on success", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeTask(ctx, MOCK_PI, task, MINIMAL_CONFIG, plan, {
      session,
      _runSession: async () => ({ success: true, summary: "Done", fullSummary: "Done" }),
    });

    const types = events.filter((e) =>
      e.type === "task_start" || e.type === "attempt_start" || e.type === "attempt_end" || e.type === "task_end",
    ).map((e) => e.type);
    assert.deepEqual(types, ["task_start", "attempt_start", "attempt_end", "task_end"]);
  } finally {
    cleanup();
  }
});

void test("task_start event has correct taskId, taskNumber, taskTitle, itemCount", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask({ items: [{ text: "item 1", done: false }, { text: "item 2", done: false }] });
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeTask(ctx, MOCK_PI, task, MINIMAL_CONFIG, plan, {
      session,
      _runSession: async () => ({ success: true, summary: "Done", fullSummary: "Done" }),
    });

    const e = events.find((ev) => ev.type === "task_start");
    assert.ok(e != null);
    if (e.type === "task_start") {
      assert.equal(e.taskId, "task-1");
      assert.equal(e.taskNumber, 1);
      assert.equal(e.taskTitle, "Add tests");
      assert.equal(e.itemCount, 2);
    }
  } finally {
    cleanup();
  }
});

void test("attempt_start event has taskId, attempt number, and modelLabel", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeTask(ctx, MOCK_PI, task, MINIMAL_CONFIG, plan, {
      session,
      _runSession: async () => ({ success: true, summary: "Done", fullSummary: "Done" }),
    });

    const e = events.find((ev) => ev.type === "attempt_start");
    assert.ok(e != null);
    if (e.type === "attempt_start") {
      assert.equal(e.taskId, "task-1");
      assert.equal(e.attempt, 1);
      assert.ok(typeof e.modelLabel === "string" || e.modelLabel === undefined);
    }
  } finally {
    cleanup();
  }
});

void test("attempt_end event has success=true and usage on success", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeTask(ctx, MOCK_PI, task, MINIMAL_CONFIG, plan, {
      session,
      _runSession: async () => ({ success: true, summary: "Done", fullSummary: "Done" }),
    });

    const e = events.find((ev) => ev.type === "attempt_end");
    assert.ok(e != null);
    if (e.type === "attempt_end") {
      assert.equal(e.success, true);
      assert.equal(e.taskId, "task-1");
      assert.ok(typeof e.usage.step.input === "number");
      assert.ok(typeof e.usage.total.cost === "number");
    }
  } finally {
    cleanup();
  }
});

void test("task_end event has success=true and usage on success", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeTask(ctx, MOCK_PI, task, MINIMAL_CONFIG, plan, {
      session,
      _runSession: async () => ({ success: true, summary: "Done", fullSummary: "Done" }),
    });

    const e = events.find((ev) => ev.type === "task_end");
    assert.ok(e != null);
    if (e.type === "task_end") {
      assert.equal(e.success, true);
      assert.equal(e.taskId, "task-1");
      assert.equal(e.taskNumber, 1);
      assert.equal(e.taskTitle, "Add tests");
      assert.ok(typeof e.usage.step.input === "number");
      assert.ok(typeof e.usage.total.cost === "number");
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Retry loop — multiple attempt_start events
// ---------------------------------------------------------------------------

void test("retry loop emits multiple attempt_start events", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);
    const config: RalpixConfig = { ...MINIMAL_CONFIG, maxRetries: 2 };

    await executeTask(ctx, MOCK_PI, task, config, plan, {
      session,
      _runSession: async () => ({ success: false, summary: "Failed", fullSummary: "Failed" }),
    });

    const starts = events.filter((e) => e.type === "attempt_start");
    assert.equal(starts.length, 3, "expected 3 attempt_start events (1 + 2 retries)");
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      if (s?.type === "attempt_start") {
        assert.equal(s.attempt, i + 1);
      }
    }
  } finally {
    cleanup();
  }
});

void test("retry loop emits attempt_end with success=false for each failed attempt", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);
    const config: RalpixConfig = { ...MINIMAL_CONFIG, maxRetries: 1 };

    await executeTask(ctx, MOCK_PI, task, config, plan, {
      session,
      _runSession: async () => ({ success: false, summary: "Failed", fullSummary: "Failed" }),
    });

    const ends = events.filter((e) => e.type === "attempt_end");
    assert.equal(ends.length, 2, "expected 2 attempt_end events (1 + 1 retry)");
    for (const e of ends) {
      if (e.type === "attempt_end") {
        assert.equal(e.success, false);
      }
    }
  } finally {
    cleanup();
  }
});

void test("final task_end has success=false and detail after all retries exhausted", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task = makePlanTask();
    const planPath = writePlanFile(dir, [{ id: task.id, title: task.title }]);
    const plan = makePlan(planPath, [task]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeTask(ctx, MOCK_PI, task, MINIMAL_CONFIG, plan, {
      session,
      _runSession: async () => ({ success: false, summary: "Test failure", fullSummary: "Full test failure" }),
    });

    const e = events.find((ev) => ev.type === "task_end");
    assert.ok(e != null);
    if (e.type === "task_end") {
      assert.equal(e.success, false);
      assert.equal(e.detail, "Full test failure");
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// executeAllTasks — 2-task plan
// ---------------------------------------------------------------------------

void test("executeAllTasks emits task_start and task_end for each of 2 tasks", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task1 = makePlanTask({ id: "t1", number: 1, title: "Task One" });
    const task2 = makePlanTask({ id: "t2", number: 2, title: "Task Two" });
    const planPath = writePlanFile(dir, [
      { id: task1.id, title: task1.title },
      { id: task2.id, title: task2.title },
    ]);
    const plan = makePlan(planPath, [task1, task2]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeAllTasks(ctx, MOCK_PI, plan, MINIMAL_CONFIG, {
      session,
      _runSession: async () => ({ success: true, summary: "Done", fullSummary: "Done" }),
    });

    const taskStarts = events.filter((e) => e.type === "task_start").map((e) => e.type === "task_start" ? e.taskTitle : "");
    const taskEnds = events.filter((e) => e.type === "task_end").map((e) => e.type === "task_end" ? e.taskTitle : "");
    assert.deepEqual(taskStarts, ["Task One", "Task Two"]);
    assert.deepEqual(taskEnds, ["Task One", "Task Two"]);
  } finally {
    cleanup();
  }
});

void test("executeAllTasks stops after first task failure", async () => {
  const { dir, cleanup } = makeTmpDir();
  try {
    const task1 = makePlanTask({ id: "t1", number: 1, title: "Task One" });
    const task2 = makePlanTask({ id: "t2", number: 2, title: "Task Two" });
    const planPath = writePlanFile(dir, [
      { id: task1.id, title: task1.title },
      { id: task2.id, title: task2.title },
    ]);
    const plan = makePlan(planPath, [task1, task2]);
    const ctx = makeMockCtx(dir);
    const { session, events } = makeCapturingSession(ctx);

    await executeAllTasks(ctx, MOCK_PI, plan, MINIMAL_CONFIG, {
      session,
      _runSession: async () => ({ success: false, summary: "Failed", fullSummary: "Failed" }),
    });

    const taskStarts = events.filter((e) => e.type === "task_start");
    assert.equal(taskStarts.length, 1, "should stop after first task failure");
  } finally {
    cleanup();
  }
});
