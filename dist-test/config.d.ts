/**
 * Config management — load, merge, save ralpix config.
 *
 * Priority (descending):
 *   1. ./ralpix/config.json  (project-local — merged on top)
 *   2. ~/.ralpix/config.json  (global — merged on top)
 *   3. Bundled defaults       (bundled inside extension)
 */
import type { ModelConfig, ModelPhase, RalpixConfig } from "./types.js";
export declare const RALPIX_HOME: string;
export declare function ralpixHomeDir(): string;
export declare function ralpixProjectDir(cwd: string): string;
export declare function defaultPiAgentDir(): string;
export declare function defaultPiAuthPath(): string;
export declare function mergeConfig(base: RalpixConfig, override: Partial<RalpixConfig>): RalpixConfig;
/** Load merged configuration: bundled → global → project */
export declare function loadConfig(cwd: string): RalpixConfig;
export declare function resolveModel(config: RalpixConfig, phase: ModelPhase): ModelConfig;
export declare function resolvePiAgentDir(cwd: string, config: RalpixConfig): string | null;
export declare function ensureSharedPiAuth(piAgentDir: string, sharedAuthPath?: string): void;
/**
 * Build the `--model` argument value from a resolved ModelConfig.
 *
 * Returns a value suitable for `--model` only when a concrete model is
 * available — either a plain name (`"gpt-5"`) or a combined
 * provider/model string (`"openai/gpt-5"`).  When only the provider
 * is set (no model), returns `null` so the caller can use `--provider`
 * instead and let pi pick that provider's default model.
 */
export declare function buildModelArg(cfg: ModelConfig): string | null;
export declare function buildSessionModelChange(cfg: ModelConfig): {
    provider: string;
    model: string;
} | null;
export declare function applyModelConfigToSession(sessionManager: {
    appendModelChange: (provider: string, model: string) => void;
    appendThinkingLevelChange: (level: string) => void;
}, cfg: ModelConfig, includeEffort?: boolean): void;
/** Save project-local config (creates .ralpix/ dir if needed) */
export declare function saveProjectConfig(cwd: string, updates: Partial<RalpixConfig>): void;
/**
 * Initialise ~/.ralpix/ with bundled defaults.
 * Idempotent — does not overwrite existing files.
 */
export declare function initRalpixHome(): void;
//# sourceMappingURL=config.d.ts.map