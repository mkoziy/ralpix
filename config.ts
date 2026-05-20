/**
 * Config management — load, merge, save ralpix config.
 *
 * Priority (descending):
 *   1. ./ralpix/config.json  (project-local — merged on top)
 *   2. ~/.ralpix/config.json  (global — merged on top)
 *   3. Bundled defaults       (bundled inside extension)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { THINKING_LEVELS } from "./types.js";

import type { ModelConfig, ModelPhase, RalpixConfig, ThinkingLevel } from "./types.js";

interface PhaseFields {
  modelField: keyof RalpixConfig;
  effortField: keyof RalpixConfig;
}

const PHASE_FIELDS: Record<ModelPhase, PhaseFields> = {
  task: { modelField: "defaultModel", effortField: "defaultEffort" },
  "review-first": { modelField: "reviewFirstModel", effortField: "reviewFirstEffort" },
  "review-second": { modelField: "reviewSecondModel", effortField: "reviewSecondEffort" },
  "external-review": { modelField: "externalReviewModel", effortField: "externalReviewEffort" },
  "external-eval": { modelField: "defaultModel", effortField: "defaultEffort" },
  plan: { modelField: "planModel", effortField: "planEffort" },
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const UTF8_ENCODING = "utf-8";
const CONFIG_FILE = "config.json";

export const RALPIX_HOME = join(homedir(), ".ralpix");
const DEFAULT_PI_AGENT_DIR_NAME = "pi-agent";

export function ralpixHomeDir(): string {
  return RALPIX_HOME;
}

export function ralpixProjectDir(cwd: string): string {
  return join(cwd, ".ralpix");
}

export function defaultPiAgentDir(): string {
  return join(RALPIX_HOME, DEFAULT_PI_AGENT_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Bundled defaults
// ---------------------------------------------------------------------------

let bundledConfigCache: RalpixConfig | null = null;

function bundledConfig(): RalpixConfig {
  if (bundledConfigCache !== null) return bundledConfigCache;

  bundledConfigCache = JSON.parse(
    readFileSync(join(__dirname, "bundled", CONFIG_FILE), UTF8_ENCODING),
  ) as RalpixConfig;
  return bundledConfigCache;
}

// ---------------------------------------------------------------------------
// Deep merge (shallow enough for our config — no nested objects)
// ---------------------------------------------------------------------------

function hasOwn(config: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function stripInheritedPresetFields(
  mergedModels: Partial<Record<ModelPhase, ModelConfig | undefined>>,
  override: Partial<RalpixConfig>,
): void {
  const overrideModels = override.models;

  for (const phase of Object.keys(mergedModels) as ModelPhase[]) {
    const preset = mergedModels[phase] as Partial<ModelConfig> | undefined;
    if (preset == null) continue;

    // Same-layer structured presets still win over same-layer flat fields.
    if (overrideModels != null && hasOwn(overrideModels, phase)) {
      continue;
    }

    const fields = PHASE_FIELDS[phase];
    if (hasOwn(override, fields.modelField)) {
      delete preset.model;
    }
    if (hasOwn(override, fields.effortField)) {
      delete preset.effort;
    }
    if (hasOwn(override, "defaultProvider")) {
      delete preset.provider;
    }

    if (!hasOwn(preset, "model") && !hasOwn(preset, "provider") && !hasOwn(preset, "effort")) {
      mergedModels[phase] = undefined;
    }
  }
}

function normalizeProviderOnlyPreset(
  preset: ModelConfig,
  source: ModelConfig,
): ModelConfig {
  if (hasOwn(source, "provider") && !hasOwn(source, "model")) {
    return { ...preset, model: null };
  }
  return preset;
}

export function mergeConfig(base: RalpixConfig, override: Partial<RalpixConfig>): RalpixConfig {
  // Merge top-level keys
  const merged = { ...base, ...override };

  // Deep-merge `models` so per-layer phase presets survive.
  // If both layers define models, each phase key is merged individually
  // (project overrides individual fields within a phase without dropping
  //  sibling fields from the global layer).
  if (override.models != null && base.models != null) {
    const phaseKeys = new Set([
      ...Object.keys(base.models),
      ...Object.keys(override.models),
    ]) as Set<ModelPhase>;

    const mergedModels: Partial<Record<ModelPhase, ModelConfig | undefined>> = {};
    for (const key of phaseKeys) {
      const baseVal = base.models[key];
      const overrideVal = override.models[key];

      // null explicitly means "clear this phase preset" — skip it
      // entirely so the caller reverts to the flat field chain for that phase.
      if (overrideVal === (null as unknown as ModelConfig | undefined)) continue;

      if (baseVal != null && overrideVal != null) {
        const mergedPreset = normalizeProviderOnlyPreset(
          { ...baseVal, ...overrideVal },
          overrideVal,
        );
        mergedModels[key] = mergedPreset;
      } else if (overrideVal != null) {
        mergedModels[key] = normalizeProviderOnlyPreset({ ...overrideVal }, overrideVal);
      } else if (baseVal != null) {
        mergedModels[key] = baseVal;
      }
    }
    stripInheritedPresetFields(mergedModels, override);
    merged.models = mergedModels as Partial<Record<ModelPhase, ModelConfig>>;
  } else if (merged.models != null) {
    stripInheritedPresetFields(merged.models, override);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Read config file, return null if missing/invalid
// ---------------------------------------------------------------------------

function readConfigFile(path: string): Partial<RalpixConfig> | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<RalpixConfig>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function validateEffort(value: unknown, fieldName: string): ThinkingLevel | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel;
  }
  console.warn(
    `ralpix: invalid ${fieldName}=${JSON.stringify(value)} — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`,
  );
  return null;
}

/** Load merged configuration: bundled → global → project */
export function loadConfig(cwd: string): RalpixConfig {
  let config = bundledConfig();

  // Merge global
  const globalPath = join(RALPIX_HOME, CONFIG_FILE);
  const globalOverrides = readConfigFile(globalPath);
  if (globalOverrides !== null) {
    config = mergeConfig(config, globalOverrides);
  }

  // Merge project-local
  const projectPath = join(ralpixProjectDir(cwd), CONFIG_FILE);
  const projectOverrides = readConfigFile(projectPath);
  if (projectOverrides !== null) {
    config = mergeConfig(config, projectOverrides);
  }

  // Validate and normalize effort fields
  config.defaultEffort = validateEffort(config.defaultEffort, "defaultEffort");
  config.reviewFirstEffort = validateEffort(config.reviewFirstEffort, "reviewFirstEffort");
  config.reviewSecondEffort = validateEffort(config.reviewSecondEffort, "reviewSecondEffort");
  config.externalReviewEffort = validateEffort(config.externalReviewEffort, "externalReviewEffort");
  config.planEffort = validateEffort(config.planEffort, "planEffort");

  return config;
}

/**
 * Resolve the effective model configuration for a given phase.
 *
 * Resolution order (first non-null/non-blank wins):
 *   1. `config.models?.[phase]` — full ModelConfig override for this phase
 *   2. Phase-specific flat fields — e.g. `reviewFirstModel`, `reviewFirstEffort`
 *   3. Global default flat fields — `defaultModel`, `defaultProvider`, `defaultEffort`
 *   4. `null` for each field
 *
 * Blank strings (`""`) are treated the same as `null` (unset), so
 * e.g. `planModel: ""` correctly falls back to `defaultModel`.
 */
/** Return true if the value is a non-empty string (runtime-safe, survives JSON null/undefined). */
function isValidEffortValue(value: string | null | undefined): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Extract a single field from a phase preset.
 *
 * Returns:
 *   - `string`       if the key exists with a non-empty value
 *   - `null`          if the key exists with null or "" (explicitly cleared)
 *   - `undefined`     if the key is absent from the preset object
 */
function resolvePresetField(
  preset: ModelConfig,
  field: string,
): string | null | undefined {
  if (!(field in preset)) return undefined;
  const val = preset[field as keyof ModelConfig];
  if (typeof val === "string" && val.length > 0) return val;
  return null;
}

export function resolveModel(config: RalpixConfig, phase: ModelPhase): ModelConfig {
  const preset = config.models?.[phase];

  let model: string | null;
  let provider: string | null;
  let effort: string | null;

  if (preset == null) {
    // No preset at all — full fallback through flat fields to global defaults
    model = resolveFlatField(config, phase, "model");
    provider = resolveDefaultProvider(config);
    effort = resolveFlatField(config, phase, "effort");
  } else {
    const pModel = resolvePresetField(preset, "model");
    const pProv = resolvePresetField(preset, "provider");
    const pEff = resolvePresetField(preset, "effort");

    // Per-field fallback: explicit values stay, absent fields inherit from
    // phase-specific flat fields → global defaults.  Explicit null/"" clears
    // that field (stays null).
    model = pModel === undefined ? resolveFlatField(config, phase, "model") : pModel;
    provider = pProv === undefined ? resolveDefaultProvider(config) : pProv;
    effort = pEff === undefined ? resolveFlatField(config, phase, "effort") : pEff;
  }

  // If the model string is already fully-qualified (contains "/"),
  // drop the separate provider — the model alone is enough.
  if (model?.includes("/") === true) {
    provider = null;
  }

  // Validate effort against known thinking levels.
  if (effort != null && !isValidEffortValue(effort)) {
    console.warn(
      `ralpix: invalid effort "${effort}" for phase "${phase}" — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`,
    );
    effort = null;
  }

  return { model, provider, effort };
}

function resolveFlatField(
  config: RalpixConfig,
  phase: ModelPhase,
  kind: "model" | "effort",
): string | null {
  const fields = PHASE_FIELDS[phase];
  const fieldName = kind === "model" ? fields.modelField : fields.effortField;

  const phaseVal = (config as unknown as Record<string, unknown>)[fieldName] as string | null | undefined;
  if (phaseVal !== null && phaseVal !== "" && phaseVal !== undefined) {
    return phaseVal;
  }

  // Fall back to global default — treat blank strings as unset here too,
  // so defaultModel: "" means "use pi's own default" (omit --model).
  const defaultFieldName = kind === "model" ? "defaultModel" : "defaultEffort";
  const defaultVal = (config as unknown as Record<string, unknown>)[defaultFieldName] as string | null;
  if (defaultVal !== null && defaultVal !== "") {
    return defaultVal;
  }

  return null;
}

function resolveDefaultProvider(config: RalpixConfig): string | null {
  return config.defaultProvider ?? null;
}

export function resolvePiAgentDir(cwd: string, config: RalpixConfig): string | null {
  const raw = config.piAgentDir?.trim();
  if (raw == null || raw.length === 0) return defaultPiAgentDir();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * Build the `--model` argument value from a resolved ModelConfig.
 *
 * Returns a value suitable for `--model` only when a concrete model is
 * available — either a plain name (`"gpt-5"`) or a combined
 * provider/model string (`"openai/gpt-5"`).  When only the provider
 * is set (no model), returns `null` so the caller can use `--provider`
 * instead and let pi pick that provider's default model.
 */
export function buildModelArg(cfg: ModelConfig): string | null {
  const { model, provider } = cfg;
  if (model?.includes("/") === true) {
    return model;
  }
  if (provider !== null && model !== null && provider.length > 0 && model.length > 0) {
    return `${provider}/${model}`;
  }
  if (model !== null && model.length > 0) {
    return model;
  }
  return null;
}

export function buildSessionModelChange(
  cfg: ModelConfig,
): { provider: string; model: string } | null {
  const { model, provider } = cfg;
  if (model?.includes("/") === true) {
    const slash = model.indexOf("/");
    return {
      provider: model.slice(0, slash),
      model: model.slice(slash + 1),
    };
  }
  if (provider !== null && provider.length > 0 && model !== null && model.length > 0) {
    return { provider, model };
  }
  return null;
}

export function applyModelConfigToSession(
  sessionManager: {
    appendModelChange: (provider: string, model: string) => void;
    appendThinkingLevelChange: (level: string) => void;
  },
  cfg: ModelConfig,
  includeEffort = true,
): void {
  const modelChange = buildSessionModelChange(cfg);
  if (modelChange !== null) {
    sessionManager.appendModelChange(modelChange.provider, modelChange.model);
  }

  if (includeEffort && cfg.effort !== null && cfg.effort.length > 0) {
    sessionManager.appendThinkingLevelChange(cfg.effort);
  }
}

/** Save project-local config (creates .ralpix/ dir if needed) */
export function saveProjectConfig(cwd: string, updates: Partial<RalpixConfig>): void {
  const dir = ralpixProjectDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const configPath = join(dir, CONFIG_FILE);
  const existing = (readConfigFile(configPath) ?? {}) as Record<string, unknown>;
  const merged = { ...existing, ...updates } as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify(merged, null, 2), UTF8_ENCODING);
}

/**
 * Initialise ~/.ralpix/ with bundled defaults.
 * Idempotent — does not overwrite existing files.
 */
export function initRalpixHome(): void {
  const dirs = ["prompts", "agents", "progress", DEFAULT_PI_AGENT_DIR_NAME];
  for (const dirName of dirs) {
    const dirPath = join(RALPIX_HOME, dirName);
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  }

  // Copy config if missing
  const configPath = join(RALPIX_HOME, CONFIG_FILE);
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(bundledConfig(), null, 2), UTF8_ENCODING);
  }

  // Copy prompts
  const bundledPromptsDir = join(__dirname, "bundled", "prompts");
  const promptsDir = join(RALPIX_HOME, "prompts");
  const promptNames = [
    "task-default", "review-first", "review-second", "finalize",
    "external-review", "external-eval", "plan-creation",
  ];
  for (const name of promptNames) {
    const dest = join(promptsDir, `${name}.md`);
    if (!existsSync(dest)) {
      writeFileSync(dest, readFileSync(join(bundledPromptsDir, `${name}.md`), UTF8_ENCODING), UTF8_ENCODING);
    }
  }

  // Copy agents
  const bundledAgentsDir = join(__dirname, "bundled", "agents");
  const agentsDir = join(RALPIX_HOME, "agents");
  const agentNames = ["quality", "implementation", "testing", "simplification", "documentation"];
  for (const name of agentNames) {
    const dest = join(agentsDir, `${name}.md`);
    if (!existsSync(dest)) {
      writeFileSync(dest, readFileSync(join(bundledAgentsDir, `${name}.md`), UTF8_ENCODING), UTF8_ENCODING);
    }
  }

  // Copy default pi-agent profile used by ralpix child sessions
  const bundledPiAgentDir = join(__dirname, "bundled", DEFAULT_PI_AGENT_DIR_NAME);
  const piAgentDir = defaultPiAgentDir();
  const agentInstructionsPath = join(piAgentDir, "AGENTS.md");
  if (!existsSync(agentInstructionsPath)) {
    writeFileSync(
      agentInstructionsPath,
      readFileSync(join(bundledPiAgentDir, "AGENTS.md"), UTF8_ENCODING),
      UTF8_ENCODING,
    );
  }

  const settingsPath = join(piAgentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    const bundledSettings = JSON.parse(
      readFileSync(join(bundledPiAgentDir, "settings.json"), UTF8_ENCODING),
    ) as { packages?: string[] };
    const settings = {
      ...bundledSettings,
      packages: [__dirname],
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), UTF8_ENCODING);
  }
}
