/**
 * Progress logger — writes structured entries to .ralpix/progress/<plan>.txt
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, join, resolve } from "node:path";
export function progressDirForCwd(cwd) {
    return resolve(cwd, ".ralpix", "progress");
}
export function fmtTokens(n) {
    if (n === 0)
        return "0";
    if (n < 1000)
        return String(n);
    if (n < 100_000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
}
export function formatUsageSummary(step, total) {
    return [
        `step in ${fmtTokens(step.input)} out ${fmtTokens(step.output)} cost $${step.cost.toFixed(3)}`,
        `total in ${fmtTokens(total.input)} out ${fmtTokens(total.output)} cost $${total.cost.toFixed(3)}`,
    ].join("  ");
}
export class ProgressLogger {
    filePath;
    constructor(cwd, planName) {
        const dir = progressDirForCwd(cwd);
        this.filePath = join(dir, `${planName}.txt`);
    }
    ensureDir() {
        const dir = dirname(this.filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
    append(entry) {
        this.ensureDir();
        const ts = new Date().toISOString();
        appendFileSync(this.filePath, `[${ts}] ${entry}${EOL}`, "utf-8");
    }
    logStart(plan) {
        this.ensureDir();
        // Write header (overwrite if exists)
        const header = [
            "=".repeat(60),
            "Ralpix Plan Execution",
            "=".repeat(60),
            `Plan:    ${plan.title}`,
            `Path:    ${plan.path}`,
            `Tasks:   ${plan.tasks.length}`,
            `Started: ${new Date().toISOString()}`,
            "",
        ].join(EOL);
        writeFileSync(this.filePath, `${header}${EOL}`, "utf-8");
        // First entry
        this.append(`PLAN_START  ${plan.title} (${plan.tasks.length} tasks)`);
    }
    logTaskStart(task) {
        this.append(`TASK_START  Task ${task.number}: ${task.title}  [${task.items.length} items]`);
    }
    logTaskEnd(task, success, detail) {
        const status = success ? "✓ SUCCESS" : "✗ FAILED";
        const extra = detail !== undefined && detail.length > 0 ? ` — ${detail}` : "";
        this.append(`TASK_END    Task ${task.number}: ${task.title}  ${status}${extra}`);
    }
    logTaskInfo(task, detail) {
        this.append(`TASK_INFO   Task ${task.number}: ${task.title}  ${detail}`);
    }
    logTaskUsage(task, step, total) {
        this.append(`task_usage  Task ${task.number}: ${task.title}  ${formatUsageSummary(step, total)}`);
    }
    logExternalReview(phase, result) {
        this.append(`REVIEW_XTRNL ${phase.padEnd(8)} ${result}`);
    }
    logReview(phase, result) {
        const PHASE_LABELS = {
            first: "REVIEW_FIRST",
            second: "REVIEW_SECOND",
            loop: "REVIEW_LOOP",
        };
        this.append(`${PHASE_LABELS[phase].padEnd(14)} ${result}`);
    }
    logReviewUsage(step, total) {
        this.append(`review_usage review pipeline  ${formatUsageSummary(step, total)}`);
    }
    logComplete() {
        this.append("=".repeat(60));
        this.append(`PLAN_COMPLETE  All tasks finished at ${new Date().toISOString()}`);
        this.append("=".repeat(60));
    }
}
//# sourceMappingURL=logger.js.map