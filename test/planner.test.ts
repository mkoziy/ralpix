import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { agentEventSchema } from "../event-bus.js";
import { runPlanCreation } from "../planner.js";

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
    cacheRead: 2,
    cacheWrite: 1,
    cost,
  };
}

function result(message: string, cost: number) {
  return {
    status: "success" as const,
    success: true,
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    usage: usage(cost),
    message,
  };
}

const DRAFT_ONE = `
# Plan: Planner Rewrite

## Overview
Create a plan.

### Task 1: Build planner
- [ ] add planner
- [ ] add tests
`.trim();

const DRAFT_TWO = `
# Plan: Planner Rewrite Updated

## Overview
Create a revised plan.

### Task 1: Build planner
- [ ] add planner
- [ ] add tests

### Task 2: Wire review flow
- [ ] add review loop tests
`.trim();

describe("runPlanCreation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits critic, ai, and human review events in order for an accepted draft", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-planner-accept-"));
    const session = stubRunSession();
    session.choose.mockResolvedValueOnce("Accept and finish");

    const response = await runPlanCreation(
      makeCtx(cwd),
      {},
      "Rewrite planner",
      CONFIG,
      session,
      {
        now: () => new Date("2026-06-20T10:00:00.000Z"),
        loadPrompt: () => "{{DESCRIPTION}}",
        loadAgent: (name) => `reviewer:${name}`,
        runPrompt: vi.fn().mockResolvedValue(result(DRAFT_ONE, 0.001)),
        runCritic: vi.fn().mockResolvedValue(result("No critical issues", 0.002)),
        runAiReview: vi.fn().mockResolvedValue(result("APPROVE\nLooks good.", 0.003)),
      },
    );

    expect(response.plan.title).toBe("Planner Rewrite");
    expect(readFileSync(response.planPath, "utf8")).toContain("# Plan: Planner Rewrite");

    const eventNames = session.log.mock.calls.map(([type]) => type);
    expect(eventNames).toEqual([
      "phase_start",
      "round_start",
      "draft_generated",
      "round_end",
      "critic_start",
      "critic_end",
      "review_result",
      "ai_review_start",
      "ai_review_end",
      "review_result",
      "human_review",
      "review_result",
      "phase_end",
    ]);

    for (const [type, data] of session.log.mock.calls) {
      const parsed = agentEventSchema.safeParse({
        type,
        phase: "plan",
        createdAt: "2026-06-20T00:00:00.000Z",
        ...data,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("preserves clarification Q&A before drafting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-planner-question-"));
    const session = stubRunSession();
    session.choose
      .mockResolvedValueOnce("Keep markdown")
      .mockResolvedValueOnce("Accept and finish");

    await runPlanCreation(
      makeCtx(cwd),
      {},
      "Rewrite planner",
      CONFIG,
      session,
      {
        now: () => new Date("2026-06-20T10:00:00.000Z"),
        loadPrompt: () => "{{DESCRIPTION}}",
        loadAgent: (name) => `reviewer:${name}`,
        runPrompt: vi.fn()
          .mockResolvedValueOnce(result([
            "<RALPIX_QUESTION>",
            "Question: Which output format should the planner preserve?",
            "Options:",
            "- Keep markdown",
            "- Switch to JSON",
            "</RALPIX_QUESTION>",
          ].join("\n"), 0.001))
          .mockResolvedValueOnce(result(DRAFT_ONE, 0.002)),
        runCritic: vi.fn().mockResolvedValue(result("No critical issues", 0.003)),
        runAiReview: vi.fn().mockResolvedValue(result("APPROVE", 0.004)),
      },
    );

    const eventNames = session.log.mock.calls.map(([type]) => type);
    expect(eventNames).toContain("question");
    expect(eventNames).toContain("answer");

    const answerCall = session.log.mock.calls.find(([type]) => type === "answer");
    expect(answerCall?.[1]).toMatchObject({
      promptId: "plan-q1",
      message: "Keep markdown",
      usage: {
        step: usage(0.001),
        total: { input: 13, output: 4, cost: 0.001 },
      },
    });
  });

  it("distinguishes reload from revise and only regenerates on revise", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-planner-loop-"));
    const session = stubRunSession();
    session.choose
      .mockResolvedValueOnce("Reload edited file")
      .mockResolvedValueOnce("Revise from feedback")
      .mockResolvedValueOnce("Accept and finish");
    session.input.mockResolvedValueOnce("Add a second task.");

    const savedPath = join(cwd, "docs", "plans", "20260620-planner-rewrite.md");
    const runPrompt = vi.fn()
      .mockResolvedValueOnce(result(DRAFT_ONE, 0.001))
      .mockResolvedValueOnce(result(DRAFT_TWO, 0.004));
    const runCritic = vi.fn()
      .mockImplementationOnce(async () => {
        await Promise.resolve();
        writeFileSync(savedPath, `${DRAFT_TWO}\n`, "utf8");
        return result("No critical issues", 0.002);
      })
      .mockResolvedValueOnce(result("No critical issues", 0.003))
      .mockResolvedValueOnce(result("No critical issues", 0.005));
    const runAiReview = vi.fn()
      .mockResolvedValueOnce(result("APPROVE", 0.002))
      .mockResolvedValueOnce(result("APPROVE", 0.003))
      .mockResolvedValueOnce(result("APPROVE", 0.005));

    const response = await runPlanCreation(
      makeCtx(cwd),
      {},
      "Rewrite planner",
      CONFIG,
      session,
      {
        now: () => new Date("2026-06-20T10:00:00.000Z"),
        loadPrompt: () => "{{DESCRIPTION}}",
        loadAgent: (name) => `reviewer:${name}`,
        runPrompt,
        runCritic,
        runAiReview,
      },
    );

    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(response.plan.title).toBe("Planner Rewrite Updated");
    expect(readFileSync(response.planPath, "utf8")).toContain("### Task 2: Wire review flow");

    const userResults = session.log.mock.calls
      .filter(([type, data]) => type === "review_result" && data?.source === "user")
      .map(([, data]) => data?.action);
    expect(userResults).toEqual(["reload", "revise", "accept"]);
  });

  it("auto-revises from critic or ai findings before asking for final acceptance", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-planner-auto-revise-"));
    const session = stubRunSession();
    session.choose.mockResolvedValueOnce("Accept and finish");

    const runPrompt = vi.fn()
      .mockResolvedValueOnce(result(DRAFT_ONE, 0.001))
      .mockResolvedValueOnce(result(DRAFT_TWO, 0.004));
    const runCritic = vi.fn()
      .mockResolvedValueOnce(result("Missing an explicit testing task", 0.002))
      .mockResolvedValueOnce(result("No critical issues", 0.005));
    const runAiReview = vi.fn()
      .mockResolvedValueOnce(result("APPROVE", 0.003))
      .mockResolvedValueOnce(result("APPROVE", 0.006));

    const response = await runPlanCreation(
      makeCtx(cwd),
      {},
      "Rewrite planner",
      CONFIG,
      session,
      {
        now: () => new Date("2026-06-20T10:00:00.000Z"),
        loadPrompt: () => "{{DESCRIPTION}}",
        loadAgent: (name) => `reviewer:${name}`,
        runPrompt,
        runCritic,
        runAiReview,
      },
    );

    expect(response.plan.title).toBe("Planner Rewrite Updated");
    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(session.choose).toHaveBeenCalledTimes(1);
    expect(readFileSync(response.planPath, "utf8")).toContain("### Task 2: Wire review flow");
  });
});
