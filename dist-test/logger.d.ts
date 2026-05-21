/**
 * Progress logger — writes structured entries to .ralpix/progress/<plan>.txt
 */
import type { Plan, PlanTask } from "./types.js";
export interface UsageSummary {
    input: number;
    output: number;
    cost: number;
}
export declare function progressDirForCwd(cwd: string): string;
export declare function fmtTokens(n: number): string;
export declare function formatUsageSummary(step: UsageSummary, total: UsageSummary): string;
export declare class ProgressLogger {
    readonly filePath: string;
    constructor(cwd: string, planName: string);
    private ensureDir;
    private append;
    logStart(plan: Plan): void;
    logTaskStart(task: PlanTask): void;
    logTaskEnd(task: PlanTask, success: boolean, detail?: string): void;
    logTaskInfo(task: PlanTask, detail: string): void;
    logTaskUsage(task: PlanTask, step: UsageSummary, total: UsageSummary): void;
    logExternalReview(phase: string, result: string): void;
    logReview(phase: "first" | "second" | "loop", result: string): void;
    logReviewUsage(step: UsageSummary, total: UsageSummary): void;
    logComplete(): void;
}
//# sourceMappingURL=logger.d.ts.map