import type { EventUsage, UsageBreakdownEntry, UsageStep, UsageTotal } from "./events.js";

export function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatUsageSummary(step: UsageStep, total: UsageTotal): string {
  return [
    `step in ${fmtTokens(step.input)} out ${fmtTokens(step.output)} cost $${step.cost.toFixed(3)}`,
    `total in ${fmtTokens(total.input)} out ${fmtTokens(total.output)} cost $${total.cost.toFixed(3)}`,
  ].join("  ");
}

export function formatUsageBreakdownLines(entries: UsageBreakdownEntry[]): string[] {
  return entries.map(
    (e) =>
      `${e.provider}/${e.model}  in ${fmtTokens(e.input + e.cacheRead + e.cacheWrite)}  out ${fmtTokens(e.output)}  $${e.cost.toFixed(3)}`,
  );
}

export function summarizeUsageSnapshot(step: UsageStep): { input: number; output: number; cost: number } {
  return {
    input: step.input + step.cacheRead + step.cacheWrite,
    output: step.output,
    cost: step.cost,
  };
}

export function usageToData(
  step: UsageStep,
  total: UsageTotal,
  breakdown?: UsageBreakdownEntry[],
): EventUsage {
  return {
    step,
    total,
    ...(breakdown !== undefined && breakdown.length > 0 ? { breakdown } : {}),
  };
}
