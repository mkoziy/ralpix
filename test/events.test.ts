import { describe, expect, it } from "vitest";

import { agentEventSchema } from "../event-bus.js";

const BASE = { phase: "execute" as const, createdAt: "2026-01-01T00:00:00.000Z" };

const USAGE = {
  step: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
  total: { input: 10, output: 5, cost: 0.001 },
};

describe("agentEventSchema — required base fields", () => {
  it("rejects missing phase", () => {
    const result = agentEventSchema.safeParse({ type: "phase_start", createdAt: BASE.createdAt });
    expect(result.success).toBe(false);
  });

  it("rejects missing createdAt", () => {
    const result = agentEventSchema.safeParse({ type: "phase_start", phase: BASE.phase });
    expect(result.success).toBe(false);
  });

  it("rejects unknown type", () => {
    const result = agentEventSchema.safeParse({ ...BASE, type: "totally_unknown_event" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields instead of stripping them", () => {
    const result = agentEventSchema.safeParse({
      ...BASE,
      type: "phase_start",
      extra: "unexpected",
    });
    expect(result.success).toBe(false);
  });
});

describe("agentEventSchema — all 28 event types", () => {
  it("phase_start", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "phase_start" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "phase_start", label: "Starting" }).success).toBe(true);
  });

  it("phase_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "phase_end" }).success).toBe(true);
  });

  it("question", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "question", promptId: "q1", message: "What?" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "question", promptId: "q1", message: "What?", next: "review" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "question" }).success).toBe(false);
  });

  it("answer", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "answer", promptId: "q1", message: "Yes" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "answer", promptId: "q1", message: "Yes", usage: USAGE }).success).toBe(true);
  });

  it("approach_selected", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "approach_selected", approach: "A" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "approach_selected" }).success).toBe(false);
  });

  it("section_validated", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "section_validated", section: "intro", passed: true }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "section_validated", section: "intro", passed: false, detail: "missing" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "section_validated", section: "intro" }).success).toBe(false);
  });

  it("round_start / round_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "round_start", round: 1 }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "round_end", round: 1, usage: USAGE }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "round_end", round: 1 }).success).toBe(false);
  });

  it("draft_generated", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "draft_generated", digest: "abc123" }).success).toBe(true);
  });

  it("review_result", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "review_result", source: "ai", action: "approve" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "review_result", source: "human", action: "reject" }).success).toBe(false);
  });

  it("critic_start / critic_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "critic_start" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "critic_end", digest: "d1", usage: USAGE }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "critic_end", digest: "d1" }).success).toBe(false);
  });

  it("ai_review_start / ai_review_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "ai_review_start" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "ai_review_end", digest: "d2", usage: USAGE }).success).toBe(true);
  });

  it("human_review", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "human_review", action: "approve" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "human_review" }).success).toBe(false);
  });

  it("task_start", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "task_start", taskId: "t1", taskNumber: 1, taskTitle: "Do it", itemCount: 3 }).success).toBe(true);
  });

  it("attempt_start", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "attempt_start", taskId: "t1", attempt: 1 }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "attempt_start", taskId: "t1", attempt: 2, modelLabel: "claude" }).success).toBe(true);
  });

  it("attempt_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "attempt_end", taskId: "t1", attempt: 1, success: true, usage: USAGE }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "attempt_end", taskId: "t1", attempt: 1, success: false }).success).toBe(false);
  });

  it("task_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "task_end", taskId: "t1", taskNumber: 1, taskTitle: "Done", success: true, usage: USAGE }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "task_end", taskId: "t1", taskNumber: 1, taskTitle: "Done", success: false, detail: "err", committed: false, usage: USAGE }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "task_end", taskId: "t1", taskNumber: 1, taskTitle: "Done", success: true }).success).toBe(false);
  });

  it("stage_start / stage_update / stage_finish", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "stage_start", stage: "first-pass" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "stage_update", stage: "first-pass", detail: "running" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "stage_finish", stage: "first-pass", status: "complete", usage: USAGE }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "stage_finish", stage: "first-pass", status: "complete" }).success).toBe(false);
    expect(agentEventSchema.safeParse({ ...BASE, type: "stage_start", stage: "bad-stage" }).success).toBe(false);
  });

  it("iteration_start / iteration_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "iteration_start", stage: "second-pass", iteration: 1 }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "iteration_end", stage: "second-pass", iteration: 1, usage: USAGE }).success).toBe(true);
  });

  it("eval_iteration_start / eval_iteration_end", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "eval_iteration_start", iteration: 1 }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "eval_iteration_end", iteration: 1, usage: USAGE }).success).toBe(true);
  });

  it("status_changed", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "status_changed", state: "running", now: "doing work" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "status_changed", state: "waiting", now: "question", next: "execute" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "status_changed", state: "running" }).success).toBe(false);
  });

  it("milestone", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "milestone", kind: "OK", message: "done" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "milestone", kind: "ERR" }).success).toBe(false);
  });

  it("usage_checkpoint", () => {
    expect(agentEventSchema.safeParse({ ...BASE, type: "usage_checkpoint", totalUsageText: "in 1k out 2k $0.01" }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...BASE, type: "usage_checkpoint" }).success).toBe(false);
  });
});

describe("agentEventSchema — usage shape validation", () => {
  it("accepts usage with breakdown", () => {
    const result = agentEventSchema.safeParse({
      ...BASE,
      type: "round_end",
      round: 1,
      usage: {
        step: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.005 },
        total: { input: 200, output: 100, cost: 0.010 },
        breakdown: [{ provider: "anthropic", model: "claude-3", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.005 }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects usage missing required step fields", () => {
    const result = agentEventSchema.safeParse({
      ...BASE,
      type: "round_end",
      round: 1,
      usage: { step: { input: 10 }, total: { input: 10, output: 5, cost: 0.001 } },
    });
    expect(result.success).toBe(false);
  });
});
