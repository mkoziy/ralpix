/**
 * Prompt loading and variable expansion.
 *
 * Looks up prompts in order: project → global → bundled.
 * Expands {{VAR}} placeholders and {{agent:name}} agent includes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ralpixHomeDir } from "./config.js";
import { resolveWorkspacePath } from "./workspace.js";

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

const BUNDLED_DIR = join(__dirname, "bundled");

/**
 * Load a prompt file. Searches:
 *   1. ./.ralpix/prompts/<name>.md
 *   2. ~/.ralpix/prompts/<name>.md
 *   3. bundled/prompts/<name>.md (fallback)
 */
export function loadPrompt(name: string, cwd: string): string {
  const paths = [
    resolveWorkspacePath(cwd, join(".ralpix", "prompts", `${name}.md`), {
      kind: "create",
      label: `project prompt ${name}`,
    }),
    join(ralpixHomeDir(), "prompts", `${name}.md`),
    join(BUNDLED_DIR, "prompts", `${name}.md`),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  throw new Error(`Prompt not found: ${name}.md (searched project, global, and bundled)`);
}

/**
 * Load an agent file. Searches:
 *   1. ~/.ralpix/agents/<name>.md
 *   2. bundled/agents/<name>.md (fallback)
 */
export function loadAgent(name: string): string {
  const paths = [
    join(ralpixHomeDir(), "agents", `${name}.md`),
    join(BUNDLED_DIR, "agents", `${name}.md`),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  throw new Error(`Agent not found: ${name}.md`);
}

// ---------------------------------------------------------------------------
// Variable expansion
// ---------------------------------------------------------------------------

/**
 * Replace {{VAR}} placeholders with values from a record.
 * Unknown variables are left as-is.
 */
export function expandVariables(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replaceAll(/{{(\w+)}}/g, (_, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}

/**
 * Replace {{agent:name}} placeholders with the content of agent files.
 */
export function expandAgents(template: string): string {
  return template.replaceAll(/{{agent:(\w+)}}/g, (_, name: string) => {
    try {
      return loadAgent(name);
    } catch {
      return `{{agent:${name}}}`;
    }
  });
}

/**
 * Full expansion: variables first, then agent includes.
 */
export function expandPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  let result = expandVariables(template, vars);
  result = expandAgents(result);
  return result;
}
