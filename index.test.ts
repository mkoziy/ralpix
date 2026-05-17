import assert from "node:assert/strict";
import test from "node:test";

import {
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
