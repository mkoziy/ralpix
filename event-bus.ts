import { fmtTokens, type LogWriter, type UsageSummary } from "./logger.js";
import { createSummaryTui, type SummaryTuiRuntime } from "./tui.js";

import type { AgentEvent, AgentEventEmitter } from "./events.js";
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

type UiEvent = {
  type: "question_asked"; phase: Phase; promptId: string; message: string; createdAt: string; next?: string;
} | {
  type: "answer_recorded"; phase: Phase; promptId: string; message: string; createdAt: string;
} | {
  type: "prompt_cancelled"; phase: Phase; promptId: string; reason: string; createdAt: string;
} | {
  type: "state_changed"; phase: Phase; state: UiState; now: string; createdAt: string; next?: string;
} | {
  type: "milestone"; phase: Phase; kind: UiTranscriptMilestoneKind; message: string; createdAt: string;
} | {
  type: "usage_checkpoint"; phase: Phase; totalUsageText: string; createdAt: string;
};

export interface UiPresentationState {
  events: UiEvent[];
  summary: UiCurrentSummary | null;
  transcript: UiTranscriptEntry[];
}

export type SessionMessageKind = "info" | "success" | "warning" | "error" | "question" | "answer" | "result";

export type SessionStatusKind = "idle" | "thinking" | "drafting" | "running" | "retrying" | "waiting" | "reviewing" | "complete" | "failed";

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
  log: (event: string, data?: Record<string, unknown>) => void;
  message: (kind: SessionMessageKind, text: string) => void;
  phase: (phase: Phase) => void;
  snapshot: () => UiPresentationState;
  status: (kind: SessionStatusKind, text: string, next?: string) => void;
  usage: (totalUsageText: string) => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_EVENT_TYPES = new Set<string>([
  "phase_start",
  "phase_end",
  "question",
  "answer",
  "approach_selected",
  "section_validated",
  "round_start",
  "round_end",
  "draft_generated",
  "review_result",
  "task_start",
  "attempt_start",
  "attempt_end",
  "task_end",
  "stage_start",
  "stage_update",
  "stage_finish",
  "iteration_start",
  "iteration_end",
  "eval_iteration_start",
  "eval_iteration_end",
  "critic_start",
  "critic_end",
  "ai_review_start",
  "ai_review_end",
  "human_review",
  "status_changed",
  "milestone",
  "usage_checkpoint",
]);

const VALID_PHASES = new Set<string>(["brainstorm", "plan", "execute", "review"]);

function validateEventType(eventType: string): void {
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(`[event-bus] Unknown AgentEvent type: "${eventType}"`);
  }
}

function validatePhase(phase: unknown): void {
  if (typeof phase !== "string" || !VALID_PHASES.has(phase)) {
    throw new Error(`[event-bus] Invalid phase: "${String(phase)}"`);
  }
}

// ---------------------------------------------------------------------------
// Emitter factories
// ---------------------------------------------------------------------------

export function createLogWriterEmitter(logger: LogWriter): AgentEventEmitter {
  return {
    emit(event: AgentEvent): void {
      const eventData: Record<string, unknown> = { ...event };
      delete eventData["type"];
      delete eventData["phase"];
      delete eventData["createdAt"];
      logger.write(event.type, eventData);
    },
  };
}

// ---------------------------------------------------------------------------
// UI state store (internal — also exported for tests)
// ---------------------------------------------------------------------------

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

function sessionStatusToUiState(kind: SessionStatusKind): UiState | null {
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

function stringToUiState(state: string): UiState | null {
  const valid = new Set<string>(["thinking", "waiting", "running", "retrying", "reviewing", "complete", "failed"]);
  return valid.has(state) ? (state as UiState) : null;
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

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

export function formatOptions(options: string[]): string {
  if (options.length === 0) return "";
  return options.map((option) => `- ${option}`).join("\n");
}

export function formatTotalUsageText(usage: UsageSummary): string {
  return `in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function promptIdFactory() {
  let nextId = 1;
  return () => `prompt-${String(nextId++)}`;
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
      const statusText =
        summary.now.length === 0
          ? `ralpix: ${summary.phase} | ${summary.state}`
          : `ralpix: ${summary.phase} | ${summary.state} | ${summary.now}`;
      ctx.ui.setStatus("ralpix", statusText);
    },
  };
}

// ---------------------------------------------------------------------------
// createEventBus — replaces createCliSession
// ---------------------------------------------------------------------------

export function createEventBus(
  ctx: ExtensionCommandContext,
  initialPhase: Phase,
  emitters: AgentEventEmitter[],
): RunSession {
  const transcriptSink = createTranscriptSink(ctx);
  const summaryRenderer = createSummaryRenderer(ctx, initialPhase);
  const stateStore = createUiStateStore(initialPhase, transcriptSink, summaryRenderer);
  const nextPromptId = promptIdFactory();

  function dispatchAgentEvent(event: AgentEvent): void {
    const phase = event.phase;
    const createdAt = event.createdAt;

    if (event.type === "milestone") {
      stateStore.applyEvent({ type: "milestone", phase, kind: event.kind as UiTranscriptMilestoneKind, message: event.message, createdAt });
    } else if (event.type === "status_changed") {
      const uiState = stringToUiState(event.state);
      if (uiState !== null && event.now.length > 0) {
        stateStore.applyEvent({
          type: "state_changed",
          phase,
          state: uiState,
          now: event.now,
          ...(event.next == null ? {} : { next: event.next }),
          createdAt,
        });
      } else {
        stateStore.clearSummary();
      }
    } else if (event.type === "usage_checkpoint") {
      stateStore.applyEvent({ type: "usage_checkpoint", phase, totalUsageText: event.totalUsageText, createdAt });
    }

    for (const emitter of emitters) {
      emitter.emit(event);
    }
  }

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
    log(eventType: string, data: Record<string, unknown> = {}): void {
      validateEventType(eventType);
      const phase = stateStore.phase();
      validatePhase(phase);
      const event = {
        type: eventType,
        phase,
        createdAt: nowIso(),
        ...data,
      } as AgentEvent;
      dispatchAgentEvent(event);
    },
    message(kind, text) {
      session.log("milestone", {
        kind: kindForMessage(kind),
        message: text,
      });
    },
    phase(phase) {
      stateStore.setPhase(phase);
    },
    snapshot() {
      return stateStore.snapshot();
    },
    status(kind, text, next) {
      const uiState = sessionStatusToUiState(kind);
      if (uiState === null || text.length === 0) {
        session.clearStatus();
        return;
      }
      session.log("status_changed", {
        state: uiState,
        now: text,
        ...(next == null ? {} : { next }),
      });
    },
    usage(totalUsageText) {
      session.log("usage_checkpoint", { totalUsageText });
    },
  };

  return session;
}
