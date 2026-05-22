/**
 * Progress logger — writes structured entries to .ralpix/progress/<plan>.txt
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EOL } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Plan, PlanTask, ReviewStageId } from "./types.js";

export interface UsageSummary {
  input: number;
  output: number;
  cost: number;
}

export function progressDirForCwd(cwd: string): string {
  return resolve(cwd, ".ralpix", "progress");
}

/** Format a token count for human display.
 *
 * - 0 → "0"
 * - 1–9,999 → one decimal + "k" (e.g. "1.0k", "9.9k")
 * - 10,000+ → rounded whole "k"   (e.g. "10k", "150k")
 */
export function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatUsageSummary(step: UsageSummary, total: UsageSummary): string {
  return [
    `step in ${fmtTokens(step.input)} out ${fmtTokens(step.output)} cost $${step.cost.toFixed(3)}`,
    `total in ${fmtTokens(total.input)} out ${fmtTokens(total.output)} cost $${total.cost.toFixed(3)}`,
  ].join("  ");
}

const REVIEW_STAGE_LOG_LABELS: Record<ReviewStageId, string> = {
  "first-pass": "first pass",
  "external-review": "external review",
  "external-eval": "external eval",
  "second-pass": "second pass",
};

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

  logTaskInfo(task: PlanTask, detail: string): void {
    this.append(`TASK_INFO   Task ${task.number}: ${task.title}  ${detail}`);
  }

  logTaskUsage(task: PlanTask, step: UsageSummary, total: UsageSummary, breakdown?: string[]): void {
    const lines = [`task_usage  Task ${task.number}: ${task.title}  ${formatUsageSummary(step, total)}`];
    if (breakdown !== undefined && breakdown.length > 0) {
      for (const line of breakdown) {
        lines.push(`            ${line}`);
      }
    }
    this.append(lines.join(EOL));
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

  logReviewUsage(step: UsageSummary, total: UsageSummary): void {
    this.append(`review_usage review pipeline  ${formatUsageSummary(step, total)}`);
  }

  logReviewStepUsage(stage: ReviewStageId, step: UsageSummary, total: UsageSummary, breakdown?: string[]): void {
    const lines = [`review_usage ${REVIEW_STAGE_LOG_LABELS[stage]}  ${formatUsageSummary(step, total)}`];
    if (breakdown !== undefined && breakdown.length > 0) {
      for (const line of breakdown) {
        lines.push(`             ${line}`);
      }
    }
    this.append(lines.join(EOL));
  }

  logComplete(): void {
    this.append("=".repeat(60));
    this.append(
      `PLAN_COMPLETE  All tasks finished at ${new Date().toISOString()}`,
    );
    this.append("=".repeat(60));
  }
}
