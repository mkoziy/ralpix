import {
  fmtTokens,
  formatUsageBreakdownLines,

} from "./utils.js";

import type { UsageBreakdownEntry, UsageTotal } from "./events.js";
import type { Phase, SubprocessUsage } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Spinner ────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

function spinnerFrame(): string {
  const index = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] ?? " ";
}

// ── Text utilities ─────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replaceAll(/\[[\d;]*m/gu, "");
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
    const current = s[i] ?? "";
    const next = s[i + 1] ?? "";
    if (current === "" && next === "[") {
      i += 2;
      while (i < s.length && s[i] !== "m") i++;
      if (i < s.length) i++;
      out += s.slice(start, i);
    } else {
      out += current;
      visible++;
      i++;
    }
  }
  return out;
}

function fit(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible <= width) return text;
  if (width <= 3) return stripAnsi(text).slice(0, width);
  return `${ansiSafeSlice(text, width - 3)}...`;
}

function fmtTotal(total: UsageTotal): string {
  return `in ${fmtTokens(total.input)}  out ${fmtTokens(total.output)}  $${total.cost.toFixed(3)}`;
}

// ── SummaryPanel (TUI widget) ──────────────────────────────────────────────

interface SummaryState {
  phase: Phase;
  state: string;
  now: string;
  next?: string;
  totalUsageText?: string;
}

class SummaryPanel implements PiTuiComponent {
  private readonly theme: PiTuiTheme;
  private summary: SummaryState | null = null;
  private spinning = false;
  private animInterval: ReturnType<typeof setInterval> | undefined;
  private requestRender: () => void = () => { return; };

  constructor(theme: PiTuiTheme) {
    this.theme = theme;
  }

  bindRender(fn: () => void): void {
    this.requestRender = fn;
  }

  setSummary(summary: SummaryState | null): void {
    this.summary = summary == null ? null : { ...summary };
    const active = summary !== null && summary.state !== "complete" && summary.state !== "failed";
    if (active && !this.spinning) {
      this.spinning = true;
      this.animInterval = setInterval(() => this.requestRender(), SPINNER_INTERVAL_MS);
    } else if (!active && this.spinning) {
      this.spinning = false;
      if (this.animInterval !== undefined) {
        clearInterval(this.animInterval);
        this.animInterval = undefined;
      }
    }
    this.requestRender();
  }

  close(): void {
    if (this.animInterval !== undefined) {
      clearInterval(this.animInterval);
      this.animInterval = undefined;
    }
  }

  render(width: number): string[] {
    if (this.summary == null) return [];
    const w = Math.max(20, width);
    const spin = this.spinning ? this.theme.fg("accent", spinnerFrame()) + " " : "";
    const lines = [
      this.theme.fg("accent", `ralpix: ${this.summary.phase} | ${this.summary.state}`),
      `${spin}Now: ${this.summary.now.length > 0 ? this.summary.now : "-"}`,
      `Next: ${this.summary.next ?? "-"}`,
      `Total: ${this.summary.totalUsageText ?? "-"}`,
    ];
    return lines.map((line, i) => fit(i === 0 ? line : this.theme.fg("muted", line), w),
    );
  }

  invalidate(): void { return; }
}

// ── createSummaryTui ───────────────────────────────────────────────────────

export interface SummaryTuiRuntime {
  close: () => void;
  setSummary: (summary: SummaryState | null) => void;
}

export function createSummaryTui(
  ctx: ExtensionCommandContext,
  widgetKey: string,
): SummaryTuiRuntime {
  if (!ctx.hasUI) {
    return {
      close() { return; },
      setSummary() { return; },
    };
  }

  const panel = new SummaryPanel(ctx.ui.theme);

  ctx.ui.setWidget(widgetKey, (ui: PiTuiRuntime) => {
    panel.bindRender(() => ui.requestRender());
    return panel;
  });

  return {
    close() {
      panel.close();
      ctx.ui.setWidget(widgetKey, undefined);
    },
    setSummary(summary) {
      panel.setSummary(summary);
    },
  };
}

// ── createTokenLedger ──────────────────────────────────────────────────────

export function createTokenLedger() {
  const map = new Map<string, UsageBreakdownEntry>();

  function add(provider: string, model: string, usage: SubprocessUsage): void {
    const key = `${provider}/${model}`;
    const prev = map.get(key) ?? {
      provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
    };
    map.set(key, {
      provider,
      model,
      input: prev.input + usage.input,
      output: prev.output + usage.output,
      cacheRead: prev.cacheRead + usage.cacheRead,
      cacheWrite: prev.cacheWrite + usage.cacheWrite,
      cost: prev.cost + usage.cost,
    });
  }

  function breakdown(): UsageBreakdownEntry[] {
    return [...map.values()].map((e) => ({ ...e }));
  }

  function snapshot() {
    return breakdown().reduce(
      (acc, e) => ({
        input: acc.input + e.input + e.cacheRead + e.cacheWrite,
        output: acc.output + e.output,
        cost: acc.cost + e.cost,
      }),
      { input: 0, output: 0, cost: 0 },
    );
  }

  function totalText(): string {
    const s = snapshot();
    return `in ${fmtTokens(s.input)}  out ${fmtTokens(s.output)}  $${s.cost.toFixed(3)}`;
  }

  function usageLines(): string[] {
    return formatUsageBreakdownLines(breakdown());
  }

  return { add, breakdown, snapshot, totalText, usageLines };
}

// ── ProgressPanel (exported for index.ts status widget) ───────────────────

export { fit, fmtTotal, spinnerFrame };

export { summarizeUsageSnapshot } from "./utils.js";
