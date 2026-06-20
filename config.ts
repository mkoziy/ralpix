import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { THINKING_LEVELS } from "./types.js";

import type { ModelConfig, ModelPhase, RalpixConfig, ThinkingLevel } from "./types.js";

// ── Paths ──────────────────────────────────────────────────────────────────

const UTF8 = "utf-8";
const CONFIG_FILE = "config.json";
const DEFAULT_PI_AGENT_DIR = "pi-agent";

export const RALPIX_HOME = join(homedir(), ".ralpix");

export function ralpixHomeDir(): string {
  return RALPIX_HOME;
}

export function ralpixProjectDir(cwd: string): string {
  return join(cwd, ".ralpix");
}

export function defaultPiAgentDir(): string {
  return join(RALPIX_HOME, DEFAULT_PI_AGENT_DIR);
}

export function defaultPiAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

// ── Bundled defaults ───────────────────────────────────────────────────────

let bundledConfigCache: RalpixConfig | null = null;

function bundledConfig(): RalpixConfig {
  if (bundledConfigCache !== null) return bundledConfigCache;
  bundledConfigCache = JSON.parse(
    readFileSync(join(__dirname, "bundled", CONFIG_FILE), UTF8),
  ) as RalpixConfig;
  return bundledConfigCache;
}

// ── Config merge ───────────────────────────────────────────────────────────

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
  brainstorm: { modelField: "brainstormModel", effortField: "brainstormEffort" },
};

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeProviderOnlyPreset(preset: ModelConfig, source: ModelConfig): ModelConfig {
  if (hasOwn(source, "provider") && !hasOwn(source, "model")) {
    return { ...preset, model: null };
  }
  return preset;
}

function stripInheritedPresetFields(
  mergedModels: Partial<Record<ModelPhase, ModelConfig | undefined>>,
  override: Partial<RalpixConfig>,
): void {
  const overrideModels = override.models;
  for (const phase of Object.keys(mergedModels) as ModelPhase[]) {
    const preset = mergedModels[phase] as Partial<ModelConfig> | undefined;
    if (preset == null) continue;
    if (overrideModels != null && hasOwn(overrideModels, phase)) continue;
    const fields = PHASE_FIELDS[phase];
    if (hasOwn(override, fields.modelField)) delete preset.model;
    if (hasOwn(override, fields.effortField)) delete preset.effort;
    if (hasOwn(override, "defaultProvider")) delete preset.provider;
    if (!hasOwn(preset, "model") && !hasOwn(preset, "provider") && !hasOwn(preset, "effort")) {
      mergedModels[phase] = undefined;
    }
  }
}

export function mergeConfig(base: RalpixConfig, override: Partial<RalpixConfig>): RalpixConfig {
  const merged = { ...base, ...override };

  if (override.models != null && base.models != null) {
    const phaseKeys = new Set([
      ...Object.keys(base.models),
      ...Object.keys(override.models),
    ]) as Set<ModelPhase>;

    const mergedModels: Partial<Record<ModelPhase, ModelConfig | undefined>> = {};
    for (const key of phaseKeys) {
      const baseVal = base.models[key];
      const overrideVal = override.models[key];
      if (overrideVal === (null as unknown as ModelConfig | undefined)) continue;
      if (baseVal != null && overrideVal != null) {
        mergedModels[key] = normalizeProviderOnlyPreset({ ...baseVal, ...overrideVal }, overrideVal);
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

// ── Config loading ─────────────────────────────────────────────────────────

function readConfigFile(path: string): Partial<RalpixConfig> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, UTF8)) as Partial<RalpixConfig>;
  } catch {
    return null;
  }
}

function validateEffort(value: unknown, fieldName: string): ThinkingLevel | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
    return value as ThinkingLevel;
  }
  console.warn(`ralpix: invalid ${fieldName}=${JSON.stringify(value)} — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`);
  return null;
}

export function loadConfig(cwd: string): RalpixConfig {
  let config = bundledConfig();

  const globalOverrides = readConfigFile(join(RALPIX_HOME, CONFIG_FILE));
  if (globalOverrides !== null) config = mergeConfig(config, globalOverrides);

  const projectOverrides = readConfigFile(join(ralpixProjectDir(cwd), CONFIG_FILE));
  if (projectOverrides !== null) config = mergeConfig(config, projectOverrides);

  config.defaultEffort = validateEffort(config.defaultEffort, "defaultEffort");
  config.reviewFirstEffort = validateEffort(config.reviewFirstEffort, "reviewFirstEffort");
  config.reviewSecondEffort = validateEffort(config.reviewSecondEffort, "reviewSecondEffort");
  config.externalReviewEffort = validateEffort(config.externalReviewEffort, "externalReviewEffort");
  config.planEffort = validateEffort(config.planEffort, "planEffort");

  if (typeof config.reviewTimeoutMs !== "number" || config.reviewTimeoutMs <= 0) {
    config.reviewTimeoutMs = 30 * 60 * 1000;
  }
  if (typeof config.brainstormTimeoutMs !== "number" || config.brainstormTimeoutMs <= 0) {
    config.brainstormTimeoutMs = 10 * 60 * 1000;
  }

  return config;
}

// ── Model resolution ───────────────────────────────────────────────────────

function isValidEffortValue(value: string | null | undefined): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function resolvePresetField(preset: ModelConfig, field: string): string | null | undefined {
  if (!(field in preset)) return undefined;
  const val = preset[field as keyof ModelConfig];
  if (typeof val === "string" && val.length > 0) return val;
  return null;
}

function resolveFlatField(config: RalpixConfig, phase: ModelPhase, kind: "model" | "effort"): string | null {
  const fields = PHASE_FIELDS[phase];
  const fieldName = kind === "model" ? fields.modelField : fields.effortField;
  const phaseVal = (config as unknown as Record<string, unknown>)[fieldName] as string | null | undefined;
  if (phaseVal !== null && phaseVal !== "" && phaseVal !== undefined) return phaseVal;

  const defaultFieldName = kind === "model" ? "defaultModel" : "defaultEffort";
  const defaultVal = (config as unknown as Record<string, unknown>)[defaultFieldName] as string | null;
  if (defaultVal !== null && defaultVal !== "") return defaultVal;
  return null;
}

function resolveDefaultProvider(config: RalpixConfig): string | null {
  return config.defaultProvider ?? null;
}

export function resolveModel(config: RalpixConfig, phase: ModelPhase): ModelConfig {
  const preset = config.models?.[phase];
  let model: string | null;
  let provider: string | null;
  let effort: string | null;

  if (preset == null) {
    model = resolveFlatField(config, phase, "model");
    provider = resolveDefaultProvider(config);
    effort = resolveFlatField(config, phase, "effort");
  } else {
    const pModel = resolvePresetField(preset, "model");
    const pProv = resolvePresetField(preset, "provider");
    const pEff = resolvePresetField(preset, "effort");
    model = pModel === undefined ? resolveFlatField(config, phase, "model") : pModel;
    provider = pProv === undefined ? resolveDefaultProvider(config) : pProv;
    effort = pEff === undefined ? resolveFlatField(config, phase, "effort") : pEff;
  }

  if (model?.includes("/") === true) provider = null;

  if (effort != null && !isValidEffortValue(effort)) {
    console.warn(`ralpix: invalid effort "${effort}" for phase "${phase}" — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`);
    effort = null;
  }

  return { model, provider, effort };
}

// ── Pi agent dir resolution ────────────────────────────────────────────────

export function resolvePiAgentDir(cwd: string, config: RalpixConfig): string | null {
  const raw = config.piAgentDir?.trim();
  if (raw == null || raw.length === 0) return defaultPiAgentDir();
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

// ── Session model change helper ────────────────────────────────────────────

export function buildSessionModelChange(cfg: ModelConfig): { provider: string; model: string } | null {
  const { model, provider } = cfg;
  if (model?.includes("/") === true) {
    const slash = model.indexOf("/");
    return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
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

// ── initRalpixHome ─────────────────────────────────────────────────────────

interface InitResult {
  created: string[];
  overwritten: string[];
  skipped: string[];
}

function writeOrSkip(content: string, dest: string, overwrite: boolean, result: InitResult): void {
  if (existsSync(dest)) {
    if (overwrite) { writeFileSync(dest, content, UTF8); result.overwritten.push(dest); }
    else { result.skipped.push(dest); }
  } else {
    writeFileSync(dest, content, UTF8);
    result.created.push(dest);
  }
}

function copyOrSkip(src: string, dest: string, overwrite: boolean, result: InitResult): void {
  if (existsSync(dest)) {
    if (overwrite) { copyFileSync(src, dest); result.overwritten.push(dest); }
    else { result.skipped.push(dest); }
  } else {
    copyFileSync(src, dest);
    result.created.push(dest);
  }
}

function copyBundledSkills(piAgentDir: string, overwrite: boolean, result: InitResult): void {
  const bundledSkillsDir = join(__dirname, "bundled", "skills");
  const skillsDir = join(piAgentDir, "skills");
  if (!existsSync(bundledSkillsDir)) return;
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
  for (const entry of readdirSync(bundledSkillsDir)) {
    const srcDir = join(bundledSkillsDir, entry);
    if (!statSync(srcDir).isDirectory()) continue;
    const destDir = join(skillsDir, entry);
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    const srcSkill = join(srcDir, "SKILL.md");
    const destSkill = join(destDir, "SKILL.md");
    if (!existsSync(srcSkill)) continue;
    copyOrSkip(srcSkill, destSkill, overwrite, result);
  }
}

export function ensureSharedPiAuth(piAgentDir: string, sharedAuthPath = defaultPiAuthPath()): void {
  const authDir = dirname(sharedAuthPath);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  if (!existsSync(sharedAuthPath)) writeFileSync(sharedAuthPath, "", UTF8);

  const childAuthPath = join(piAgentDir, "auth.json");
  if (existsSync(childAuthPath)) {
    try {
      const stats = lstatSync(childAuthPath);
      if (stats.isSymbolicLink()) return;
      unlinkSync(childAuthPath);
    } catch { return; }
  }
  try {
    symlinkSync(sharedAuthPath, childAuthPath);
  } catch {
    if (!existsSync(childAuthPath)) copyFileSync(sharedAuthPath, childAuthPath);
  }
}

export function initRalpixHome(overwrite = false): InitResult {
  const result: InitResult = { created: [], overwritten: [], skipped: [] };
  const dirs = ["prompts", "agents", "progress", DEFAULT_PI_AGENT_DIR];
  for (const d of dirs) {
    const p = join(RALPIX_HOME, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  writeOrSkip(JSON.stringify(bundledConfig(), null, 2), join(RALPIX_HOME, CONFIG_FILE), overwrite, result);

  const bundledPromptsDir = join(__dirname, "bundled", "prompts");
  const promptsDir = join(RALPIX_HOME, "prompts");
  const promptNames = [
    "task-default", "review-first", "review-second", "finalize",
    "external-review", "external-eval", "plan-creation", "brainstorm",
  ];
  for (const name of promptNames) {
    writeOrSkip(readFileSync(join(bundledPromptsDir, `${name}.md`), UTF8), join(promptsDir, `${name}.md`), overwrite, result);
  }

  const bundledAgentsDir = join(__dirname, "bundled", "agents");
  const agentsDir = join(RALPIX_HOME, "agents");
  const agentNames = ["quality", "implementation", "testing", "simplification", "documentation", "epistemic"];
  for (const name of agentNames) {
    writeOrSkip(readFileSync(join(bundledAgentsDir, `${name}.md`), UTF8), join(agentsDir, `${name}.md`), overwrite, result);
  }

  const piAgentDir = defaultPiAgentDir();
  copyBundledSkills(piAgentDir, overwrite, result);

  const bundledPiAgentDir = join(__dirname, "bundled", DEFAULT_PI_AGENT_DIR);
  writeOrSkip(
    readFileSync(join(bundledPiAgentDir, "AGENTS.md"), UTF8),
    join(piAgentDir, "AGENTS.md"),
    overwrite,
    result,
  );

  const bundledSettings = JSON.parse(
    readFileSync(join(bundledPiAgentDir, "settings.json"), UTF8),
  ) as { packages?: string[] };
  writeOrSkip(
    JSON.stringify({ ...bundledSettings, packages: [__dirname] }, null, 2),
    join(piAgentDir, "settings.json"),
    overwrite,
    result,
  );

  ensureSharedPiAuth(piAgentDir);
  return result;
}

export function saveProjectConfig(cwd: string, updates: Partial<RalpixConfig>): void {
  const dir = ralpixProjectDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const configPath = join(dir, CONFIG_FILE);
  const existing = (readConfigFile(configPath) ?? {}) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...existing, ...updates as Record<string, unknown> }, null, 2), UTF8);
}
