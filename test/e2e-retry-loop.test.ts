import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeAllTasks } from "../executor.js";
import { createPhaseRun } from "../index.js";
import { parsePlan } from "../parser.js";

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
# Plan: Retry Loop

## Overview
Verify retry logging.

### Task 1: Flaky task
- [ ] finish the flaky task
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

function makePlanFixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ralpix-e2e-retry-"));
  const planPath = join(cwd, "docs", "plans", "retry.md");
  mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
  writeFileSync(planPath, `${PLAN_TEXT}\n`, "utf8");
  return {
    cwd,
    planPath,
    plan: parsePlan(readFileSync(planPath, "utf8"), planPath),
  };
}

function result(success: boolean, summary: string, cost: number) {
  return {
    status: success ? ("success" as const) : ("failure" as const),
    success,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cost },
    message: [
      "<RALPIX_TASK_RESULT>",
      `Success: ${success ? "true" : "false"}`,
      `Summary: ${summary}`,
      "</RALPIX_TASK_RESULT>",
    ].join("\n"),
  };
}

function readEvents(filePath: string): AgentEvent[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

describe("retry loop e2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs both attempts exactly once before a retry succeeds", async () => {
    const { cwd, plan } = makePlanFixture();
    const phaseRun = await createPhaseRun(
      makeCtx(cwd),
      "execute",
      "retry-loop-e2e",
      new Date("2026-06-20T12:00:00.000Z"),
    );

    try {
      const runPrompt = vi.fn()
        .mockResolvedValueOnce(result(false, "needs another pass", 0.001))
        .mockResolvedValueOnce(result(true, "done", 0.002));

      await executeAllTasks(
        makeCtx(cwd),
        {},
        plan,
        CONFIG,
        phaseRun.session,
        {
          loadPrompt: () => "{{TASK_TITLE}}",
          runPrompt,
          tryCommit: vi.fn().mockReturnValue("abc123"),
        },
      );
    } finally {
      phaseRun.session.close();
      phaseRun.close();
    }

    const events = readEvents(phaseRun.progressFilePath);
    expect(events.map((event) => event.type)).toEqual([
      "task_start",
      "attempt_start",
      "attempt_end",
      "attempt_start",
      "attempt_end",
      "task_end",
    ]);
    const attemptStartEvents = events.filter((event): event is Extract<AgentEvent, { type: "attempt_start" }> => event.type === "attempt_start");
    expect(attemptStartEvents.map((event) => event.attempt)).toEqual([1, 2]);
    expect(new Set(events.map((event) => JSON.stringify(event))).size).toBe(events.length);
  });
});
