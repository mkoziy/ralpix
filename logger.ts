import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { JsonlEntry, JsonlUsageData, Phase } from "./types.js";

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

export function progressDirForPhase(cwd: string, phase: Phase): string {
  return resolve(cwd, ".ralpix", "progress", phase);
}

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

const VALID_PHASES: ReadonlySet<string> = new Set(["brainstorm", "plan", "execute", "review"]);

function inferPhaseFromJsonl(filePath: string): Phase | "unknown" {
  try {
    const content = readFileSync(filePath, "utf-8");
    const counts = new Map<string, number>();
    for (const line of content.split("\n").slice(0, 50)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        const phase = typeof entry["phase"] === "string" ? entry["phase"] : null;
        if (phase !== null && VALID_PHASES.has(phase)) {
          counts.set(phase, (counts.get(phase) ?? 0) + 1);
        }
      } catch {
        // skip unparseable lines
      }
    }
    if (counts.size === 0) return "unknown";
    const dominant = [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a));
    return dominant[0] as Phase;
  } catch {
    return "unknown";
  }
}

export function migrateProgressFiles(cwd: string): void {
  const flatDir = progressDirForCwd(cwd);
  if (!existsSync(flatDir)) return;

  let files: string[];
  try {
    files = readdirSync(flatDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const migrated: string[] = [];
  const failed: string[] = [];

  for (const file of files) {
    const src = join(flatDir, file);
    const phase = inferPhaseFromJsonl(src);
    const destDir = join(flatDir, phase);
    const dest = join(destDir, file);
    try {
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      renameSync(src, dest);
      migrated.push(file);
    } catch {
      failed.push(file);
    }
  }

  if (migrated.length > 0) {
    process.stderr.write(
      `[ralpix] migrated ${migrated.length} progress file(s) from flat path to per-phase subdirectories\n`,
    );
  }
  if (failed.length > 0) {
    process.stderr.write(
      `[ralpix] failed to migrate ${failed.length} progress file(s): ${failed.join(", ")}\n`,
    );
  }
}

export class LogWriter {
  readonly filePath: string;
  readonly phase: Phase;

  constructor(cwd: string, phase: Phase, sessionName: string) {
    this.phase = phase;
    const dir = progressDirForPhase(cwd, phase);
    this.filePath = join(dir, `${sessionName}.jsonl`);
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  write(event: string, data: Record<string, unknown> = {}): void {
    const entry: JsonlEntry = {
      ts: new Date().toISOString(),
      phase: this.phase,
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
}
