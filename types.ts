export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ModelPhase =
  | "task"
  | "review-first"
  | "review-second"
  | "external-review"
  | "external-eval"
  | "plan"
  | "brainstorm";

export const MODEL_PHASES: ModelPhase[] = [
  "task",
  "review-first",
  "review-second",
  "external-review",
  "external-eval",
  "plan",
  "brainstorm",
];

export interface ModelConfig {
  model: string | null;
  provider: string | null;
  effort: ThinkingLevel | null;
}

export interface RalpixConfig {
  defaultModel: string | null;
  defaultProvider: string | null;
  defaultEffort: ThinkingLevel | null;
  piAgentDir: string | null;
  commitEnabled: boolean;
  commitMessageTemplate: string;
  reviewEnabled: boolean;
  reviewFirstModel: string | null;
  reviewSecondModel: string | null;
  reviewFirstEffort: ThinkingLevel | null;
  reviewSecondEffort: ThinkingLevel | null;
  maxRetries: number;
  reviewMaxRetries: number;
  reviewTimeoutMs: number | null;
  brainstormTimeoutMs: number | null;
  reviewMaxIterations: number;
  externalReviewEnabled: boolean;
  externalReviewModel: string | null;
  externalReviewEffort: ThinkingLevel | null;
  externalReviewMaxIterations: number;
  externalReviewPatience: number;
  planModel: string | null;
  planEffort: ThinkingLevel | null;
  brainstormEnabled: boolean;
  brainstormModel: string | null;
  brainstormEffort: ThinkingLevel | null;
  plansDir: string;
  epistemicEnabled: boolean;
  trainingCutoff: string | null;
  highRiskLibraries: string[] | null;
  models?: Partial<Record<ModelPhase, ModelConfig>>;
}

export interface PlanItem {
  text: string;
  done: boolean;
}

export interface PlanTask {
  id: string;
  number: number;
  title: string;
  description: string;
  items: PlanItem[];
  status: "pending" | "in-progress" | "completed" | "failed";
}

export interface Plan {
  path: string;
  title: string;
  overview: string;
  context: string;
  successCriteria: PlanItem[];
  tasks: PlanTask[];
  extraSections: Record<string, string>;
}

export type ReviewStageId = "first-pass" | "external-review" | "external-eval" | "second-pass";

export type ReviewStageStatus = "pending" | "active" | "complete" | "failed" | "skipped";

export interface ReviewStageState {
  id: ReviewStageId;
  status: ReviewStageStatus;
  detail?: string;
}

export interface ReviewPipelineState {
  stages: ReviewStageState[];
}

export interface RalpixState {
  planPath: string;
  planTitle: string;
  currentTaskId: string | null;
  phase: "idle" | "executing" | "reviewing" | "complete";
  completedTasks: string[];
  failedTasks: string[];
  progressFile: string;
  review?: ReviewPipelineState;
}

export interface SubprocessUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type Phase = "brainstorm" | "plan" | "execute" | "review";
