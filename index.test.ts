import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStatusWidgetView,
  markTaskExecutionFinished,
  markTaskExecutionStarted,
  normalizePlanPathArg,
  withRalpixErrorHandling,
} from "./index.js";

import type { RalpixState } from "./types.js";

void test("normalizePlanPathArg strips a leading file-mention marker", () => {
  assert.equal(
    normalizePlanPathArg("@docs/plans/my-feature.md"),
    "docs/plans/my-feature.md",
  );
});

void test("normalizePlanPathArg preserves normal paths", () => {
  assert.equal(
    normalizePlanPathArg("docs/plans/my-feature.md"),
    "docs/plans/my-feature.md",
  );
});

void test("normalizePlanPathArg preserves scoped names that are not paths", () => {
  assert.equal(
    normalizePlanPathArg("@scope/package"),
    "@scope/package",
  );
});

void test("withRalpixErrorHandling surfaces thrown errors via notify", async () => {
  const notices: string[] = [];

  await withRalpixErrorHandling(
    async () => await Promise.reject(new Error("boom")),
    (message, level) => {
      notices.push(`${level}:${message}`);
    },
  );

  assert.deepEqual(notices, ["error:ralpix error: boom"]);
});

void test("withRalpixErrorHandling leaves successful runs untouched", async () => {
  const notices: string[] = [];

  await withRalpixErrorHandling(
    async () => await Promise.resolve(),
    (message, level) => {
      notices.push(`${level}:${message}`);
    },
  );

  assert.deepEqual(notices, []);
});

void test("markTaskExecutionStarted tracks the active task", () => {
  const state: RalpixState = {
    planPath: "/tmp/plan.md",
    planTitle: "Demo",
    currentTaskId: null,
    phase: "executing",
    completedTasks: [],
    failedTasks: [],
    progressFile: "/tmp/progress.txt",
  };

  const next = markTaskExecutionStarted(state, "task-3");

  assert.equal(next.currentTaskId, "task-3");
  assert.deepEqual(next.completedTasks, []);
  assert.deepEqual(next.failedTasks, []);
});

void test("markTaskExecutionFinished records success and clears the active task", () => {
  const state: RalpixState = {
    planPath: "/tmp/plan.md",
    planTitle: "Demo",
    currentTaskId: "task-2",
    phase: "executing",
    completedTasks: ["task-1"],
    failedTasks: [],
    progressFile: "/tmp/progress.txt",
  };

  const next = markTaskExecutionFinished(state, "task-2", true);

  assert.equal(next.currentTaskId, null);
  assert.deepEqual(next.completedTasks, ["task-1", "task-2"]);
  assert.deepEqual(next.failedTasks, []);
});

void test("markTaskExecutionFinished records failure once and clears the active task", () => {
  const state: RalpixState = {
    planPath: "/tmp/plan.md",
    planTitle: "Demo",
    currentTaskId: "task-4",
    phase: "executing",
    completedTasks: ["task-1"],
    failedTasks: ["task-3"],
    progressFile: "/tmp/progress.txt",
  };

  const next = markTaskExecutionFinished(state, "task-4", false);

  assert.equal(next.currentTaskId, null);
  assert.deepEqual(next.completedTasks, ["task-1"]);
  assert.deepEqual(next.failedTasks, ["task-3", "task-4"]);
});

void test("buildStatusWidgetView renders flat steps list plus now panel", () => {
  const state: RalpixState = {
    planPath: "/tmp/plan.md",
    planTitle: "Demo",
    currentTaskId: null,
    phase: "reviewing",
    completedTasks: ["task-1"],
    failedTasks: [],
    progressFile: "/tmp/progress.txt",
    review: {
      stages: [
        { id: "first-pass", status: "complete" },
        { id: "external-review", status: "skipped" },
        { id: "external-eval", status: "skipped" },
        { id: "second-pass", status: "active", detail: "iteration 2/5" },
      ],
    },
  };

  const view = buildStatusWidgetView(
    state,
    [{ id: "task-1", title: "Task 1" }],
    1,
    { input: 4200, output: 2800, cost: 0.034 },
    new Map([["task-1", new Map([["opencode-go/deepseek-v4-pro", { input: 1000, output: 2000, cost: 0.01 }]])]]),
    new Map([
      ["first-pass", new Map([["opencode-go/glm-5.1", { input: 1000, output: 1200, cost: 0.01 }]])],
      ["second-pass", new Map([["opencode-go/glm-5.1", { input: 3200, output: 800, cost: 0.024 }]])],
    ]),
  );

  assert.equal(view.statusText, "📋 ralpix: reviewing 1/1  $0.034");
  assert.deepEqual(
    view.lines.map((line) => line.text),
    [
      "Plan: Demo",
      "Phase: reviewing | 1/1 tasks",
      "",
      "Steps",
      "✓ Task 1",
      "opencode-go/deepseek-v4-pro  in 1.0k  out 2.0k  $0.010",
      "First pass",
      "opencode-go/glm-5.1  in 1.0k  out 1.2k  $0.010",
      "Second pass",
      "opencode-go/glm-5.1  in 3.2k  out 800  $0.024",
      "",
      "Now",
      "Second pass — iteration 2/5",
      "opencode-go/glm-5.1  in 3.2k  out 800  $0.024",
      "",
      "Total",
      "in 4.2k  out 2.8k  $0.034",
    ],
  );
});
