import { fmtTokens, type UsageSummary } from "./logger.js";
import { createSummaryTui, type SummaryTuiRuntime } from "./tui.js";

import type { Phase } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type UiTranscriptKind = "INFO" | "Q" | "A" | "STEP" | "TASK" | "STAGE" | "RESULT" | "OK" | "WARN" | "ERR";

export type UiState = "thinking" | "waiting" | "running" | "retrying" | "reviewing" | "complete" | "failed";

export interface UiTranscriptEntry {
  phase: Phase;
  kind: UiTranscriptKind;
  message: string;
  createdAt: string;
}

export interface UiCurrentSummary {
  phase: Phase;
  state: UiState;
  now: string;
  next?: string;
  totalUsageText?: string;
}

export type UiTranscriptMilestoneKind = Exclude<UiTranscriptKind, "Q" | "A">;

export type UiEvent =
  | { type: "question_asked"; phase: Phase; promptId: string; message: string; createdAt: string; next?: string } |
  { type: "answer_recorded"; phase: Phase; promptId: string; message: string; createdAt: string } |
  { type: "prompt_cancelled"; phase: Phase; promptId: string; reason: string; createdAt: string } |
  { type: "state_changed"; phase: Phase; state: UiState; now: string; createdAt: string; next?: string } |
  { type: "milestone"; phase: Phase; kind: UiTranscriptMilestoneKind; message: string; createdAt: string } |
  { type: "usage_checkpoint"; phase: Phase; totalUsageText: string; createdAt: string };

export interface UiPresentationState {
  events: UiEvent[];
  summary: UiCurrentSummary | null;
  transcript: UiTranscriptEntry[];
}

export type SessionMessageKind = "info" | "success" | "warning" | "error" | "question" | "answer" | "result";

export type SessionStatusKind =
  "idle" | "thinking" | "drafting" | "running" | "retrying" | "waiting" | "reviewing" | "complete" | "failed";

type NotifyLevel = "error" | "info" | "success" | "warning";

export interface SelectPromptOptions {
  title?: string;
}

export interface InputPromptOptions {
  placeholder?: string;
  title?: string;
}

export interface ConfirmPromptOptions {
  body?: string;
  historyLabel?: string;
}

export interface UiTranscriptSink {
  append: (entry: UiTranscriptEntry) => void;
}

export interface UiSummaryRenderer {
  render: (summary: UiCurrentSummary | null) => void;
}

export interface RunSession {
  choose: (prompt: string, options: string[], config?: SelectPromptOptions) => Promise<string | null>;
  clearStatus: () => void;
  close: () => void;
  confirm: (prompt: string, config?: ConfirmPromptOptions) => Promise<boolean | null>;
  input: (prompt: string, config?: InputPromptOptions) => Promise<string | null>;
  message: (kind: SessionMessageKind, text: string) => void;
  phase: (phase: Phase) => void;
  snapshot: () => UiPresentationState;
  status: (kind: SessionStatusKind, text: string, next?: string) => void;
  usage: (totalUsageText: string) => void;
}

function messagePrefix(kind: UiTranscriptKind): string {
  return kind;
}

function levelForTranscript(kind: UiTranscriptKind): NotifyLevel {
  switch (kind) {
    case "OK": {
      return "success";
    }
    case "WARN": {
      return "warning";
    }
    case "ERR": {
      return "error";
    }
    case "INFO":
    case "Q":
    case "A":
    case "STEP":
    case "TASK":
    case "STAGE":
    case "RESULT": {
      return "info";
    }
  }
}

function kindForMessage(kind: SessionMessageKind): UiTranscriptKind {
  switch (kind) {
    case "success": {
      return "OK";
    }
    case "warning": {
      return "WARN";
    }
    case "error": {
      return "ERR";
    }
    case "question": {
      return "Q";
    }
    case "answer": {
      return "A";
    }
    case "result": {
      return "RESULT";
    }
    case "info": {
      return "INFO";
    }
  }
}

function statusToUiState(kind: SessionStatusKind): UiState | null {
  switch (kind) {
    case "idle": {
      return null;
    }
    case "thinking":
    case "drafting": {
      return "thinking";
    }
    case "running": {
      return "running";
    }
    case "retrying": {
      return "retrying";
    }
    case "waiting": {
      return "waiting";
    }
    case "reviewing": {
      return "reviewing";
    }
    case "complete": {
      return "complete";
    }
    case "failed": {
      return "failed";
    }
  }
}

function renderTranscriptEntry(entry: UiTranscriptEntry): string {
  return `[${entry.phase}] ${messagePrefix(entry.kind)} ${entry.message}`;
}

export function createUiStateStore(
  initialPhase: Phase,
  transcriptSink: UiTranscriptSink,
  summaryRenderer: UiSummaryRenderer,
) {
  const state: UiPresentationState = {
    events: [],
    summary: null,
    transcript: [],
  };

  let currentPhase = initialPhase;

  const commitSummary = (summary: UiCurrentSummary | null): void => {
    state.summary = summary == null ? null : { ...summary };
    summaryRenderer.render(state.summary);
  };

  const appendTranscript = (entry: UiTranscriptEntry): void => {
    state.transcript.push(entry);
    transcriptSink.append(entry);
  };

  const applyEvent = (event: UiEvent): void => {
    state.events.push(event);
    currentPhase = event.phase;

    switch (event.type) {
      case "question_asked": {
        appendTranscript({
          phase: event.phase,
          kind: "Q",
          message: event.message,
          createdAt: event.createdAt,
        });
        commitSummary({
          phase: event.phase,
          state: "waiting",
          now: event.message,
          next: event.next ?? "Answer the prompt",
          ...(state.summary?.totalUsageText == null ? {} : { totalUsageText: state.summary.totalUsageText }),
        });
        break;
      }
      case "answer_recorded": {
        appendTranscript({
          phase: event.phase,
          kind: "A",
          message: event.message,
          createdAt: event.createdAt,
        });
        break;
      }
      case "prompt_cancelled": {
        appendTranscript({
          phase: event.phase,
          kind: "WARN",
          message: event.reason,
          createdAt: event.createdAt,
        });
        break;
      }
      case "state_changed": {
        commitSummary({
          phase: event.phase,
          state: event.state,
          now: event.now,
          ...(event.next == null ? {} : { next: event.next }),
          ...(state.summary?.totalUsageText == null ? {} : { totalUsageText: state.summary.totalUsageText }),
        });
        break;
      }
      case "milestone": {
        appendTranscript({
          phase: event.phase,
          kind: event.kind,
          message: event.message,
          createdAt: event.createdAt,
        });
        break;
      }
      case "usage_checkpoint": {
        commitSummary(
          state.summary == null
            ? {
              phase: currentPhase,
              state: "running",
              now: "",
              totalUsageText: event.totalUsageText,
            }
            : {
              ...state.summary,
              totalUsageText: event.totalUsageText,
            },
        );
        break;
      }
    }
  };

  return {
    applyEvent,
    clearSummary(): void {
      commitSummary(null);
    },
    phase(): Phase {
      return currentPhase;
    },
    setPhase(phase: Phase): void {
      currentPhase = phase;
      if (state.summary != null) {
        commitSummary({ ...state.summary, phase });
      }
    },
    snapshot(): UiPresentationState {
      return {
        events: [...state.events],
        summary: state.summary == null ? null : { ...state.summary },
        transcript: [...state.transcript],
      };
    },
  };
}

function createTranscriptSink(ctx: ExtensionCommandContext): UiTranscriptSink {
  return {
    append(entry) {
      ctx.ui.notify(renderTranscriptEntry(entry), levelForTranscript(entry.kind));
    },
  };
}

function createSummaryRenderer(
  ctx: ExtensionCommandContext,
  phase: Phase,
): UiSummaryRenderer & { close: () => void } {
  const widgetKey = `ralpix-summary-${phase}`;
  const tui: SummaryTuiRuntime = createSummaryTui(ctx, widgetKey);

  return {
    close() {
      tui.close();
      if (ctx.hasUI) {
        ctx.ui.setStatus("ralpix", undefined);
      }
    },
    render(summary) {
      tui.setSummary(summary);
      if (!ctx.hasUI || summary == null) {
        if (ctx.hasUI) ctx.ui.setStatus("ralpix", undefined);
        return;
      }
      const statusText = summary.now.length === 0
        ? `ralpix: ${summary.phase} | ${summary.state}`
        : `ralpix: ${summary.phase} | ${summary.state} | ${summary.now}`;
      ctx.ui.setStatus("ralpix", statusText);
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function promptIdFactory() {
  let nextId = 1;
  return () => `prompt-${String(nextId++)}`;
}

function inferPhase(title: string): Phase {
  if (title.startsWith("brainstorm:")) return "brainstorm";
  if (title.startsWith("plan:")) return "plan";
  if (title.startsWith("review:")) return "review";
  return "execute";
}

export function formatOptions(options: string[]): string {
  if (options.length === 0) return "";
  return options.map((option) => `- ${option}`).join("\n");
}

export function formatTotalUsageText(usage: UsageSummary): string {
  return `in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`;
}

export function createMemoryUiAdapters() {
  const transcript: UiTranscriptEntry[] = [];
  let summary: UiCurrentSummary | null = null;

  return {
    summaryRenderer: {
      render(nextSummary: UiCurrentSummary | null) {
        summary = nextSummary == null ? null : { ...nextSummary };
      },
    } satisfies UiSummaryRenderer,
    transcript,
    transcriptSink: {
      append(entry: UiTranscriptEntry) {
        transcript.push(entry);
      },
    } satisfies UiTranscriptSink,
    getSummary() {
      return summary;
    },
  };
}

export function createCliSession(
  ctx: ExtensionCommandContext,
  title: string,
  initialPhase: Phase = inferPhase(title),
): RunSession {
  const transcriptSink = createTranscriptSink(ctx);
  const summaryRenderer = createSummaryRenderer(ctx, initialPhase);
  const stateStore = createUiStateStore(initialPhase, transcriptSink, summaryRenderer);
  const nextPromptId = promptIdFactory();

  const session: RunSession = {
    async choose(prompt, options, config) {
      const promptId = nextPromptId();
      const body = formatOptions(options);
      stateStore.applyEvent({
        type: "question_asked",
        phase: stateStore.phase(),
        promptId,
        message: body.length === 0 ? prompt : `${prompt}\n${body}`,
        createdAt: nowIso(),
        next: "Select an option",
      });
      const selected = await ctx.ui.select(config?.title ?? prompt, options);
      if (typeof selected === "string") {
        stateStore.applyEvent({
          type: "answer_recorded",
          phase: stateStore.phase(),
          promptId,
          message: selected,
          createdAt: nowIso(),
        });
        return selected;
      }
      stateStore.applyEvent({
        type: "prompt_cancelled",
        phase: stateStore.phase(),
        promptId,
        reason: `Prompt cancelled: ${prompt}`,
        createdAt: nowIso(),
      });
      return null;
    },
    clearStatus() {
      stateStore.clearSummary();
    },
    close() {
      summaryRenderer.close();
    },
    async confirm(prompt, config) {
      const promptId = nextPromptId();
      stateStore.applyEvent({
        type: "question_asked",
        phase: stateStore.phase(),
        promptId,
        message: config?.body == null ? prompt : `${prompt}\n${config.body}`,
        createdAt: nowIso(),
        next: "Confirm or cancel",
      });
      const accepted = await ctx.ui.confirm(prompt, config?.body ?? "");
      if (typeof accepted === "boolean") {
        const label = config?.historyLabel ?? prompt;
        stateStore.applyEvent({
          type: "answer_recorded",
          phase: stateStore.phase(),
          promptId,
          message: `${label}: ${accepted ? "yes" : "no"}`,
          createdAt: nowIso(),
        });
        return accepted;
      }
      stateStore.applyEvent({
        type: "prompt_cancelled",
        phase: stateStore.phase(),
        promptId,
        reason: `Prompt cancelled: ${prompt}`,
        createdAt: nowIso(),
      });
      return null;
    },
    async input(prompt, config) {
      const promptId = nextPromptId();
      stateStore.applyEvent({
        type: "question_asked",
        phase: stateStore.phase(),
        promptId,
        message: prompt,
        createdAt: nowIso(),
        next: "Enter a response",
      });
      const answer = await ctx.ui.input(config?.title ?? prompt, config?.placeholder ?? "Your answer");
      if (typeof answer === "string") {
        const trimmed = answer.trim();
        if (trimmed.length > 0) {
          stateStore.applyEvent({
            type: "answer_recorded",
            phase: stateStore.phase(),
            promptId,
            message: trimmed,
            createdAt: nowIso(),
          });
          return trimmed;
        }
        stateStore.applyEvent({
          type: "prompt_cancelled",
          phase: stateStore.phase(),
          promptId,
          reason: `Prompt cancelled: ${prompt}`,
          createdAt: nowIso(),
        });
        return answer;
      }
      stateStore.applyEvent({
        type: "prompt_cancelled",
        phase: stateStore.phase(),
        promptId,
        reason: `Prompt cancelled: ${prompt}`,
        createdAt: nowIso(),
      });
      return null;
    },
    message(kind, text) {
      stateStore.applyEvent({
        type: "milestone",
        phase: stateStore.phase(),
        kind: kindForMessage(kind) as UiTranscriptMilestoneKind,
        message: text,
        createdAt: nowIso(),
      });
    },
    phase(phase) {
      stateStore.setPhase(phase);
    },
    snapshot() {
      return stateStore.snapshot();
    },
    status(kind, text, next) {
      const state = statusToUiState(kind);
      if (state == null || text.length === 0) {
        session.clearStatus();
        return;
      }
      stateStore.applyEvent({
        type: "state_changed",
        phase: stateStore.phase(),
        state,
        now: text,
        ...(next == null ? {} : { next }),
        createdAt: nowIso(),
      });
    },
    usage(totalUsageText) {
      stateStore.applyEvent({
        type: "usage_checkpoint",
        phase: stateStore.phase(),
        totalUsageText,
        createdAt: nowIso(),
      });
    },
  };

  return session;
}
