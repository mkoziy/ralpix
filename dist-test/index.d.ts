/**
 * ralpix — Autonomous Plan Execution Extension for pi
 *
 * Reads ralpix-format markdown plans and executes tasks hands-off.
 * Each task runs in an isolated pi process (spawn) to keep context sharp.
 *
 * Commands:
 *   /ralpix plan <desc>  — Create a plan interactively
 *   /ralpix init          — Initialise ~/.ralpix/ with defaults
 *   /ralpix <path>        — Execute a plan
 *
 * Tools (for LLM):
 *   ralpix_mark_task_done — Mark current task as complete
 */
import { type UsageSummary } from "./logger.js";
import type { RalpixState } from "./types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
type NotifyLevel = "error" | "info" | "success" | "warning";
type NotifyFn = (message: string, level: NotifyLevel) => void;
interface WidgetLine {
    color: string;
    text: string;
}
interface StatusWidgetView {
    statusText: string;
    lines: WidgetLine[];
}
type UsageByModel = Map<string, UsageSummary>;
type UsageById = Map<string, UsageByModel>;
export declare function buildStatusWidgetView(state: RalpixState, tasks: Array<{
    id: string;
    title: string;
}>, total: number, totalCost?: number, taskUsageById?: UsageById, reviewUsageById?: UsageById): StatusWidgetView;
export declare function normalizePlanPathArg(rawPath: string): string;
export declare function withRalpixErrorHandling(action: () => Promise<void>, notify: NotifyFn): Promise<void>;
export declare function markTaskExecutionStarted(state: RalpixState, taskId: string): RalpixState;
export declare function markTaskExecutionFinished(state: RalpixState, taskId: string, success: boolean): RalpixState;
export default function ralpixExtension(pi: ExtensionAPI): void;
export {};
//# sourceMappingURL=index.d.ts.map