/**
 * Core type definitions for ralpix extension.
 */

/** Valid thinking/effort levels */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** ralpix configuration (merged from bundled → global → project) */
export interface RalpixConfig {
  defaultModel: string | null;
  defaultProvider: string | null;
  defaultEffort: ThinkingLevel | null;
  commitEnabled: boolean;
  commitMessageTemplate: string;
  reviewEnabled: boolean;
  reviewFirstModel: string | null;
  reviewSecondModel: string | null;
  reviewFirstEffort: ThinkingLevel | null;
  reviewSecondEffort: ThinkingLevel | null;
  maxRetries: number;
  reviewMaxIterations: number;
  movePlanOnCompletion: boolean;
  /** External review phase — independent model reviews code */
  externalReviewEnabled: boolean;
  externalReviewModel: string | null;
  externalReviewEffort: ThinkingLevel | null;
  externalReviewMaxIterations: number;
  externalReviewPatience: number;
  /** Directory for created/stored plan files */
  plansDir: string;
}

/** A single checklist item within a task */
export interface PlanItem {
  text: string;
  done: boolean;
}

/** Task extracted from a plan */
export interface PlanTask {
  id: string;
  number: number;
  title: string;
  description: string;
  items: PlanItem[];
  status: "pending" | "in-progress" | "completed" | "failed";
}

/** Parsed plan structure */
export interface Plan {
  path: string;
  title: string;
  overview: string;
  context: string;
  successCriteria: PlanItem[];
  tasks: PlanTask[];
}

/** Result of a task execution */
export interface TaskResult {
  success: boolean;
  error?: string;
  summary?: string;
}

/** Session state persisted via pi.appendEntry */
export interface RalpixState {
  planPath: string;
  planTitle: string;
  currentTaskId: string | null;
  phase: "idle" | "executing" | "reviewing" | "complete";
  completedTasks: string[];
  failedTasks: string[];
  progressFile: string;
}

/** Progress log entry */
export interface ProgressEntry {
  timestamp: string;
  type: "plan-start" | "task-start" | "task-end" | "review-start" | "review-end" | "plan-complete";
  data: Record<string, unknown>;
}
