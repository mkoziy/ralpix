import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPhaseRun } from "../index.js";
import { runReviewPipeline } from "../reviewer.js";

import type { AgentEvent } from "../events.js";
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
  externalReviewPatience: 1,
  planModel: "gpt-5.5",
  planEffort: "medium",
  brainstormEnabled: true,
  brainstormModel: "gpt-5.5",
  brainstormEffort: "medium",
  finalizeEnabled: false,
  plansDir: "docs/plans",
  epistemicEnabled: false,
  trainingCutoff: null,
  highRiskLibraries: null,
};

const PLAN = {
  path: "/tmp/review-plan.md",
  title: "Review pipeline",
  overview: "",
  context: "",
  successCriteria: [],
  tasks: [],
  extraSections: {},
};

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

function usage(cost: number) {
  return {
    input: 10,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
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

function readEvents(filePath: string): AgentEvent[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent);
}

describe("review pipeline e2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes review stage and iteration events in order to the JSONL log", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-e2e-review-"));
    const phaseRun = await createPhaseRun(
      makeCtx(cwd),
      "review",
      "review-pipeline-e2e",
      new Date("2026-06-20T12:00:00.000Z"),
    );

    try {
      const runSubprocess = vi.fn();
      for (let index = 0; index < 5; index += 1) {
        runSubprocess.mockResolvedValueOnce(reviewResult(`first pass clean ${String(index + 1)}`, 0.001));
      }
      for (let index = 0; index < 2; index += 1) {
        runSubprocess.mockResolvedValueOnce(reviewResult(`stabilize clean ${String(index + 1)}`, 0.002));
      }
      for (let index = 0; index < 2; index += 1) {
        runSubprocess.mockResolvedValueOnce(reviewResult(`second pass clean ${String(index + 1)}`, 0.002));
      }

      await runReviewPipeline(
        makeCtx(cwd),
        {},
        PLAN,
        CONFIG,
        phaseRun.session,
        {
          runSubprocess,
          loadPrompt: () => "{{GOAL}}",
          detectDefaultBranch: () => "main",
          getHeadHash: () => "head-1",
          progressFile: phaseRun.progressFilePath,
        },
      );
    } finally {
      phaseRun.session.close();
      phaseRun.close();
    }

    const events = readEvents(phaseRun.progressFilePath);
    expect(events.map((event) => event.type)).toEqual([
      "phase_start",
      "stage_start",      // first-pass
      "stage_finish",     // first-pass
      "stage_start",      // first-pass-stabilize
      "iteration_start",  // first-pass-stabilize iter 1
      "iteration_end",    // first-pass-stabilize iter 1
      "stage_finish",     // first-pass-stabilize
      "stage_finish",     // external-review skipped
      "stage_finish",     // external-eval skipped
      "stage_start",      // second-pass
      "iteration_start",  // second-pass iter 1
      "iteration_end",    // second-pass iter 1
      "stage_finish",     // second-pass
      "milestone",        // finalize-skip
      "phase_end",
    ]);
    const stageFinishEvents = events.filter((event): event is Extract<AgentEvent, { type: "stage_finish" }> => event.type === "stage_finish");
    expect(stageFinishEvents.map((event) => `${event.stage}:${event.status}`)).toEqual([
      "first-pass:complete",
      "first-pass-stabilize:complete",
      "external-review:skipped",
      "external-eval:skipped",
      "second-pass:complete",
    ]);
  });
});
