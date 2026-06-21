import { describe, expect, it, vi } from "vitest";

import { agentEventSchema } from "../event-bus.js";
import { runReviewPipeline } from "../reviewer.js";

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
  reviewMaxIterations: 2,
  externalReviewEnabled: false,
  externalReviewModel: "gpt-5.5",
  externalReviewEffort: "medium",
  externalReviewMaxIterations: 2,
  externalReviewPatience: 2,
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

function makeCtx() {
  return {
    cwd: "/tmp/ralpix-reviewer-test",
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

const PLAN = {
  path: "/tmp/review-plan.md",
  title: "Review pipeline",
  overview: "",
  context: "",
  successCriteria: [],
  tasks: [],
  extraSections: {},
};

function usage(cost: number) {
  return {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    cost,
  };
}

function reviewResult(summary: string, cost: number) {
  return {
    status: "success" as const,
    success: true,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    usage: usage(cost),
    message: summary,
    report: {
      success: true,
      summary,
    },
  };
}

describe("runReviewPipeline", () => {
  it("emits stage and iteration events in order for the two-stage pipeline", async () => {
    const session = stubRunSession();
    const runSubprocess = vi.fn();
    for (let index = 0; index < 5; index += 1) {
      runSubprocess.mockResolvedValueOnce(reviewResult(`first pass clean ${String(index + 1)}`, 0.001));
    }
    for (let index = 0; index < 2; index += 1) {
      runSubprocess.mockResolvedValueOnce(reviewResult(`second pass clean ${String(index + 1)}`, 0.002));
    }
    const headHashes = ["head-1", "head-1"];

    await runReviewPipeline(
      makeCtx(),
      {},
      PLAN,
      CONFIG,
      session,
      {
        runSubprocess,
        loadPrompt: () => "{{GOAL}}",
        detectDefaultBranch: () => "main",
        getHeadHash: () => headHashes.shift() ?? "head-1",
        progressFile: "/tmp/review.jsonl",
      },
    );

    expect(session.log.mock.calls.map(([type]) => type)).toEqual([
      "phase_start",
      "stage_start",
      "stage_finish",
      "stage_finish",
      "stage_finish",
      "stage_start",
      "iteration_start",
      "iteration_end",
      "stage_finish",
      "phase_end",
    ]);

    const secondPassStart = session.log.mock.calls.find(([type, data]) => type === "stage_start" && data?.stage === "second-pass");
    expect(secondPassStart?.[1]).toMatchObject({
      stage: "second-pass",
      detail: "quality review — iteration 1/2",
    });
    expect(runSubprocess).toHaveBeenCalledTimes(7);

    for (const [type, data] of session.log.mock.calls) {
      const parsed = agentEventSchema.safeParse({
        type,
        phase: "review",
        createdAt: "2026-06-20T00:00:00.000Z",
        ...data,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("includes usage on stage_finish and skips external stages when disabled", async () => {
    const session = stubRunSession();
    const runSubprocess = vi.fn();
    for (let index = 0; index < 5; index += 1) {
      runSubprocess.mockResolvedValueOnce(reviewResult(`first pass clean ${String(index + 1)}`, 0.001));
    }
    for (let index = 0; index < 2; index += 1) {
      runSubprocess.mockResolvedValueOnce(reviewResult(`second pass clean ${String(index + 1)}`, 0.002));
    }

    await runReviewPipeline(
      makeCtx(),
      {},
      PLAN,
      { ...CONFIG, externalReviewEnabled: false },
      session,
      {
        runSubprocess,
        loadPrompt: () => "{{GOAL}}",
        detectDefaultBranch: () => "main",
        getHeadHash: () => "head-1",
        progressFile: "/tmp/review.jsonl",
      },
    );

    const finishEvents = session.log.mock.calls
      .filter(([type]) => type === "stage_finish")
      .map(([, data]) => data);

    expect(finishEvents).toEqual([
      expect.objectContaining({
        stage: "first-pass",
        status: "complete",
        usage: {
          step: { input: 50, output: 20, cacheRead: 10, cacheWrite: 5, cost: 0.005 },
          total: { input: 65, output: 20, cost: 0.005 },
        },
      }),
      expect.objectContaining({
        stage: "external-review",
        status: "skipped",
      }),
      expect.objectContaining({
        stage: "external-eval",
        status: "skipped",
      }),
      expect.objectContaining({
        stage: "second-pass",
        status: "complete",
        usage: {
          step: { input: 20, output: 8, cacheRead: 4, cacheWrite: 2, cost: 0.004 },
          total: { input: 91, output: 28, cost: 0.009000000000000001 },
        },
      }),
    ]);
  });
});
