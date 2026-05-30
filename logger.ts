import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { JsonlEntry, JsonlUsageData, Phase, Plan, PlanTask, ReviewStageId, ReviewStageStatus } from "./types.js";

export interface UsageSummary {
  input: number;
  output: number;
  cost: number;
}

export interface UsageSnapshot extends UsageSummary {
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageBreakdownEntry extends UsageSnapshot {
  provider: string;
  model: string;
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

function writeLogError(filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    process.stderr.write(`[ralpix] failed to write progress log ${filePath}: ${message}\n`);
  } catch {
    // Logging failures must never throw.
  }
}

export function summarizeUsageSnapshot(usage: UsageSnapshot): UsageSummary {
  return {
    input: usage.input + usage.cacheRead + usage.cacheWrite,
    output: usage.output,
    cost: usage.cost,
  };
}

export function summarizeUsageBreakdown(entries: UsageBreakdownEntry[]): UsageSummary {
  return entries.reduce<UsageSummary>((total, entry) => ({
    input: total.input + entry.input + entry.cacheRead + entry.cacheWrite,
    output: total.output + entry.output,
    cost: total.cost + entry.cost,
  }), { input: 0, output: 0, cost: 0 });
}

export function formatUsageBreakdownLines(entries: UsageBreakdownEntry[]): string[] {
  return entries.map(
    (entry) => `${entry.provider}/${entry.model}  in ${fmtTokens(entry.input + entry.cacheRead + entry.cacheWrite)}  out ${fmtTokens(entry.output)}  $${entry.cost.toFixed(3)}`,
  );
}

export function usageToData(
  step: UsageSnapshot,
  total: UsageSnapshot,
  breakdown?: UsageBreakdownEntry[],
): JsonlUsageData {
  const data: JsonlUsageData = {
    step: {
      input: step.input,
      output: step.output,
      cacheRead: step.cacheRead,
      cacheWrite: step.cacheWrite,
      cost: step.cost,
    },
    total: {
      input: total.input,
      output: total.output,
      cost: total.cost,
    },
  };

  if (breakdown !== undefined && breakdown.length > 0) {
    data.breakdown = breakdown.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
      cost: entry.cost,
    }));
  }

  return data;
}

export class LogWriter {
  readonly filePath: string;

  constructor(cwd: string, sessionName: string) {
    const dir = progressDirForCwd(cwd);
    this.filePath = join(dir, `${sessionName}.jsonl`);
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  write(phase: Phase, event: string, data: Record<string, unknown> = {}): void {
    const entry: JsonlEntry = {
      ts: new Date().toISOString(),
      phase,
      event,
      data,
    };

    try {
      this.ensureDir();
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      writeLogError(this.filePath, error);
    }
  }

  logStart(plan: Plan): void {
    this.write("execute", "start", {
      planTitle: plan.title,
      planPath: plan.path,
      taskCount: plan.tasks.length,
    });
  }

  logTaskStart(task: PlanTask): void {
    this.write("execute", "task_start", {
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.title,
      itemCount: task.items.length,
    });
  }

  logTaskEnd(task: PlanTask, success: boolean, detail?: string): void {
    this.write("execute", "task_end", {
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.title,
      success,
      detail,
    });
  }

  logTaskInfo(task: PlanTask, detail: string): void {
    this.write("execute", "task_info", {
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.title,
      detail,
    });
  }

  logTaskUsage(task: PlanTask, step: UsageSnapshot, total: UsageSnapshot, breakdown?: UsageBreakdownEntry[]): void {
    this.write("execute", "task_usage", {
      taskId: task.id,
      taskNumber: task.number,
      taskTitle: task.title,
      usage: usageToData(step, total, breakdown),
      summary: formatUsageSummary(summarizeUsageSnapshot(step), summarizeUsageSnapshot(total)),
    });
  }

  logExternalReview(phase: string, result: string): void {
    this.write("review", "external_update", { phase, result });
  }

  logReview(phase: "first" | "second" | "loop", result: string): void {
    this.write("review", "stage_update", { phase, result });
  }

  logReviewStart(data: Record<string, unknown>): void {
    this.write("review", "start", data);
  }

  logReviewComplete(data: Record<string, unknown>): void {
    this.write("review", "complete", data);
  }

  logReviewStageStart(stage: ReviewStageId, detail?: string, data: Record<string, unknown> = {}): void {
    this.write("review", "stage_start", { stage, ...(detail === undefined ? {} : { detail }), ...data });
  }

  logReviewStageUpdate(stage: ReviewStageId, detail: string, data: Record<string, unknown> = {}): void {
    this.write("review", "stage_update", { stage, detail, ...data });
  }

  logReviewStageFinish(
    stage: ReviewStageId,
    status: Exclude<ReviewStageStatus, "pending" | "active">,
    detail?: string,
    data: Record<string, unknown> = {},
  ): void {
    this.write("review", "stage_finish", {
      stage,
      status,
      ...(detail === undefined ? {} : { detail }),
      ...data,
    });
  }

  logReviewUsage(step: UsageSnapshot, total: UsageSnapshot): void {
    this.write("review", "usage", {
      usage: usageToData(step, total),
      summary: formatUsageSummary(summarizeUsageSnapshot(step), summarizeUsageSnapshot(total)),
    });
  }

  logReviewStepUsage(
    stage: ReviewStageId,
    step: UsageSnapshot,
    total: UsageSnapshot,
    breakdown?: UsageBreakdownEntry[],
  ): void {
    this.write("review", "stage_usage", {
      stage,
      stageLabel: REVIEW_STAGE_LOG_LABELS[stage],
      usage: usageToData(step, total, breakdown),
      summary: formatUsageSummary(summarizeUsageSnapshot(step), summarizeUsageSnapshot(total)),
    });
  }

  logComplete(): void {
    this.write("execute", "complete", {});
  }
}
