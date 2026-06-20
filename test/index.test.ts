import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildStatusWidgetView,
  createRalpixCommandHandler,
  inferProgressLogPhase,
  migrateLegacyProgressLogs,
  persistState,
  restoreState,
} from "../index.js";

import type { RalpixConfig, RalpixState } from "../types.js";

const CONFIG: RalpixConfig = {
  defaultModel: "gpt-5.5",
  defaultProvider: "openai-codex",
  defaultEffort: "medium",
  piAgentDir: null,
  commitEnabled: true,
  commitMessageTemplate: "ralpix: {{taskTitle}}",
  reviewEnabled: true,
  reviewFirstModel: "gpt-5.5",
  reviewSecondModel: "gpt-5.5",
  reviewFirstEffort: "medium",
  reviewSecondEffort: "medium",
  maxRetries: 2,
  reviewMaxRetries: 1,
  reviewTimeoutMs: 1000,
  brainstormTimeoutMs: 1000,
  reviewMaxIterations: 2,
  externalReviewEnabled: false,
  externalReviewModel: null,
  externalReviewEffort: null,
  externalReviewMaxIterations: 1,
  externalReviewPatience: 1,
  planModel: "gpt-5.5",
  planEffort: "medium",
  brainstormEnabled: true,
  brainstormModel: "gpt-5.5",
  brainstormEffort: "medium",
  plansDir: "docs/plans",
  epistemicEnabled: false,
  trainingCutoff: null,
  highRiskLibraries: null,
};

const PLAN_TEXT = `
# Plan: Index Integration

## Overview
Wire the CLI.

### Task 1: Build router
- [ ] route commands
`.trim();

function makeCtx(cwd: string, hasUI = true) {
  return {
    cwd,
    hasUI,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    },
    sessionManager: {
      appendModelChange: vi.fn(),
      appendThinkingLevelChange: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
    },
    newSession: vi.fn(),
  };
}

function makePi() {
  return {
    registerCommand: vi.fn(),
  };
}

function makePlanFixture() {
  const cwd = join(tmpdir(), `ralpix-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const planPath = join(cwd, "docs", "plans", "index-plan.md");
  mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
  writeFileSync(planPath, `${PLAN_TEXT}\n`, "utf8");
  return { cwd, planPath };
}

describe("createRalpixCommandHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes init, brainstorm, plan, review, and execute commands", async () => {
    const { cwd, planPath } = makePlanFixture();
    const ctx = makeCtx(cwd);
    const pi = makePi();
    const runBrainstorm = vi.fn().mockResolvedValue({ sessionName: "brainstorm-1" });
    const runPlanCreation = vi.fn().mockResolvedValue({ planPath, plan: { title: "Index Integration" } });
    const runStandaloneReview = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
    });
    const executeAllTasks = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      writeFileSync(planPath, PLAN_TEXT.replace("- [ ] route commands", "- [x] route commands"), "utf8");
    });
    const runReviewPipeline = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
    });
    const initRalpixHome = vi.fn().mockReturnValue({ created: ["a"], overwritten: [], skipped: [] });

    const handler = createRalpixCommandHandler(pi, {
      now: () => new Date("2026-06-20T12:00:00.000Z"),
      loadConfig: () => CONFIG,
      resolvePiAgentDir: () => null,
      initRalpixHome,
      runBrainstorm,
      runPlanCreation,
      runStandaloneReview,
      executeAllTasks,
      runReviewPipeline,
      loadPlan: () => ({
        path: planPath,
        title: "Index Integration",
        overview: "",
        context: "",
        successCriteria: [],
        tasks: [{
          id: "task-1",
          number: 1,
          title: "Task 1: Build router",
          description: "",
          items: [{ text: "route commands", done: true }],
          status: "completed",
        }],
        extraSections: {},
      }),
      getCurrentBranch: () => "feature/index",
    });

    await handler("init", ctx);
    await handler("brainstorm add routing", ctx);
    await handler("plan create command router", ctx);
    await handler("review", ctx);
    await handler(`execute ${planPath}`, ctx);

    expect(initRalpixHome).toHaveBeenCalledOnce();
    expect(runBrainstorm).toHaveBeenCalledOnce();
    expect(runPlanCreation).toHaveBeenCalledOnce();
    expect(runStandaloneReview).toHaveBeenCalledOnce();
    expect(executeAllTasks).toHaveBeenCalledOnce();
    expect(runReviewPipeline).toHaveBeenCalledOnce();
  });

  it("migrates legacy progress logs, restores state, offers a branch switch, and moves the plan on success", async () => {
    const { cwd, planPath } = makePlanFixture();
    const ctx = makeCtx(cwd);
    const pi = makePi();
    const progressRoot = join(cwd, ".ralpix", "progress");
    mkdirSync(progressRoot, { recursive: true });

    const legacyLog = join(progressRoot, "index-plan.jsonl");
    writeFileSync(
      legacyLog,
      `${JSON.stringify({ type: "task_start", taskId: "task-1", taskNumber: 1, taskTitle: "Task 1", itemCount: 1 })}\n`,
      "utf8",
    );

    persistState(cwd, {
      planPath,
      planTitle: "Index Integration",
      currentTaskId: "task-1",
      phase: "executing",
      completedTasks: [],
      failedTasks: [],
      progressFile: legacyLog,
    });

    const loadPlan = vi.fn()
      .mockReturnValueOnce({
        path: planPath,
        title: "Index Integration",
        overview: "",
        context: "",
        successCriteria: [],
        tasks: [{
          id: "task-1",
          number: 1,
          title: "Task 1: Build router",
          description: "",
          items: [{ text: "route commands", done: false }],
          status: "pending",
        }],
        extraSections: {},
      })
      .mockReturnValueOnce({
        path: planPath,
        title: "Index Integration",
        overview: "",
        context: "",
        successCriteria: [],
        tasks: [{
          id: "task-1",
          number: 1,
          title: "Task 1: Build router",
          description: "",
          items: [{ text: "route commands", done: true }],
          status: "completed",
        }],
        extraSections: {},
      });

    const createBranch = vi.fn();
    const executeAllTasks = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      writeFileSync(planPath, PLAN_TEXT.replace("- [ ] route commands", "- [x] route commands"), "utf8");
    });
    const runReviewPipeline = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
    });

    const handler = createRalpixCommandHandler(pi, {
      now: () => new Date("2026-06-20T12:00:00.000Z"),
      loadConfig: () => CONFIG,
      resolvePiAgentDir: () => null,
      loadPlan,
      executeAllTasks,
      runReviewPipeline,
      getCurrentBranch: () => "main",
      createBranch,
    });

    await handler(planPath, ctx);

    expect(createBranch).toHaveBeenCalledTimes(1);
    expect(createBranch).toHaveBeenCalledWith(cwd, "ralpix/20260620-index-integration");
    expect(runReviewPipeline).toHaveBeenCalledOnce();
    expect(existsSync(join(cwd, "docs", "plans", "completed", "index-plan.md"))).toBe(true);
    expect(existsSync(planPath)).toBe(false);
    expect(restoreState(cwd, planPath)).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Resuming interrupted ralpix session for Index Integration",
      "warning",
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("ralpix-status", expect.any(Array));
    expect(existsSync(join(cwd, ".ralpix", "progress", "execute", "index-plan.jsonl"))).toBe(true);
  });
});

describe("progress log helpers", () => {
  it("infers phases, migrates legacy logs, and lets restoreState resolve the new path", () => {
    const cwd = join(tmpdir(), `ralpix-index-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const progressRoot = join(cwd, ".ralpix", "progress");
    mkdirSync(progressRoot, { recursive: true });

    const legacyLog = join(progressRoot, "legacy.jsonl");
    writeFileSync(
      legacyLog,
      `${JSON.stringify({ type: "task_start", taskId: "task-1", taskNumber: 1, taskTitle: "Task 1", itemCount: 1 })}\n`,
      "utf8",
    );

    expect(inferProgressLogPhase(legacyLog)).toBe("execute");

    const state: RalpixState = {
      planPath: "/tmp/plan.md",
      planTitle: "Legacy",
      currentTaskId: "task-1",
      phase: "executing",
      completedTasks: [],
      failedTasks: [],
      progressFile: legacyLog,
    };
    persistState(cwd, state);

    migrateLegacyProgressLogs(cwd);
    const restored = restoreState(cwd);

    expect(restored?.progressFile).toBe(join(cwd, ".ralpix", "progress", "execute", "legacy.jsonl"));
  });
});

describe("buildStatusWidgetView", () => {
  it("renders a compact status view from persisted state", () => {
    expect(buildStatusWidgetView({
      planPath: "/tmp/plan.md",
      planTitle: "Index Integration",
      currentTaskId: "task-2",
      phase: "reviewing",
      completedTasks: ["task-1"],
      failedTasks: [],
      progressFile: "/tmp/progress.jsonl",
    })).toEqual([
      "Plan: Index Integration",
      "Phase: reviewing",
      "Current task: task-2",
      "Completed: 1",
      "Failed: 0",
      "Progress log: /tmp/progress.jsonl",
    ]);
  });
});
