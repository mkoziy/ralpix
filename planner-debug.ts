import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { EOL } from "node:os";
import { join } from "node:path";

import { progressDirForCwd } from "./logger.js";
import { resolveWorkspacePath } from "./workspace.js";

export function planCreationDebugFilePath(cwd: string): string {
  return resolveWorkspacePath(cwd, join(".ralpix", "progress", "plan-creation-debug.txt"), {
    kind: "create",
    label: "plan creation debug log",
  });
}

export function appendPlanCreationDebug(cwd: string, entry: string): void {
  const dir = progressDirForCwd(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const ts = new Date().toISOString();
  appendFileSync(planCreationDebugFilePath(cwd), `[${ts}] ${entry}${EOL}`, "utf-8");
}
