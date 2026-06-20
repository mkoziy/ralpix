import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findNextPendingTask, loadPlan, parsePlan, updatePlanTaskStatus } from "../parser.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const MINIMAL = `
# Plan: Test Plan

## Overview
A simple overview.

### Task 1: Do Something
- [ ] first item
- [ ] second item

### Task 2: Do Another Thing
- [x] already done
`.trim();

const WITH_COMPLETED = `
# Plan: Completed Tasks

### Task 1: First Task
- [x] item a
- [x] item b

### Task 2: Partial Task
- [x] done item
- [ ] pending item

### Task 3: Fresh Task
- [ ] only item
`.trim();

const EMPTY_PLAN = "# Plan: Empty".trim();

const MALFORMED = `
no heading at all
- [ ] orphan checkbox
### not a task header
- [ ] another orphan
`.trim();

const WITH_CRITERIA = `
# Plan: Criteria Plan

## Success Criteria
- [ ] criterion one
- [x] criterion two already met

### Task 1: Only Task
- [ ] do it
`.trim();

const WITH_EXTRA_SECTIONS = `
# Plan: Extra Sections Plan

## Overview
Main overview.

## Design Decisions
Some design notes here.

### Task 1: The Task
- [ ] item
`.trim();

// ── parsePlan ──────────────────────────────────────────────────────────────

describe("parsePlan — title", () => {
  it("extracts plan title from H1", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.title).toBe("Test Plan");
  });

  it("defaults to 'Untitled Plan' when no H1", () => {
    const plan = parsePlan("### Task 1: Foo\n- [ ] item");
    expect(plan.title).toBe("Untitled Plan");
  });
});

describe("parsePlan — empty plan", () => {
  it("returns plan with no tasks", () => {
    const plan = parsePlan(EMPTY_PLAN);
    expect(plan.tasks).toHaveLength(0);
    expect(plan.successCriteria).toHaveLength(0);
  });
});

describe("parsePlan — tasks", () => {
  it("parses two tasks with correct ids and numbers", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]!.id).toBe("task-1");
    expect(plan.tasks[0]!.number).toBe(1);
    expect(plan.tasks[1]!.id).toBe("task-2");
    expect(plan.tasks[1]!.number).toBe(2);
  });

  it("parses task titles", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.tasks[0]!.title).toBe("Task 1: Do Something");
    expect(plan.tasks[1]!.title).toBe("Task 2: Do Another Thing");
  });

  it("parses checkboxes into items", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.tasks[0]!.items).toHaveLength(2);
    expect(plan.tasks[0]!.items[0]!.text).toBe("first item");
    expect(plan.tasks[0]!.items[0]!.done).toBe(false);
    expect(plan.tasks[0]!.items[1]!.done).toBe(false);
  });

  it("marks done items correctly", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.tasks[1]!.items[0]!.done).toBe(true);
  });
});

describe("parsePlan — task status inference", () => {
  it("pending when no items done", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.tasks[0]!.status).toBe("pending");
  });

  it("completed when all items done", () => {
    const plan = parsePlan(WITH_COMPLETED);
    expect(plan.tasks[0]!.status).toBe("completed");
  });

  it("in-progress when some items done", () => {
    const plan = parsePlan(WITH_COMPLETED);
    expect(plan.tasks[1]!.status).toBe("in-progress");
  });

  it("pending when no items done at all", () => {
    const plan = parsePlan(WITH_COMPLETED);
    expect(plan.tasks[2]!.status).toBe("pending");
  });
});

describe("parsePlan — success criteria", () => {
  it("parses success criteria items", () => {
    const plan = parsePlan(WITH_CRITERIA);
    expect(plan.successCriteria).toHaveLength(2);
    expect(plan.successCriteria[0]!.text).toBe("criterion one");
    expect(plan.successCriteria[0]!.done).toBe(false);
    expect(plan.successCriteria[1]!.done).toBe(true);
  });
});

describe("parsePlan — overview", () => {
  it("captures overview text", () => {
    const plan = parsePlan(MINIMAL);
    expect(plan.overview).toBe("A simple overview.");
  });

  it("empty string when no overview section", () => {
    const plan = parsePlan(EMPTY_PLAN);
    expect(plan.overview).toBe("");
  });
});

describe("parsePlan — extra sections", () => {
  it("captures extra H2 sections into extraSections", () => {
    const plan = parsePlan(WITH_EXTRA_SECTIONS);
    expect(plan.extraSections["Design Decisions"]).toBe("Some design notes here.");
  });
});

describe("parsePlan — malformed input", () => {
  it("returns empty tasks for malformed input", () => {
    const plan = parsePlan(MALFORMED);
    expect(plan.tasks).toHaveLength(0);
  });

  it("does not throw on empty string", () => {
    expect(() => parsePlan("")).not.toThrow();
  });

  it("sourcePath is set on returned plan", () => {
    const plan = parsePlan(MINIMAL, "/some/path.md");
    expect(plan.path).toBe("/some/path.md");
  });
});

// ── findNextPendingTask ────────────────────────────────────────────────────

describe("findNextPendingTask", () => {
  it("returns first pending task", () => {
    const plan = parsePlan(WITH_COMPLETED);
    const task = findNextPendingTask(plan);
    expect(task?.id).toBe("task-3");
  });

  it("returns null when all tasks completed", () => {
    const allDone = `
# Plan: Done

### Task 1: Finished
- [x] done item
`.trim();
    const plan = parsePlan(allDone);
    expect(findNextPendingTask(plan)).toBeNull();
  });

  it("returns null for empty plan", () => {
    expect(findNextPendingTask(parsePlan(EMPTY_PLAN))).toBeNull();
  });
});

// ── loadPlan ───────────────────────────────────────────────────────────────

describe("loadPlan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralpix-parser-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads file and returns parsed plan with correct path", () => {
    const planPath = join(tmpDir, "plan.md");
    writeFileSync(planPath, MINIMAL, "utf-8");
    const plan = loadPlan(planPath);
    expect(plan.title).toBe("Test Plan");
    expect(plan.path).toBe(planPath);
    expect(plan.tasks).toHaveLength(2);
  });

  it("throws when file not found", () => {
    expect(() => loadPlan(join(tmpDir, "nonexistent.md"))).toThrow("Plan file not found");
  });
});

// ── updatePlanTaskStatus ───────────────────────────────────────────────────

describe("updatePlanTaskStatus", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralpix-parser-update-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks all task checkboxes done on completed", () => {
    const planPath = join(tmpDir, "plan.md");
    writeFileSync(planPath, MINIMAL, "utf-8");
    updatePlanTaskStatus(planPath, "task-1", "Task 1: Do Something", "completed");
    const updated = loadPlan(planPath);
    expect(updated.tasks[0]!.items.every((i) => i.done)).toBe(true);
  });

  it("marks all task checkboxes undone on failed", () => {
    const planPath = join(tmpDir, "plan.md");
    writeFileSync(planPath, WITH_COMPLETED, "utf-8");
    updatePlanTaskStatus(planPath, "task-1", "Task 1: First Task", "failed");
    const updated = loadPlan(planPath);
    expect(updated.tasks[0]!.items.every((i) => !i.done)).toBe(true);
  });

  it("does not affect other tasks", () => {
    const planPath = join(tmpDir, "plan.md");
    writeFileSync(planPath, MINIMAL, "utf-8");
    updatePlanTaskStatus(planPath, "task-1", "Task 1: Do Something", "completed");
    const updated = loadPlan(planPath);
    expect(updated.tasks[1]!.items[0]!.done).toBe(true);
  });
});
