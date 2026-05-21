import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { EOL } from "node:os";
import { join } from "node:path";
import { progressDirForCwd } from "./logger.js";
export function planCreationDebugFilePath(cwd) {
    return join(progressDirForCwd(cwd), "plan-creation-debug.txt");
}
export function appendPlanCreationDebug(cwd, entry) {
    const dir = progressDirForCwd(cwd);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const ts = new Date().toISOString();
    appendFileSync(planCreationDebugFilePath(cwd), `[${ts}] ${entry}${EOL}`, "utf-8");
}
//# sourceMappingURL=planner-debug.js.map