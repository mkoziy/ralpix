/**
 * Progress logger — writes structured entries to .ralpix/progress/<plan>.txt
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Plan, PlanTask } from "./types.js";

export function progressDirForCwd(cwd: string): string {
  return resolve(cwd, ".ralpix", "progress");
}

export class ProgressLogger {
  readonly filePath: string;

  constructor(cwd: string, planName: string) {
    const dir = progressDirForCwd(cwd);
    this.filePath = join(dir, `${planName}.txt`);
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private append(entry: string): void {
    this.ensureDir();
    const ts = new Date().toISOString();
    appendFileSync(this.filePath, `[${ts}] ${entry}${EOL}`, "utf-8");
  }

  logStart(plan: Plan): void {
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
    this.append(
      `PLAN_START  ${plan.title} (${plan.tasks.length} tasks)`,
    );
  }

  logTaskStart(task: PlanTask): void {
    this.append(
      `TASK_START  Task ${task.number}: ${task.title}  [${task.items.length} items]`,
    );
  }

  logTaskEnd(task: PlanTask, success: boolean, detail?: string): void {
    const status = success ? "✓ SUCCESS" : "✗ FAILED";
    const extra = detail !== undefined && detail.length > 0 ? ` — ${detail}` : "";
    this.append(
      `TASK_END    Task ${task.number}: ${task.title}  ${status}${extra}`,
    );
  }

  logExternalReview(phase: string, result: string): void {
    this.append(`REVIEW_XTRNL ${phase.padEnd(8)} ${result}`);
  }

  logReview(phase: "first" | "second" | "loop", result: string): void {
    const PHASE_LABELS: Record<"first" | "second" | "loop", string> = {
      first: "REVIEW_FIRST",
      second: "REVIEW_SECOND",
      loop: "REVIEW_LOOP",
    };
    this.append(`${PHASE_LABELS[phase].padEnd(14)} ${result}`);
  }

  logComplete(): void {
    this.append("=".repeat(60));
    this.append(
      `PLAN_COMPLETE  All tasks finished at ${new Date().toISOString()}`,
    );
    this.append("=".repeat(60));
  }
}
