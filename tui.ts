/**
 * Shared TUI components for ralpix — used by brainstorm, plan creation,
 * and task execution.  Provides a reusable progress panel with spinner,
 * phase labels, step log, elapsed timer, and token-usage tracking.
 */

import {
  fmtTokens,
  formatUsageBreakdownLines,
  summarizeUsageBreakdown,
  type UsageBreakdownEntry,
  type UsageSnapshot,
  type UsageSummary,
} from "./logger.js";

import type { SubprocessUsage } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function spinnerFrame(): string {
  const index = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? " ";
}

export function fmtElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

function stripAnsi(s: string): string {
  return s.replaceAll(/\u001B\[[\d;]*m/gu, "");
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

function ansiSafeSlice(s: string, maxVisible: number): string {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < maxVisible) {
    const start = i;
    const char = s.charAt(i);
    if (char === "\u001B" && i + 1 < s.length && s[i + 1] === "[") {
      i += 2;
      while (i < s.length && s[i] !== "m") i++;
      if (i < s.length) i++;
      out += s.slice(start, i);
    } else {
      out += char;
      visible++;
      i++;
    }
  }
  return out;
}

export function fit(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible <= width) return text;
  if (width <= 3) return stripAnsi(text).slice(0, width);
  return `${ansiSafeSlice(text, width - 3)}...`;
}

// ---------------------------------------------------------------------------
// Usage formatting
// ---------------------------------------------------------------------------

function formatUsage(usage: UsageSummary): string {
  return `in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProgressStep {
  title: string;
  usageSummary?: UsageSummary;
  usageLines?: string[];
}

export interface ProgressTuiRuntime {
  close: () => void;
  pushStep: (step: ProgressStep) => void;
  refresh: () => void;
  setPhase: (phase: string) => void;
  setCurrent: (title: string, usage?: UsageSummary) => void;
  setTotalUsage: (usage: UsageSummary) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

class ProgressPanel implements PiTuiComponent {
  private readonly title: string;
  private readonly theme: PiTuiTheme;
  private currentPhase = "idle";
  private currentTitle = "";
  private currentUsage: UsageSummary | undefined;
  private totalUsage: UsageSummary = { input: 0, output: 0, cost: 0 };
  private readonly steps: ProgressStep[] = [];
  private running = false;
  private currentStartTime = 0;

  constructor(title: string, theme: PiTuiTheme) {
    this.title = title;
    this.theme = theme;
  }

  setPhase(phase: string): void {
    this.currentPhase = phase;
  }

  setCurrent(title: string, usage?: UsageSummary): void {
    this.currentTitle = title;
    this.currentUsage = usage;
  }

  setTotalUsage(usage: UsageSummary): void {
    this.totalUsage = usage;
  }

  pushStep(step: ProgressStep): void {
    this.steps.push(step);
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (running) {
      this.currentStartTime = Date.now();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const maxWidth = Math.max(20, width);
    const border = this.theme.fg("borderAccent", "─".repeat(maxWidth));
    const bold = this.theme.bold ?? ((text: string) => text);
    const spin = this.running ? this.theme.fg("accent", spinnerFrame()) : "";
    const spinPad = this.running ? " " : "";

    lines.push(border);
    lines.push(fit(this.theme.fg("accent", bold(this.title)), maxWidth));
    lines.push(fit(this.theme.fg("muted", `${spin}${spinPad}Phase: ${this.currentPhase}`), maxWidth));
    lines.push(border);

    lines.push(fit(this.theme.fg("accent", "Log"), maxWidth));
    const visibleSteps = this.steps.slice(-12);
    if (visibleSteps.length === 0) {
      lines.push(fit(this.theme.fg("dim", "No activity yet"), maxWidth));
    } else {
      for (const step of visibleSteps) {
        lines.push(fit(step.title, maxWidth));
        if (step.usageLines !== undefined && step.usageLines.length > 0) {
          for (const line of step.usageLines) {
            lines.push(fit(this.theme.fg("muted", line), maxWidth));
          }
        } else if (step.usageSummary !== undefined) {
          lines.push(fit(this.theme.fg("muted", formatUsage(step.usageSummary)), maxWidth));
        }
      }
    }

    lines.push(border);
    lines.push(fit(this.theme.fg("accent", "Now"), maxWidth));
    lines.push(...this.renderNowLines(maxWidth, spin, spinPad));

    lines.push(border);
    lines.push(fit(this.theme.fg("accent", "Total"), maxWidth));
    lines.push(fit(this.theme.fg("muted", formatUsage(this.totalUsage)), maxWidth));
    lines.push(border);

    return lines;
  }

  invalidate(): void {
    return;
  }

  private renderNowLines(maxWidth: number, spin: string, spinPad: string): string[] {
    const result: string[] = [];
    if (this.currentTitle.length === 0) {
      result.push(fit(this.theme.fg("dim", `${spin}${spinPad}Idle`), maxWidth));
    } else {
      let titleLine = this.currentTitle;
      if (this.running && this.currentStartTime > 0) {
        titleLine += ` (${fmtElapsed(Date.now() - this.currentStartTime)})`;
      }
      result.push(fit(`${spin}${spinPad}${titleLine}`, maxWidth));
      if (this.currentUsage !== undefined) {
        result.push(fit(this.theme.fg("muted", formatUsage(this.currentUsage)), maxWidth));
      }
    }
    return result;
  }
}

const noopRender = (): void => {
  return;
};

export function createProgressTui(
  ctx: ExtensionCommandContext,
  widgetKey: string,
  title: string,
): ProgressTuiRuntime {
  if (!ctx.hasUI) {
    return {
      close() {
        return;
      },
      pushStep() {
        return;
      },
      refresh() {
        return;
      },
      setPhase() {
        return;
      },
      setCurrent() {
        return;
      },
      setTotalUsage() {
        return;
      },
    };
  }

  const panel = new ProgressPanel(title, ctx.ui.theme);
  let requestRender: () => void = noopRender;
  let animInterval: ReturnType<typeof setInterval> | undefined;

  const startAnimation = (): void => {
    if (animInterval !== undefined) return;
    panel.setRunning(true);
    animInterval = setInterval(() => requestRender(), SPINNER_INTERVAL_MS);
  };

  const stopAnimation = (): void => {
    if (animInterval !== undefined) {
      clearInterval(animInterval);
      animInterval = undefined;
    }
    panel.setRunning(false);
  };

  ctx.ui.setWidget(widgetKey, (ui: PiTuiRuntime) => {
    requestRender = () => ui.requestRender();
    return panel;
  });

  return {
    close() {
      stopAnimation();
      ctx.ui.setWidget(widgetKey, undefined);
      requestRender = noopRender;
    },
    pushStep(step) {
      panel.pushStep(step);
    },
    refresh() {
      requestRender();
    },
    setPhase(phase) {
      panel.setPhase(phase);
      if (phase !== "idle" && phase !== "complete" && phase !== "failed") {
        startAnimation();
      } else {
        stopAnimation();
      }
    },
    setCurrent(label, usage) {
      panel.setCurrent(label, usage);
    },
    setTotalUsage(usage) {
      panel.setTotalUsage(usage);
    },
  };
}

// ---------------------------------------------------------------------------
// Token ledger
// ---------------------------------------------------------------------------

export function createTokenLedger() {
  const map = new Map<string, UsageBreakdownEntry>();

  function add(provider: string, model: string, usage: SubprocessUsage): void {
    const key = `${provider}/${model}`;
    const e = map.get(key) ?? { provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    map.set(key, {
      provider,
      model,
      input: e.input + usage.input,
      output: e.output + usage.output,
      cacheRead: e.cacheRead + usage.cacheRead,
      cacheWrite: e.cacheWrite + usage.cacheWrite,
      cost: e.cost + usage.cost,
    });
  }

  function breakdown(): UsageBreakdownEntry[] {
    return [...map.values()].map((entry) => ({ ...entry }));
  }

  function snapshot(): UsageSummary {
    return summarizeUsageBreakdown(breakdown());
  }

  function detailedSnapshot(): UsageSnapshot {
    return breakdown().reduce<UsageSnapshot>((total, entry) => ({
      input: total.input + entry.input,
      output: total.output + entry.output,
      cacheRead: total.cacheRead + entry.cacheRead,
      cacheWrite: total.cacheWrite + entry.cacheWrite,
      cost: total.cost + entry.cost,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  }

  function diffSince(previous: UsageSummary): UsageSummary {
    const current = snapshot();
    return {
      input: current.input - previous.input,
      output: current.output - previous.output,
      cost: current.cost - previous.cost,
    };
  }

  function diffDetailedSince(previous: UsageSnapshot): UsageSnapshot {
    const current = detailedSnapshot();
    return {
      input: current.input - previous.input,
      output: current.output - previous.output,
      cacheRead: current.cacheRead - previous.cacheRead,
      cacheWrite: current.cacheWrite - previous.cacheWrite,
      cost: current.cost - previous.cost,
    };
  }

  function usageLines(): string[] {
    return formatUsageBreakdownLines(breakdown());
  }

  return { add, breakdown, detailedSnapshot, diffDetailedSince, diffSince, snapshot, usageLines };
}
