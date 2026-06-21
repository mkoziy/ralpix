import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildLoggerAck,
  handleLoggerEnvelope,
  parseLoggerEnvelope,
  shouldLoggerExit,
} from "../logger-protocol.js";
import { LogWriter } from "../logger.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralpix-logger-protocol-"));
  tempDirs.push(dir);
  return dir;
}

function makeEventEnvelope() {
  return {
    type: "event" as const,
    runId: "run-123",
    seq: 7,
    target: {
      phase: "execute" as const,
      sessionName: "task-run",
    },
    event: {
      type: "task_start" as const,
      phase: "execute" as const,
      createdAt: "2026-06-21T12:00:00.000Z",
      taskId: "task-1",
      taskNumber: 1,
      taskTitle: "Start logger session",
      itemCount: 2,
    },
  };
}

describe("logger-protocol", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses valid event envelopes and rejects mismatched target phases", () => {
    const envelope = parseLoggerEnvelope(JSON.stringify(makeEventEnvelope()));
    expect(envelope).toMatchObject({
      type: "event",
      runId: "run-123",
      seq: 7,
    });

    const invalidEnvelope = {
      ...makeEventEnvelope(),
      target: {
        phase: "review",
        sessionName: "task-run",
      },
    };

    expect(() => parseLoggerEnvelope(JSON.stringify(invalidEnvelope))).toThrow("target phase must match event phase");
  });

  it("writes event envelopes through LogWriter and returns an ack", () => {
    const cwd = makeTempDir();
    const writer = new LogWriter(cwd, "execute", "task-run");
    const envelope = makeEventEnvelope();

    const result = handleLoggerEnvelope(writer, envelope);

    expect(result.exit).toBe(false);
    expect(result.ack).toEqual(buildLoggerAck(envelope));
    const lines = readFileSync(writer.filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      type: "task_start",
      phase: "execute",
      taskId: "task-1",
    });
  });

  it("exits on phase_end events and explicit shutdown envelopes", () => {
    const cwd = makeTempDir();
    const writer = new LogWriter(cwd, "review", "review-run");
    const phaseEndEnvelope = {
      type: "event" as const,
      runId: "run-456",
      seq: 9,
      target: {
        phase: "review" as const,
        sessionName: "review-run",
      },
      event: {
        type: "phase_end" as const,
        phase: "review" as const,
        createdAt: "2026-06-21T12:05:00.000Z",
        label: "complete",
      },
    };

    expect(shouldLoggerExit(phaseEndEnvelope)).toBe(true);
    const phaseEndResult = handleLoggerEnvelope(writer, phaseEndEnvelope);
    expect(phaseEndResult.exit).toBe(true);
    expect(phaseEndResult.ack).toEqual({
      type: "ack",
      runId: "run-456",
      seq: 9,
      phase: "review",
      sessionName: "review-run",
    });

    const shutdownResult = handleLoggerEnvelope(writer, {
      type: "shutdown",
      runId: "run-456",
      reason: "stop",
    });
    expect(shutdownResult).toEqual({
      ack: null,
      exit: true,
    });
  });
});
