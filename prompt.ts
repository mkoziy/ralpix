import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ralpixHomeDir, ralpixProjectDir } from "./config.js";

const BUNDLED_DIR = join(import.meta.dirname, "bundled");

export function loadPrompt(name: string, cwd: string): string {
  const paths = [
    join(ralpixProjectDir(cwd), "prompts", `${name}.md`),
    join(ralpixHomeDir(), "prompts", `${name}.md`),
    join(BUNDLED_DIR, "prompts", `${name}.md`),
  ];
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`Prompt not found: ${name}.md (searched project, global, and bundled)`);
}

export function loadAgent(name: string): string {
  const paths = [
    join(ralpixHomeDir(), "agents", `${name}.md`),
    join(BUNDLED_DIR, "agents", `${name}.md`),
  ];
  for (const p of paths) {
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`Agent not found: ${name}.md`);
}

export function expandVariables(template: string, vars: Record<string, string>): string {
  return template.replaceAll(/{{(\w+)}}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export function expandAgents(template: string): string {
  return template.replaceAll(/{{agent:(\w+)}}/g, (_, name: string) => {
    try { return loadAgent(name); }
    catch { return `{{agent:${name}}}`; }
  });
}

export function expandPrompt(template: string, vars: Record<string, string>): string {
  return expandAgents(expandVariables(template, vars));
}
