import {
  fmtTokens,
  formatUsageBreakdownLines,

} from "./utils.js";

import type { AgentEvent, AgentEventEmitter, UsageBreakdownEntry, UsageTotal } from "./events.js";
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

function detailSuffix(detail?: string): string {
  return detail === undefined ? "" : `: ${detail}`;
}

function modelLabelSuffix(modelLabel?: string): string {
  return modelLabel === undefined ? "" : ` (${modelLabel})`;
}

function committedSuffix(committed?: boolean): string {
  return committed === true ? " (committed)" : "";
}

function stageDetailSuffix(detail?: string): string {
  return detail === undefined ? "" : ` — ${detail}`;
}

function levelForStageStatus(status: "complete" | "failed" | "skipped"): "error" | "info" | "success" {
  if (status === "complete") return "success";
  if (status === "skipped") return "info";
  return "error";
}

function levelForMilestone(kind: string): "error" | "info" | "success" | "warning" {
  if (kind === "ERR") return "error";
  if (kind === "WARN") return "warning";
  if (kind === "OK") return "success";
  return "info";
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

// ── createTuiEmitter ───────────────────────────────────────────────────────

export function createTuiEmitter(ctx: ExtensionCommandContext): AgentEventEmitter {
  const widgetKey = "ralpix-summary";
  const tui = createSummaryTui(ctx, widgetKey);

  let currentSummary: SummaryState | null = null;

  function notify(message: string, level: "info" | "success" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  function setStatus(summary: SummaryState | null): void {
    currentSummary = summary;
    tui.setSummary(summary);
    if (ctx.hasUI) {
      if (summary == null) {
        ctx.ui.setStatus("ralpix", undefined);
      } else {
        const text = summary.now.length > 0
          ? `ralpix: ${summary.phase} | ${summary.state} | ${summary.now}`
          : `ralpix: ${summary.phase} | ${summary.state}`;
        ctx.ui.setStatus("ralpix", text);
      }
    }
  }

  function updateSummaryField(patch: Partial<SummaryState>): void {
    if (currentSummary == null) return;
    setStatus({ ...currentSummary, ...patch });
  }

  return {
    // eslint-disable-next-line sonarjs/cognitive-complexity
    emit(event: AgentEvent): void {
      const phase = event.phase;

      switch (event.type) {
        case "phase_start": {
          setStatus({ phase, state: "running", now: event.label ?? phase });
          notify(`[${phase}] started`);
          break;
        }
        case "phase_end": {
          setStatus(null);
          notify(`[${phase}] complete`, "success");
          break;
        }
        case "question": {
          setStatus({
            phase,
            state: "waiting",
            now: event.message,
            ...(event.next === undefined ? {} : { next: event.next }),
          });
          notify(`Q: ${event.message}`);
          break;
        }
        case "answer": {
          notify(`A: ${event.message}`);
          if (event.usage !== undefined) {
            updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          }
          break;
        }
        case "approach_selected": {
          notify(`Approach: ${event.approach}`);
          break;
        }
        case "section_validated": {
          const icon = event.passed ? "✓" : "✗";
          notify(
            `${icon} ${event.section}${detailSuffix(event.detail)}`,
            event.passed ? "success" : "warning",
          );
          break;
        }
        case "round_start": {
          const label = event.label ?? `Round ${String(event.round)}`;
          setStatus({ phase, state: "running", now: label });
          notify(label);
          break;
        }
        case "round_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          break;
        }
        case "draft_generated": {
          notify("Plan draft generated");
          break;
        }
        case "review_result": {
          notify(`Review (${event.source}): ${event.action}`);
          break;
        }
        case "critic_start": {
          setStatus({ phase, state: "reviewing", now: "Critic reviewing…" });
          break;
        }
        case "critic_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total), now: "Critic done" });
          break;
        }
        case "ai_review_start": {
          setStatus({ phase, state: "reviewing", now: "AI reviewing…" });
          break;
        }
        case "ai_review_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total), now: "AI review done" });
          break;
        }
        case "human_review": {
          notify(`Human review: ${event.action}`);
          break;
        }
        case "task_start": {
          setStatus({
            phase,
            state: "running",
            now: `Task ${String(event.taskNumber)}: ${event.taskTitle}`,
            next: `${String(event.itemCount)} items`,
          });
          notify(`Task ${String(event.taskNumber)}: ${event.taskTitle}`);
          break;
        }
        case "attempt_start": {
          updateSummaryField({
            state: "running",
            now: `Attempt ${String(event.attempt)}${modelLabelSuffix(event.modelLabel)}`,
          });
          break;
        }
        case "attempt_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          if (!event.success) notify(`Attempt ${String(event.attempt)} failed`, "warning");
          break;
        }
        case "task_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          const taskLabel = `Task ${String(event.taskNumber)}: ${event.taskTitle}`;
          if (event.success) {
            notify(`✓ ${taskLabel}${committedSuffix(event.committed)}`, "success");
          } else {
            notify(`✗ ${taskLabel}${detailSuffix(event.detail)}`, "error");
          }
          break;
        }
        case "stage_start": {
          setStatus({
            phase,
            state: "reviewing",
            now: `Stage: ${event.stage}${stageDetailSuffix(event.detail)}`,
          });
          notify(`Stage ${event.stage} started`);
          break;
        }
        case "stage_update": {
          updateSummaryField({ now: event.detail });
          break;
        }
        case "stage_finish": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total), now: `Stage ${event.stage}: ${event.status}` });
          const level = levelForStageStatus(event.status);
          notify(`Stage ${event.stage}: ${event.status}`, level);
          break;
        }
        case "iteration_start": {
          updateSummaryField({ now: `${event.stage} iteration ${String(event.iteration)}` });
          break;
        }
        case "iteration_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          break;
        }
        case "eval_iteration_start": {
          updateSummaryField({ now: `Eval iteration ${String(event.iteration)}` });
          break;
        }
        case "eval_iteration_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          break;
        }
        case "status_changed": {
          setStatus({
            phase,
            state: event.state,
            now: event.now,
            ...(event.next === undefined ? {} : { next: event.next }),
          });
          break;
        }
        case "milestone": {
          const level = levelForMilestone(event.kind);
          notify(event.message, level);
          break;
        }
        case "usage_checkpoint": {
          updateSummaryField({ totalUsageText: event.totalUsageText });
          break;
        }
      }
    },
  };
}

// ── ProgressPanel (exported for index.ts status widget) ───────────────────

export { fit, fmtTotal, spinnerFrame };

export { summarizeUsageSnapshot } from "./utils.js";
