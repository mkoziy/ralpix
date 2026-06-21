import { z } from "zod";

import { agentEventSchema } from "./event-bus.js";

import type { AgentEvent } from "./events.js";
import type { LogWriter } from "./logger.js";
import type { Phase } from "./types.js";

const phaseSchema = z.enum(["brainstorm", "plan", "execute", "review"]);

const loggerTargetSchema = z.object({
  phase: phaseSchema,
  sessionName: z.string().min(1),
});

const loggerEventEnvelopeSchema = z.object({
  type: z.literal("event"),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  target: loggerTargetSchema,
  event: agentEventSchema,
}).superRefine((value, context) => {
  if (value.target.phase !== value.event.phase) {
    context.addIssue({
      code: "custom",
      message: "target phase must match event phase",
      path: ["target", "phase"],
    });
  }
});

const loggerShutdownEnvelopeSchema = z.object({
  type: z.literal("shutdown"),
  runId: z.string().min(1),
  target: loggerTargetSchema.optional(),
  reason: z.string().optional(),
});

const loggerAckEnvelopeSchema = z.object({
  type: z.literal("ack"),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  phase: phaseSchema,
  sessionName: z.string().min(1),
});

export const loggerInputEnvelopeSchema = z.discriminatedUnion("type", [
  loggerEventEnvelopeSchema,
  loggerShutdownEnvelopeSchema,
]);

export const loggerAckSchema = loggerAckEnvelopeSchema;

export interface LoggerEventEnvelope {
  type: "event";
  runId: string;
  seq: number;
  target: { phase: Phase; sessionName: string };
  event: AgentEvent;
}

export interface LoggerShutdownEnvelope {
  type: "shutdown";
  runId: string;
  target?: { phase: Phase; sessionName: string };
  reason?: string;
}

export type LoggerInputEnvelope = LoggerEventEnvelope | LoggerShutdownEnvelope;

export interface LoggerAckEnvelope {
  type: "ack";
  runId: string;
  seq: number;
  phase: Phase;
  sessionName: string;
}

export interface LoggerHandleResult {
  ack: LoggerAckEnvelope | null;
  exit: boolean;
}

export function parseLoggerEnvelope(payload: string): LoggerInputEnvelope {
  const raw = JSON.parse(payload) as unknown;
  return loggerInputEnvelopeSchema.parse(raw) as LoggerInputEnvelope;
}

export function buildLoggerAck(envelope: LoggerEventEnvelope): LoggerAckEnvelope {
  return loggerAckSchema.parse({
    type: "ack",
    runId: envelope.runId,
    seq: envelope.seq,
    phase: envelope.target.phase,
    sessionName: envelope.target.sessionName,
  });
}

export function shouldLoggerExit(envelope: LoggerInputEnvelope): boolean {
  return envelope.type === "shutdown" || envelope.event.type === "phase_end";
}

export function handleLoggerEnvelope(
  writer: LogWriter,
  envelope: LoggerInputEnvelope,
): LoggerHandleResult {
  if (envelope.type === "shutdown") {
    return {
      ack: null,
      exit: true,
    };
  }

  writer.write(envelope.event);

  return {
    ack: buildLoggerAck(envelope),
    exit: shouldLoggerExit(envelope),
  };
}
