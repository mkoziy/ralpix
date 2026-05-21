/**
 * Interactive plan creation — generates a plan draft, lets the user revise it,
 * and saves the accepted result.
 *
 * Uses a subprocess backend instead of ctx.newSession() because the host
 * runtime currently aborts before the session callback starts.
 */
import type { RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
export declare function runPlanCreation(description: string, ctx: ExtensionCommandContext, _pi: ExtensionAPI, config: RalpixConfig): Promise<string | null>;
//# sourceMappingURL=planner.d.ts.map