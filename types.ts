/**
 * Core type definitions for ralpix extension.
 */

/** Valid thinking/effort levels */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Phases that use a model configuration.
 * - "task":           Task execution
 * - "review-first":    First review pass (5 agents)
 * - "review-second":   Second review pass (2 agents, iterative)
 * - "external-review": External reviewer (different model finds issues)
 * - "external-eval":   External review eval (main model fixes issues)
 * - "plan":            Interactive plan creation
 */
export type ModelPhase = "task" | "review-first" | "review-second" | "external-review" | "external-eval" | "plan";

/** All valid model phases */
export const MODEL_PHASES: ModelPhase[] = [
  "task",
  "review-first",
  "review-second",
  "external-review",
  "external-eval",
  "plan",
];

/** Model configuration for a single phase */
export interface ModelConfig {
  model: string | null;
  provider: string | null;
  effort: ThinkingLevel | null;
}

/** ralpix configuration (merged from bundled → global → project) */
export interface RalpixConfig {
  defaultModel: string | null;
  defaultProvider: string | null;
  defaultEffort: ThinkingLevel | null;
  /** Optional Pi config dir for ralpix child sessions; mapped to PI_CODING_AGENT_DIR */
  piAgentDir: string | null;
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
  /** Plan creation model / effort (falls back to defaultModel / defaultEffort) */
  planModel: string | null;
  planEffort: ThinkingLevel | null;
  /** Directory for created/stored plan files */
  plansDir: string;
  /**
   * Named model presets keyed by phase.
   * Each preset provides model/provider/effort for the given phase.
   * Overrides the flat fields (e.g. defaultModel) when set.
   */
  models?: Partial<Record<ModelPhase, ModelConfig>>;
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
