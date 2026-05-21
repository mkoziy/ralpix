/**
 * Config management — load, merge, save ralpix config.
 *
 * Priority (descending):
 *   1. ./ralpix/config.json  (project-local — merged on top)
 *   2. ~/.ralpix/config.json  (global — merged on top)
 *   3. Bundled defaults       (bundled inside extension)
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { THINKING_LEVELS } from "./types.js";
const PHASE_FIELDS = {
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
export function ralpixHomeDir() {
    return RALPIX_HOME;
}
export function ralpixProjectDir(cwd) {
    return join(cwd, ".ralpix");
}
export function defaultPiAgentDir() {
    return join(RALPIX_HOME, DEFAULT_PI_AGENT_DIR_NAME);
}
export function defaultPiAuthPath() {
    return join(homedir(), ".pi", "agent", "auth.json");
}
// ---------------------------------------------------------------------------
// Bundled defaults
// ---------------------------------------------------------------------------
let bundledConfigCache = null;
function bundledConfig() {
    if (bundledConfigCache !== null)
        return bundledConfigCache;
    bundledConfigCache = JSON.parse(readFileSync(join(__dirname, "bundled", CONFIG_FILE), UTF8_ENCODING));
    return bundledConfigCache;
}
// ---------------------------------------------------------------------------
// Deep merge (shallow enough for our config — no nested objects)
// ---------------------------------------------------------------------------
function hasOwn(config, key) {
    return Object.prototype.hasOwnProperty.call(config, key);
}
function stripInheritedPresetFields(mergedModels, override) {
    const overrideModels = override.models;
    for (const phase of Object.keys(mergedModels)) {
        const preset = mergedModels[phase];
        if (preset == null)
            continue;
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
function normalizeProviderOnlyPreset(preset, source) {
    if (hasOwn(source, "provider") && !hasOwn(source, "model")) {
        return { ...preset, model: null };
    }
    return preset;
}
export function mergeConfig(base, override) {
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
        ]);
        const mergedModels = {};
        for (const key of phaseKeys) {
            const baseVal = base.models[key];
            const overrideVal = override.models[key];
            // null explicitly means "clear this phase preset" — skip it
            // entirely so the caller reverts to the flat field chain for that phase.
            if (overrideVal === null)
                continue;
            if (baseVal != null && overrideVal != null) {
                const mergedPreset = normalizeProviderOnlyPreset({ ...baseVal, ...overrideVal }, overrideVal);
                mergedModels[key] = mergedPreset;
            }
            else if (overrideVal != null) {
                mergedModels[key] = normalizeProviderOnlyPreset({ ...overrideVal }, overrideVal);
            }
            else if (baseVal != null) {
                mergedModels[key] = baseVal;
            }
        }
        stripInheritedPresetFields(mergedModels, override);
        merged.models = mergedModels;
    }
    else if (merged.models != null) {
        stripInheritedPresetFields(merged.models, override);
    }
    return merged;
}
// ---------------------------------------------------------------------------
// Read config file, return null if missing/invalid
// ---------------------------------------------------------------------------
function readConfigFile(path) {
    try {
        if (!existsSync(path))
            return null;
        const raw = readFileSync(path, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function validateEffort(value, fieldName) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === "string" && THINKING_LEVELS.includes(value)) {
        return value;
    }
    console.warn(`ralpix: invalid ${fieldName}=${JSON.stringify(value)} — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`);
    return null;
}
/** Load merged configuration: bundled → global → project */
export function loadConfig(cwd) {
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
function isValidEffortValue(value) {
    return typeof value === "string" && THINKING_LEVELS.includes(value);
}
/**
 * Extract a single field from a phase preset.
 *
 * Returns:
 *   - `string`       if the key exists with a non-empty value
 *   - `null`          if the key exists with null or "" (explicitly cleared)
 *   - `undefined`     if the key is absent from the preset object
 */
function resolvePresetField(preset, field) {
    if (!(field in preset))
        return undefined;
    const val = preset[field];
    if (typeof val === "string" && val.length > 0)
        return val;
    return null;
}
export function resolveModel(config, phase) {
    const preset = config.models?.[phase];
    let model;
    let provider;
    let effort;
    if (preset == null) {
        // No preset at all — full fallback through flat fields to global defaults
        model = resolveFlatField(config, phase, "model");
        provider = resolveDefaultProvider(config);
        effort = resolveFlatField(config, phase, "effort");
    }
    else {
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
        console.warn(`ralpix: invalid effort "${effort}" for phase "${phase}" — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`);
        effort = null;
    }
    return { model, provider, effort };
}
function resolveFlatField(config, phase, kind) {
    const fields = PHASE_FIELDS[phase];
    const fieldName = kind === "model" ? fields.modelField : fields.effortField;
    const phaseVal = config[fieldName];
    if (phaseVal !== null && phaseVal !== "" && phaseVal !== undefined) {
        return phaseVal;
    }
    // Fall back to global default — treat blank strings as unset here too,
    // so defaultModel: "" means "use pi's own default" (omit --model).
    const defaultFieldName = kind === "model" ? "defaultModel" : "defaultEffort";
    const defaultVal = config[defaultFieldName];
    if (defaultVal !== null && defaultVal !== "") {
        return defaultVal;
    }
    return null;
}
function resolveDefaultProvider(config) {
    return config.defaultProvider ?? null;
}
export function resolvePiAgentDir(cwd, config) {
    const raw = config.piAgentDir?.trim();
    if (raw == null || raw.length === 0)
        return defaultPiAgentDir();
    if (raw === "~")
        return homedir();
    if (raw.startsWith("~/"))
        return join(homedir(), raw.slice(2));
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
}
export function ensureSharedPiAuth(piAgentDir, sharedAuthPath = defaultPiAuthPath()) {
    const authDir = dirname(sharedAuthPath);
    if (!existsSync(authDir)) {
        mkdirSync(authDir, { recursive: true });
    }
    if (!existsSync(sharedAuthPath)) {
        writeFileSync(sharedAuthPath, "", UTF8_ENCODING);
    }
    const childAuthPath = join(piAgentDir, "auth.json");
    if (existsSync(childAuthPath)) {
        try {
            const stats = lstatSync(childAuthPath);
            if (stats.isSymbolicLink())
                return;
            unlinkSync(childAuthPath);
        }
        catch {
            return;
        }
    }
    try {
        symlinkSync(sharedAuthPath, childAuthPath);
    }
    catch {
        if (!existsSync(childAuthPath)) {
            copyFileSync(sharedAuthPath, childAuthPath);
        }
    }
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
export function buildModelArg(cfg) {
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
export function buildSessionModelChange(cfg) {
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
export function applyModelConfigToSession(sessionManager, cfg, includeEffort = true) {
    const modelChange = buildSessionModelChange(cfg);
    if (modelChange !== null) {
        sessionManager.appendModelChange(modelChange.provider, modelChange.model);
    }
    if (includeEffort && cfg.effort !== null && cfg.effort.length > 0) {
        sessionManager.appendThinkingLevelChange(cfg.effort);
    }
}
/** Save project-local config (creates .ralpix/ dir if needed) */
export function saveProjectConfig(cwd, updates) {
    const dir = ralpixProjectDir(cwd);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const configPath = join(dir, CONFIG_FILE);
    const existing = (readConfigFile(configPath) ?? {});
    const merged = { ...existing, ...updates };
    writeFileSync(configPath, JSON.stringify(merged, null, 2), UTF8_ENCODING);
}
/**
 * Initialise ~/.ralpix/ with bundled defaults.
 * Idempotent — does not overwrite existing files.
 */
export function initRalpixHome() {
    const dirs = ["prompts", "agents", "progress", DEFAULT_PI_AGENT_DIR_NAME];
    for (const dirName of dirs) {
        const dirPath = join(RALPIX_HOME, dirName);
        if (!existsSync(dirPath))
            mkdirSync(dirPath, { recursive: true });
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
        writeFileSync(agentInstructionsPath, readFileSync(join(bundledPiAgentDir, "AGENTS.md"), UTF8_ENCODING), UTF8_ENCODING);
    }
    const settingsPath = join(piAgentDir, "settings.json");
    if (!existsSync(settingsPath)) {
        const bundledSettings = JSON.parse(readFileSync(join(bundledPiAgentDir, "settings.json"), UTF8_ENCODING));
        const settings = {
            ...bundledSettings,
            packages: [__dirname],
        };
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), UTF8_ENCODING);
    }
    ensureSharedPiAuth(piAgentDir);
}
//# sourceMappingURL=config.js.map