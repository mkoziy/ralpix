/**
 * Task execution engine — runs each task in an isolated pi session.
 */
import type { ProgressLogger } from "./logger.js";
import type { Plan, PlanTask, RalpixConfig, SubprocessUsage, TaskResult } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
interface TaskSessionReport {
    success: boolean;
    summary: string;
}
export interface TaskExecutionHooks {
    onTaskStart?: (task: PlanTask) => void;
    onTaskFinish?: (task: PlanTask, result: TaskResult) => void;
    onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
}
export declare function buildTaskPrompt(promptContent: string): string;
export declare function parseTaskSessionReport(text: string): TaskSessionReport | null;
export declare function executeTask(ctx: ExtensionCommandContext, _pi: ExtensionAPI, task: PlanTask, config: RalpixConfig, plan: Plan, logger: ProgressLogger, hooks?: TaskExecutionHooks): Promise<TaskResult>;
export declare function executeAllTasks(ctx: ExtensionCommandContext, pi: ExtensionAPI, plan: Plan, config: RalpixConfig, logger: ProgressLogger, hooks?: TaskExecutionHooks): Promise<TaskResult[]>;
export {};
//# sourceMappingURL=executor.d.ts.map