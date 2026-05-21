/**
 * Review pipeline — first pass + external review + iterative loop.
 */
import type { ProgressLogger } from "./logger.js";
import type { Plan, RalpixConfig, ReviewStageId, ReviewStageStatus, SubprocessUsage } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
interface ReviewSessionReport {
    success: boolean;
    summary: string;
}
export interface ReviewPipelineHooks {
    onStageStart?: (stage: ReviewStageId, detail?: string) => void;
    onStageUpdate?: (stage: ReviewStageId, detail: string) => void;
    onStageFinish?: (stage: ReviewStageId, status: Exclude<ReviewStageStatus, "pending" | "active">, detail?: string) => void;
    onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
}
export declare function buildReviewPrompt(promptContent: string, phase: "first" | "second" | "external" | "eval"): string;
export declare function parseReviewSessionReport(text: string): ReviewSessionReport | null;
export declare function runReviewPipeline(ctx: ExtensionCommandContext, _pi: ExtensionAPI, plan: Plan, config: RalpixConfig, logger: ProgressLogger, hooks?: ReviewPipelineHooks): Promise<{
    firstResult: string;
    externalResult: string;
    loopResult: string;
}>;
export {};
//# sourceMappingURL=reviewer.d.ts.map