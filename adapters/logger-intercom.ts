import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loggerAckSchema } from "../logger-protocol.js";

import type { AgentEventEmitter } from "../events.js";
import type { LoggerAckEnvelope, LoggerEventEnvelope } from "../logger-protocol.js";
import type { Phase } from "../types.js";

export interface LoggerIntercomTransport {
  send: (payload: string) => string;
}

export interface LoggerIntercomTarget {
  phase: Phase;
  sessionName: string;
}

export interface CreateLoggerIntercomEmitterOptions {
  cwd: string;
  runId: string;
  target: LoggerIntercomTarget;
  transport: LoggerIntercomTransport;
}

interface PendingEnvelopeRecord {
  envelope: LoggerEventEnvelope;
}

export interface LoggerIntercomEmitter extends AgentEventEmitter {
  flushPending: () => void;
  readonly pendingDir: string;
}

export function pendingDirForLoggerRun(
  cwd: string,
  runId: string,
  target: LoggerIntercomTarget,
): string {
  return resolve(
    cwd,
    ".ralpix",
    "progress",
    "pending",
    sanitizePathSegment(runId),
    target.phase,
    sanitizePathSegment(target.sessionName),
  );
}

export function createLoggerIntercomEmitter(
  options: CreateLoggerIntercomEmitterOptions,
): LoggerIntercomEmitter {
  const pendingDir = pendingDirForLoggerRun(options.cwd, options.runId, options.target);
  let nextSeq = findNextSequence(pendingDir);

  function flushPending(): void {
    for (const record of loadPendingRecords(pendingDir)) {
      deliverPendingRecord(record.filePath, record.envelope, options.transport);
    }
  }

  return {
    pendingDir,

    emit(event) {
      flushPending();

      const envelope: LoggerEventEnvelope = {
        type: "event",
        runId: options.runId,
        seq: nextSeq,
        target: {
          phase: options.target.phase,
          sessionName: options.target.sessionName,
        },
        event,
      };
      nextSeq += 1;

      const filePath = writePendingRecord(pendingDir, envelope);
      deliverPendingRecord(filePath, envelope, options.transport);
    },

    flushPending,
  };
}

function deliverPendingRecord(
  filePath: string,
  envelope: LoggerEventEnvelope,
  transport: LoggerIntercomTransport,
): void {
  try {
    const rawAck = transport.send(JSON.stringify(envelope));
    const ack = parseLoggerAck(rawAck);
    assertMatchingAck(ack, envelope);
    rmSync(filePath, { force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[logger-intercom] failed to deliver seq ${envelope.seq}; pending record preserved at ${filePath}: ${message}`,
    );
  }
}

function writePendingRecord(pendingDir: string, envelope: LoggerEventEnvelope): string {
  mkdirSync(pendingDir, { recursive: true });
  const filePath = join(pendingDir, `${String(envelope.seq).padStart(8, "0")}.json`);
  const record: PendingEnvelopeRecord = { envelope };
  writeFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return filePath;
}

function loadPendingRecords(pendingDir: string): Array<{ filePath: string; envelope: LoggerEventEnvelope }> {
  if (!existsSync(pendingDir)) {
    return [];
  }

  return readdirSync(pendingDir)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => {
      const filePath = join(pendingDir, entry);
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as PendingEnvelopeRecord;
      return {
        filePath,
        envelope: parsed.envelope,
      };
    });
}

function findNextSequence(pendingDir: string): number {
  const pendingRecords = loadPendingRecords(pendingDir);
  if (pendingRecords.length === 0) {
    return 0;
  }

  const highestSeq = pendingRecords.reduce((current, record) => Math.max(current, record.envelope.seq), -1);
  return highestSeq + 1;
}

function parseLoggerAck(payload: string): LoggerAckEnvelope {
  const raw = JSON.parse(payload) as unknown;
  return loggerAckSchema.parse(raw);
}

function assertMatchingAck(ack: LoggerAckEnvelope, envelope: LoggerEventEnvelope): void {
  if (
    ack.runId !== envelope.runId ||
    ack.seq !== envelope.seq ||
    ack.phase !== envelope.target.phase ||
    ack.sessionName !== envelope.target.sessionName
  ) {
    throw new Error(
      `ack mismatch for seq ${envelope.seq}: expected ${envelope.runId}/${envelope.target.phase}/${envelope.target.sessionName}`,
    );
  }
}

function sanitizePathSegment(value: string): string {
  return value.replaceAll(/[/\\]/g, "_");
}
