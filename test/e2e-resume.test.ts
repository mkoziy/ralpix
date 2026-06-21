import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRalpixCommandHandler } from "../index.js";
import { parsePlan } from "../parser.js";

import type { RunSession } from "../event-bus.js";
import type { AgentEvent } from "../events.js";
import type { RalpixConfig } from "../types.js";

const CONFIG: RalpixConfig = {
  defaultModel: "gpt-5.5",
  defaultProvider: "openai-codex",
  defaultEffort: "medium",
  piAgentDir: null,
  commitEnabled: true,
  commitMessageTemplate: "ralpix: {{taskTitle}}",
  reviewEnabled: false,
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
# Plan: Resume Flow

## Overview
Verify interrupted execution resumes cleanly.

### Task 1: First task
- [ ] finish the first task

### Task 2: Second task
- [ ] finish the second task
`.trim();

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: true,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeFixture() {
  const root = join(tmpdir(), `ralpix-e2e-resume-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const planPath = join(root, "docs", "plans", "resume.md");
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  writeFileSync(planPath, `${PLAN_TEXT}\n`, "utf8");
  return { root, planPath };
}

function readEvents(filePath: string): AgentEvent[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

function logSuccessfulTask(
  session: RunSession,
  taskId: string,
  taskNumber: number,
  taskTitle: string,
  cost: number,
): void {
  session.log("task_start", {
    taskId,
    taskNumber,
    taskTitle,
    itemCount: 1,
  });
  session.log("attempt_start", { taskId, attempt: 1, modelLabel: "gpt-5.5" });
  session.log("attempt_end", {
    taskId,
    attempt: 1,
    success: true,
    usage: {
      step: { input: 10 + taskNumber, output: 2 + taskNumber, cacheRead: 0, cacheWrite: 0, cost },
      total: { input: 10 + taskNumber, output: 2 + taskNumber, cost },
    },
  });
  session.log("task_end", {
    taskId,
    taskNumber,
    taskTitle,
    success: true,
    committed: true,
    usage: {
      step: { input: 10 + taskNumber, output: 2 + taskNumber, cacheRead: 0, cacheWrite: 0, cost },
      total: { input: 10 + taskNumber, output: 2 + taskNumber, cost },
    },
  });
}

describe("resume e2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends to the existing JSONL log and records a resume marker on the next run", async () => {
    const { root, planPath } = makeFixture();
    const ctx = makeCtx(root);
    const handler = createRalpixCommandHandler(
      { registerCommand: vi.fn() },
      {
        now: () => new Date("2026-06-20T12:00:00.000Z"),
        loadConfig: () => CONFIG,
        resolvePiAgentDir: () => null,
        loadPlan: (path) => parsePlan(readFileSync(path, "utf8"), path),
        getCurrentBranch: () => "feature/resume",
        executeAllTasks: vi.fn()
          .mockImplementationOnce(async (_ctx, _pi, _plan, _config, session: RunSession) => {
            logSuccessfulTask(session, "task-1", 1, "Task 1: First task", 0.001);
            writeFileSync(
              planPath,
              `${PLAN_TEXT.replace("- [ ] finish the first task", "- [x] finish the first task")}\n`,
              "utf8",
            );
            await Promise.resolve();
            throw new Error("simulated interruption");
          })
          .mockImplementationOnce(async (_ctx, _pi, _plan, _config, session: RunSession) => {
            logSuccessfulTask(session, "task-2", 2, "Task 2: Second task", 0.002);
            writeFileSync(
              planPath,
              `${PLAN_TEXT
                .replace("- [ ] finish the first task", "- [x] finish the first task")
                .replace("- [ ] finish the second task", "- [x] finish the second task")}\n`,
              "utf8",
            );
            await Promise.resolve();
          }),
      },
    );

    await handler(planPath, ctx);

    const progressPath = join(root, ".ralpix", "progress", "execute", `${basename(planPath, ".md")}.jsonl`);
    const firstRunEvents = readEvents(progressPath);
    expect(firstRunEvents.map((event) => event.type)).toEqual([
      "task_start",
      "attempt_start",
      "attempt_end",
      "task_end",
    ]);

    await handler(planPath, ctx);

    const resumedEvents = readEvents(progressPath);
    expect(resumedEvents).toHaveLength(firstRunEvents.length + 5);
    expect(resumedEvents.slice(0, firstRunEvents.length)).toEqual(firstRunEvents);
    expect(resumedEvents[firstRunEvents.length]).toMatchObject({
      type: "milestone",
      phase: "execute",
      kind: "resume",
      message: "Resumed execution for Resume Flow",
    });
    expect(existsSync(planPath)).toBe(false);
    expect(existsSync(join(root, "docs", "plans", "completed", "resume.md"))).toBe(true);
  });
});
