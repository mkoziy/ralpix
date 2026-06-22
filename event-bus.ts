import { z } from "zod";

import type { AgentEvent, AgentEventEmitter } from "./events.js";
import type { Phase } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Zod schemas ────────────────────────────────────────────────────────────

const phaseSchema = z.enum(["brainstorm", "plan", "execute", "review"]);
const baseSchema = z.object({ phase: phaseSchema, createdAt: z.string() }).strict();

const usageStepSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
}).strict();

const usageTotalSchema = z.object({
  input: z.number(),
  output: z.number(),
  cost: z.number(),
}).strict();

const usageBreakdownEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
}).strict();

const eventUsageSchema = z.object({
  step: usageStepSchema,
  total: usageTotalSchema,
  breakdown: z.array(usageBreakdownEntrySchema).optional(),
}).strict();

const reviewStageIdSchema = z.enum(["first-pass", "first-pass-stabilize", "external-review", "external-eval", "second-pass"]);
const reviewStageStatusFinalSchema = z.enum(["complete", "failed", "skipped"]);

export const agentEventSchema = z.discriminatedUnion("type", [
  baseSchema.extend({ type: z.literal("phase_start"), label: z.string().optional() }),
  baseSchema.extend({ type: z.literal("phase_end"), label: z.string().optional() }),
  baseSchema.extend({ type: z.literal("question"), promptId: z.string(), message: z.string(), next: z.string().optional() }),
  baseSchema.extend({ type: z.literal("answer"), promptId: z.string(), message: z.string(), usage: eventUsageSchema.optional() }),
  baseSchema.extend({ type: z.literal("approach_selected"), approach: z.string() }),
  baseSchema.extend({ type: z.literal("section_validated"), section: z.string(), passed: z.boolean(), detail: z.string().optional() }),
  baseSchema.extend({ type: z.literal("round_start"), round: z.number(), label: z.string().optional() }),
  baseSchema.extend({ type: z.literal("round_end"), round: z.number(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("draft_generated"), digest: z.string() }),
  baseSchema.extend({ type: z.literal("review_result"), source: z.enum(["ai", "critic", "user"]), action: z.string(), digest: z.string().optional() }),
  baseSchema.extend({ type: z.literal("critic_start") }),
  baseSchema.extend({ type: z.literal("critic_end"), digest: z.string(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("ai_review_start") }),
  baseSchema.extend({ type: z.literal("ai_review_end"), digest: z.string(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("human_review"), action: z.string() }),
  baseSchema.extend({ type: z.literal("task_start"), taskId: z.string(), taskNumber: z.number(), taskTitle: z.string(), itemCount: z.number() }),
  baseSchema.extend({ type: z.literal("attempt_start"), taskId: z.string(), attempt: z.number(), modelLabel: z.string().optional() }),
  baseSchema.extend({ type: z.literal("attempt_end"), taskId: z.string(), attempt: z.number(), success: z.boolean(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("task_end"), taskId: z.string(), taskNumber: z.number(), taskTitle: z.string(), success: z.boolean(), detail: z.string().optional(), committed: z.boolean().optional(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("stage_start"), stage: reviewStageIdSchema, detail: z.string().optional() }),
  baseSchema.extend({ type: z.literal("stage_update"), stage: reviewStageIdSchema, detail: z.string() }),
  baseSchema.extend({ type: z.literal("stage_finish"), stage: reviewStageIdSchema, status: reviewStageStatusFinalSchema, detail: z.string().optional(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("iteration_start"), stage: reviewStageIdSchema, iteration: z.number() }),
  baseSchema.extend({ type: z.literal("iteration_end"), stage: reviewStageIdSchema, iteration: z.number(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("eval_iteration_start"), iteration: z.number() }),
  baseSchema.extend({ type: z.literal("eval_iteration_end"), iteration: z.number(), usage: eventUsageSchema }),
  baseSchema.extend({ type: z.literal("status_changed"), state: z.string(), now: z.string(), next: z.string().optional() }),
  baseSchema.extend({ type: z.literal("milestone"), kind: z.string(), message: z.string() }),
  baseSchema.extend({ type: z.literal("usage_checkpoint"), totalUsageText: z.string() }),
]);

// ── RunSession interface ───────────────────────────────────────────────────

export interface SelectPromptOptions {
  title?: string;
}

export interface InputPromptOptions {
  placeholder?: string;
  title?: string;
}

export interface ConfirmPromptOptions {
  body?: string;
}

export interface RunSession {
  log: (type: string, data?: Record<string, unknown>) => void;
  choose: (prompt: string, options: string[], config?: SelectPromptOptions) => Promise<string | null>;
  confirm: (prompt: string, config?: ConfirmPromptOptions) => Promise<boolean>;
  input: (prompt: string, config?: InputPromptOptions) => Promise<string | null>;
  milestone: (kind: string, message: string) => void;
  statusChanged: (state: string, now: string, next?: string) => void;
  usageCheckpoint: (totalUsageText: string) => void;
  close: () => void;
}

// ── createEventBus ─────────────────────────────────────────────────────────

export function createEventBus(
  ctx: ExtensionCommandContext,
  phase: Phase,
  emitters: AgentEventEmitter[],
): RunSession {
  function log(type: string, data: Record<string, unknown> = {}): void {
    const raw: Record<string, unknown> = {
      type,
      phase,
      createdAt: new Date().toISOString(),
      ...data,
    };
    const result = agentEventSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(`[event-bus] malformed "${type}" event: ${result.error.message}`);
    }
    const event = result.data as AgentEvent;
    for (const emitter of emitters) {
      emitter.emit(event);
    }
  }

  return {
    log,

    async choose(prompt, options, config) {
      const selected = await ctx.ui.select(config?.title ?? prompt, options);
      return selected ?? null;
    },

    async confirm(prompt, config) {
      const accepted = await ctx.ui.confirm(prompt, config?.body ?? "");
      return accepted ?? false;
    },

    async input(prompt, config) {
      const answer = await ctx.ui.input(config?.title ?? prompt, config?.placeholder);
      if (typeof answer !== "string" || answer.trim().length === 0) return null;
      return answer.trim();
    },

    milestone(kind, message) {
      log("milestone", { kind, message });
    },

    statusChanged(state, now, next) {
      log("status_changed", { state, now, ...(next === undefined ? {} : { next }) });
    },

    usageCheckpoint(totalUsageText) {
      log("usage_checkpoint", { totalUsageText });
    },

    close() {
      if (ctx.hasUI) ctx.ui.setStatus("ralpix", undefined);
    },
  };
}
