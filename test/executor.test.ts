import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { agentEventSchema } from "../event-bus.js";
import { executeAllTasks } from "../executor.js";
import { parsePlan } from "../parser.js";

import { stubRunSession } from "./stubs.js";

import type { RalpixConfig } from "../types.js";

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
  reviewMaxIterations: 3,
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
# Plan: Executor Rewrite

## Overview
Run execution.

### Task 1: First task
- [ ] implement the first task

### Task 2: Second task
- [ ] implement the second task
`.trim();

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
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

function successResult(summary: string, cost: number, stdout = "") {
  return {
    status: "success" as const,
    success: true,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    usage: { input: 10, output: 3, cacheRead: 1, cacheWrite: 0, cost },
    message: [
      "<RALPIX_TASK_RESULT>",
      "Success: true",
      `Summary: ${summary}`,
      "</RALPIX_TASK_RESULT>",
    ].join("\n"),
  };
}

function failureResult(summary: string, cost: number, stdout = "") {
  return {
    status: "failure" as const,
    success: false,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost },
    message: [
      "<RALPIX_TASK_RESULT>",
      "Success: false",
      `Summary: ${summary}`,
      "</RALPIX_TASK_RESULT>",
    ].join("\n"),
  };
}

function makePlanFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ralpix-executor-"));
  const planPath = join(cwd, "docs", "plans", "executor.md");
  mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
  writeFileSync(planPath, `${PLAN_TEXT}\n`, "utf8");
  return {
    cwd,
    planPath,
    plan: parsePlan(readFileSync(planPath, "utf8"), planPath),
  };
}

describe("executeAllTasks", () => {
  it("emits task and attempt lifecycle events for a two-task plan", async () => {
    const { cwd, plan } = makePlanFixture();
    const session = stubRunSession();
    const runPrompt = vi.fn()
      .mockResolvedValueOnce(successResult("first complete", 0.001))
      .mockResolvedValueOnce(successResult("second complete", 0.002));
    const tryCommit = vi.fn()
      .mockReturnValueOnce("abc123")
      .mockReturnValueOnce("def456");

    await executeAllTasks(
      makeCtx(cwd),
      {},
      plan,
      CONFIG,
      session,
      {
        loadPrompt: () => "{{TASK_TITLE}}\n{{TASK_DESCRIPTION}}",
        runPrompt,
        tryCommit,
      },
    );

    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(session.log.mock.calls.map(([type]) => type)).toEqual([
      "task_start",
      "attempt_start",
      "attempt_end",
      "task_end",
      "task_start",
      "attempt_start",
      "attempt_end",
      "task_end",
    ]);
    expect(session.log.mock.calls.filter(([type]) => type === "task_end").map(([, data]) => data))
      .toEqual([
        expect.objectContaining({ success: true, committed: true }),
        expect.objectContaining({ success: true, committed: true }),
      ]);

    for (const [type, data] of session.log.mock.calls) {
      const parsed = agentEventSchema.safeParse({
        type,
        phase: "execute",
        createdAt: "2026-06-20T00:00:00.000Z",
        ...data,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("retries non-material failures until a later attempt succeeds", async () => {
    const { cwd, plan } = makePlanFixture();
    const session = stubRunSession();
    const runPrompt = vi.fn()
      .mockResolvedValueOnce(failureResult("needs another pass", 0.001))
      .mockResolvedValueOnce(successResult("first complete", 0.002))
      .mockResolvedValueOnce(successResult("second complete", 0.003));

    await executeAllTasks(
      makeCtx(cwd),
      {},
      plan,
      CONFIG,
      session,
      {
        loadPrompt: () => "{{TASK_TITLE}}",
        runPrompt,
        tryCommit: vi.fn().mockReturnValue("abc123"),
      },
    );

    expect(runPrompt).toHaveBeenCalledTimes(3);
    const attempts = session.log.mock.calls
      .filter(([type]) => type === "attempt_start")
      .map(([, data]) => data?.attempt);
    expect(attempts).toEqual([1, 2, 1]);
  });

  it("aborts retries after a material validation failure", async () => {
    const { cwd, plan } = makePlanFixture();
    const session = stubRunSession();
    const runPrompt = vi.fn().mockResolvedValue(
      failureResult(
        "lint failed",
        0.001,
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "bash",
          isError: true,
          args: { cmd: "npm run lint" },
        }),
      ),
    );

    await executeAllTasks(
      makeCtx(cwd),
      {},
      plan,
      CONFIG,
      session,
      {
        loadPrompt: () => "{{TASK_TITLE}}",
        runPrompt,
        tryCommit: vi.fn(),
      },
    );

    expect(runPrompt).toHaveBeenCalledTimes(1);
    expect(session.log.mock.calls.filter(([type]) => type === "attempt_start")).toHaveLength(1);
    const taskEndCalls = session.log.mock.calls.filter(([type]) => type === "task_end");
    const finalTaskEnd = taskEndCalls.at(-1);
    expect(finalTaskEnd?.[1]).toMatchObject({
      success: false,
      detail: "Task session encountered a material tool failure: bash npm run lint",
      committed: false,
    });
  });

  it("ignores a premature all-done signal and continues to the next task", async () => {
    const { cwd, plan } = makePlanFixture();
    const session = stubRunSession();
    const runPrompt = vi.fn()
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        plan.tasks[0]!.items[0]!.done = true;
        writeFileSync(plan.path, `
# Plan: Executor Rewrite

## Overview
Run execution.

### Task 1: First task
- [x] implement the first task

### Task 2: Second task
- [ ] implement the second task
`.trim() + "\n", "utf8");
        return successResult("first complete", 0.001, "<<<RALPIX:ALL_TASKS_DONE>>>");
      })
      .mockResolvedValueOnce(successResult("second complete", 0.002));

    await executeAllTasks(
      makeCtx(cwd),
      {},
      plan,
      CONFIG,
      session,
      {
        loadPrompt: () => "{{TASK_TITLE}}",
        runPrompt,
        tryCommit: vi.fn().mockReturnValue("abc123"),
      },
    );

    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(session.milestone).toHaveBeenCalledWith(
      "guard",
      "Ignored premature all-tasks-done signal for Task 1: First task",
    );
    expect(session.log.mock.calls.filter(([type]) => type === "task_start")).toHaveLength(2);
  });
});
