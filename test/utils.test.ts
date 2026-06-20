import { describe, expect, it } from "vitest";

import { fmtTokens, formatUsageSummary, formatUsageBreakdownLines, summarizeUsageSnapshot, usageToData } from "../utils.js";

import type { UsageBreakdownEntry, UsageStep, UsageTotal } from "../events.js";

describe("fmtTokens", () => {
  it("returns '0' for zero", () => {
    expect(fmtTokens(0)).toBe("0");
  });

  it("returns raw number for < 1000", () => {
    expect(fmtTokens(1)).toBe("1");
    expect(fmtTokens(999)).toBe("999");
  });

  it("uses 1 decimal for 1000–9999", () => {
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(9999)).toBe("10.0k");
  });

  it("rounds to nearest k for >= 10000", () => {
    expect(fmtTokens(10_000)).toBe("10k");
    expect(fmtTokens(12_500)).toBe("13k");
    expect(fmtTokens(100_000)).toBe("100k");
  });
});

describe("formatUsageSummary", () => {
  it("returns step and total on one line separated by two spaces", () => {
    const step: UsageStep = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.005 };
    const total: UsageTotal = { input: 1000, output: 500, cost: 0.050 };
    const result = formatUsageSummary(step, total);
    expect(result).toContain("step in 100 out 50");
    expect(result).toContain("total in 1.0k out 500");
    expect(result).toContain("$0.005");
    expect(result).toContain("$0.050");
    expect(result.split("  ").length).toBeGreaterThanOrEqual(2);
  });
});

describe("formatUsageBreakdownLines", () => {
  it("returns one line per entry", () => {
    const entries: UsageBreakdownEntry[] = [
      { provider: "anthropic", model: "claude-3", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.005 },
      { provider: "openai", model: "gpt-4", input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.010 },
    ];
    const lines = formatUsageBreakdownLines(entries);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("anthropic/claude-3");
    expect(lines[1]).toContain("openai/gpt-4");
  });

  it("includes cacheRead and cacheWrite in input total", () => {
    const entries: UsageBreakdownEntry[] = [
      { provider: "p", model: "m", input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0 },
    ];
    const line = formatUsageBreakdownLines(entries)[0]!;
    expect(line).toContain("in 115");
  });

  it("returns empty array for empty input", () => {
    expect(formatUsageBreakdownLines([])).toEqual([]);
  });
});

describe("summarizeUsageSnapshot", () => {
  it("sums input with cacheRead and cacheWrite", () => {
    const step: UsageStep = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.005 };
    const snap = summarizeUsageSnapshot(step);
    expect(snap.input).toBe(115);
    expect(snap.output).toBe(50);
    expect(snap.cost).toBe(0.005);
  });
});

describe("usageToData", () => {
  const step: UsageStep = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 };
  const total: UsageTotal = { input: 10, output: 5, cost: 0.001 };

  it("returns step and total without breakdown when not provided", () => {
    const data = usageToData(step, total);
    expect(data.step).toBe(step);
    expect(data.total).toBe(total);
    expect(data.breakdown).toBeUndefined();
  });

  it("omits breakdown when empty array", () => {
    const data = usageToData(step, total, []);
    expect(data.breakdown).toBeUndefined();
  });

  it("includes breakdown when non-empty", () => {
    const bd: UsageBreakdownEntry[] = [{ provider: "p", model: "m", input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 }];
    const data = usageToData(step, total, bd);
    expect(data.breakdown).toBe(bd);
  });
});
