/**
 * Config management — load, merge, save ralpix config.
 *
 * Priority (descending):
 *   1. ./ralpix/config.json  (project-local — merged on top)
 *   2. ~/.ralpix/config.json  (global — merged on top)
 *   3. Bundled defaults       (bundled inside extension)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { RalpixConfig, ThinkingLevel } from "./types.js";
import { THINKING_LEVELS } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const RALPIX_HOME = join(homedir(), ".ralpix");

export function ralpixHomeDir(): string {
  return RALPIX_HOME;
}

export function ralpixProjectDir(cwd: string): string {
  return join(cwd, ".ralpix");
}

// ---------------------------------------------------------------------------
// Bundled defaults
// ---------------------------------------------------------------------------

let _bundledConfig: RalpixConfig | null = null;

function bundledConfig(): RalpixConfig {
  if (_bundledConfig) return _bundledConfig;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _bundledConfig = JSON.parse(
    readFileSync(join(__dirname, "bundled", "config.json"), "utf-8"),
  );
  return _bundledConfig!;
}

// ---------------------------------------------------------------------------
// Deep merge (shallow enough for our config — no nested objects)
// ---------------------------------------------------------------------------

function mergeConfig(base: RalpixConfig, override: Partial<RalpixConfig>): RalpixConfig {
  return { ...base, ...override };
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
  console.warn(`ralpix: invalid ${fieldName}="${value}" — must be one of: ${THINKING_LEVELS.join(", ")}. Ignored.`);
  return null;
}

/** Load merged configuration: bundled → global → project */
export function loadConfig(cwd: string): RalpixConfig {
  let config = bundledConfig();

  // Merge global
  const globalPath = join(RALPIX_HOME, "config.json");
  const globalOverrides = readConfigFile(globalPath);
  if (globalOverrides) {
    config = mergeConfig(config, globalOverrides);
  }

  // Merge project-local
  const projectPath = join(ralpixProjectDir(cwd), "config.json");
  const projectOverrides = readConfigFile(projectPath);
  if (projectOverrides) {
    config = mergeConfig(config, projectOverrides);
  }

  // Validate and normalize effort fields
  config.defaultEffort = validateEffort(config.defaultEffort, "defaultEffort");
  config.reviewFirstEffort = validateEffort(config.reviewFirstEffort, "reviewFirstEffort");
  config.reviewSecondEffort = validateEffort(config.reviewSecondEffort, "reviewSecondEffort");

  return config;
}

/** Save project-local config (creates .ralpix/ dir if needed) */
export function saveProjectConfig(cwd: string, updates: Partial<RalpixConfig>): void {
  const dir = ralpixProjectDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const configPath = join(dir, "config.json");
  const existing = readConfigFile(configPath) ?? {};
  const merged = { ...existing, ...updates };
  writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Initialise ~/.ralpix/ with bundled defaults.
 * Idempotent — does not overwrite existing files.
 */
export function initRalpixHome(): void {
  const dirs = ["prompts", "agents", "progress"];
  for (const d of dirs) {
    const p = join(RALPIX_HOME, d);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  // Copy config if missing
  const configPath = join(RALPIX_HOME, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(bundledConfig(), null, 2), "utf-8");
  }

  // Copy prompts
  const bundledPromptsDir = join(__dirname, "bundled", "prompts");
  const promptsDir = join(RALPIX_HOME, "prompts");
  for (const name of ["task-default", "review-first", "review-second", "finalize"]) {
    const dest = join(promptsDir, `${name}.md`);
    if (!existsSync(dest)) {
      writeFileSync(dest, readFileSync(join(bundledPromptsDir, `${name}.md`), "utf-8"), "utf-8");
    }
  }

  // Copy agents
  const bundledAgentsDir = join(__dirname, "bundled", "agents");
  const agentsDir = join(RALPIX_HOME, "agents");
  for (const name of ["quality", "implementation", "testing", "simplification", "documentation"]) {
    const dest = join(agentsDir, `${name}.md`);
    if (!existsSync(dest)) {
      writeFileSync(dest, readFileSync(join(bundledAgentsDir, `${name}.md`), "utf-8"), "utf-8");
    }
  }
}
