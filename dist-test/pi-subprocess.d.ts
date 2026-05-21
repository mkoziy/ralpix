import type { ModelConfig, SubprocessUsage } from "./types.js";
interface JsonEvent {
    type: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    isError?: boolean;
    steering?: readonly string[];
    followUp?: readonly string[];
    message?: {
        role: string;
        provider?: string;
        model?: string;
        content?: Array<{
            type: string;
            text: string;
        }>;
        usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            cost?: {
                total?: number;
            };
        };
    };
}
export interface PiSubprocessResult {
    exitCode: number;
    output: string;
    error: string;
    lastAssistantText: string;
}
export interface PiSubprocessHooks {
    onEvent?: (event: JsonEvent) => void;
    onLifecycle?: (message: string) => void;
    onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void;
}
export declare function summarizePiToolCall(toolName: string, args: unknown): string;
export declare function summarizeAssistantProgress(text: string): string | null;
export declare function createPiProgressHooks(onProgress?: (detail: string) => void, onUsage?: (provider: string, model: string, usage: SubprocessUsage) => void): PiSubprocessHooks;
export declare function runPiSubprocessPrompt(cwd: string, promptContent: string, modelCfg: ModelConfig, includeEffort?: boolean, timeoutMs?: number, hooks?: PiSubprocessHooks, piAgentDir?: string | null): Promise<PiSubprocessResult>;
export {};
//# sourceMappingURL=pi-subprocess.d.ts.map