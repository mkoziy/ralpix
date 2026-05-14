/**
 * Progress logger — writes structured entries to .ralpix/progress/<plan>.txt
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { EOL } from "node:os";

import { ralpixHomeDir } from "./config.js";
import type { Plan, PlanTask } from "./types.js";

export class ProgressLogger {
  readonly filePath: string;
  private initialized = false;

  constructor(planName: string) {
    const dir = join(ralpixHomeDir(), "progress");
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

    writeFileSync(this.filePath, header + EOL, "utf-8");
    this.initialized = true;

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
    const extra = detail ? ` — ${detail}` : "";
    this.append(
      `TASK_END    Task ${task.number}: ${task.title}  ${status}${extra}`,
    );
  }

  logReview(phase: "first" | "second" | "loop", result: string): void {
    const labels: Record<string, string> = {
      first: "REVIEW_FIRST",
      second: "REVIEW_SECOND",
      loop: "REVIEW_LOOP",
    };
    this.append(`${labels[phase].padEnd(14)} ${result}`);
  }

  logComplete(): void {
    this.append("=".repeat(60));
    this.append(
      `PLAN_COMPLETE  All tasks finished at ${new Date().toISOString()}`,
    );
    this.append("=".repeat(60));
  }
}
