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
export type ModelPhase = "task" | "review-first" | "review-second" | "external-review" | "external-eval" | "plan" | "brainstorm";

/** All valid model phases */
export const MODEL_PHASES: ModelPhase[] = [
  "task",
  "review-first",
  "review-second",
  "external-review",
  "external-eval",
  "plan",
  "brainstorm",
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
  reviewMaxRetries: number;
  reviewTimeoutMs: number | null;
  brainstormTimeoutMs: number | null;
  reviewMaxIterations: number;
  /** External review phase — independent model reviews code */
  externalReviewEnabled: boolean;
  externalReviewModel: string | null;
  externalReviewEffort: ThinkingLevel | null;
  externalReviewMaxIterations: number;
  externalReviewPatience: number;
  /** Plan creation model / effort (falls back to defaultModel / defaultEffort) */
  planModel: string | null;
  planEffort: ThinkingLevel | null;
  /** Brainstorm model / effort (falls back to planModel / planEffort) */
  brainstormEnabled: boolean;
  brainstormModel: string | null;
  brainstormEffort: ThinkingLevel | null;
  /** Directory for created/stored plan files */
  plansDir: string;
  /** Enable epistemic guardrails (temporal context + verification rules) */
  epistemicEnabled: boolean;
  /** Approximate knowledge cutoff date for the model (YYYY-MM-DD) */
  trainingCutoff: string | null;
  /** Libraries/frameworks known for frequent breaking changes */
  highRiskLibraries: string[] | null;
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
  /** Arbitrary sections captured from the markdown (e.g. Design Decisions, Key Layout, Auth, API Surface) */
  extraSections: Record<string, string>;
}

/** Result of a task execution */
export interface TaskResult {
  success: boolean;
  error?: string;
  summary?: string;
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

/** Session state persisted via pi.appendEntry */
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

/** Token usage captured from a single pi subprocess call */
export interface SubprocessUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type Phase = "brainstorm" | "plan" | "execute" | "review";

export type UiTranscriptKind = "INFO" | "Q" | "A" | "STEP" | "TASK" | "STAGE" | "RESULT" | "OK" | "WARN" | "ERR";

export type UiState = "thinking" | "waiting" | "running" | "retrying" | "reviewing" | "complete" | "failed";

export interface UiTranscriptEntry {
  phase: Phase;
  kind: UiTranscriptKind;
  message: string;
  createdAt: string;
}

export interface UiCurrentSummary {
  phase: Phase;
  state: UiState;
  now: string;
  next?: string;
  totalUsageText?: string;
}

export type UiTranscriptMilestoneKind = Exclude<UiTranscriptKind, "Q" | "A">;

export type UiEvent =
  { type: "question_asked"; phase: Phase; promptId: string; message: string; createdAt: string; next?: string } |
  { type: "answer_recorded"; phase: Phase; promptId: string; message: string; createdAt: string } |
  { type: "prompt_cancelled"; phase: Phase; promptId: string; reason: string; createdAt: string } |
  { type: "state_changed"; phase: Phase; state: UiState; now: string; createdAt: string; next?: string } |
  { type: "milestone"; phase: Phase; kind: UiTranscriptMilestoneKind; message: string; createdAt: string } |
  { type: "usage_checkpoint"; phase: Phase; totalUsageText: string; createdAt: string };

export interface UiPresentationState {
  events: UiEvent[];
  summary: UiCurrentSummary | null;
  transcript: UiTranscriptEntry[];
}

export interface JsonlEntry {
  ts: string;
  phase: Phase;
  event: string;
  data: Record<string, unknown>;
}

export interface JsonlUsageStepData {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: number;
}

export interface JsonlUsageTotalData {
  input: number;
  output: number;
  cost: number;
}

export interface JsonlUsageBreakdownData {
  provider: string;
  model: string;
  input: number;
  output: number;
  cost: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface JsonlUsageData {
  provider?: string;
  model?: string;
  step?: JsonlUsageStepData;
  total?: JsonlUsageTotalData;
  breakdown?: JsonlUsageBreakdownData[];
}

/** Backward-compatible alias while the rest of the codebase migrates. */
export type ProgressEntry = JsonlEntry;
