import type { Phase, ReviewStageId, ReviewStageStatus } from "./types.js";

export interface UsageStep {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface UsageTotal {
  input: number;
  output: number;
  cost: number;
}

export interface UsageBreakdownEntry {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface EventUsage {
  step: UsageStep;
  total: UsageTotal;
  breakdown?: UsageBreakdownEntry[];
}

interface Base { phase: Phase; createdAt: string }

export type AgentEvent =
  | (Base & { type: "phase_start"; label?: string }) |
  (Base & { type: "phase_end"; label?: string }) |
  (Base & { type: "question"; promptId: string; message: string; next?: string }) |
  (Base & { type: "answer"; promptId: string; message: string; usage?: EventUsage }) |
  (Base & { type: "approach_selected"; approach: string }) |
  (Base & { type: "section_validated"; section: string; passed: boolean; detail?: string }) |
  (Base & { type: "round_start"; round: number; label?: string }) |
  (Base & { type: "round_end"; round: number; usage: EventUsage }) |
  (Base & { type: "draft_generated"; digest: string }) |
  (Base & { type: "review_result"; source: "ai" | "critic" | "user"; action: string; digest?: string }) |
  (Base & { type: "task_start"; taskId: string; taskNumber: number; taskTitle: string; itemCount: number }) |
  (Base & { type: "attempt_start"; taskId: string; attempt: number; modelLabel?: string }) |
  (Base & { type: "attempt_end"; taskId: string; attempt: number; success: boolean; usage: EventUsage }) |
  (Base & { type: "task_end"; taskId: string; taskNumber: number; taskTitle: string; success: boolean; detail?: string; committed?: boolean; usage: EventUsage }) |
  (Base & { type: "stage_start"; stage: ReviewStageId; detail?: string }) |
  (Base & { type: "stage_update"; stage: ReviewStageId; detail: string }) |
  (Base & { type: "stage_finish"; stage: ReviewStageId; status: Exclude<ReviewStageStatus, "pending" | "active">; detail?: string; usage: EventUsage }) |
  (Base & { type: "iteration_start"; stage: ReviewStageId; iteration: number }) |
  (Base & { type: "iteration_end"; stage: ReviewStageId; iteration: number; usage: EventUsage }) |
  (Base & { type: "eval_iteration_start"; iteration: number }) |
  (Base & { type: "eval_iteration_end"; iteration: number; usage: EventUsage }) |
  (Base & { type: "critic_start" }) |
  (Base & { type: "critic_end"; digest: string; usage: EventUsage }) |
  (Base & { type: "ai_review_start" }) |
  (Base & { type: "ai_review_end"; digest: string; usage: EventUsage }) |
  (Base & { type: "human_review"; action: string }) |
  (Base & { type: "status_changed"; state: string; now: string; next?: string }) |
  (Base & { type: "milestone"; kind: string; message: string }) |
  (Base & { type: "usage_checkpoint"; totalUsageText: string });

export interface AgentEventEmitter {
  emit: (event: AgentEvent) => void;
}
