import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLoggerIntercomEmitter } from "../adapters/logger-intercom.js";
import { buildLoggerAck, parseLoggerEnvelope } from "../logger-protocol.js";

import type { AgentEvent } from "../events.js";
import type { LoggerEventEnvelope } from "../logger-protocol.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralpix-logger-intercom-"));
  tempDirs.push(dir);
  return dir;
}

function makeEvent(message: string): AgentEvent {
  return {
    type: "milestone",
    phase: "execute",
    createdAt: "2026-06-21T12:00:00.000Z",
    kind: "progress",
    message,
  };
}

describe("logger intercom emitter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a pending record, sends the envelope, and removes the file after ack", () => {
    const cwd = makeTempDir();
    const transport = {
      send: vi.fn((payload: string) => {
        const envelope = parseLoggerEnvelope(payload);
        expect(envelope.type).toBe("event");
        return JSON.stringify(buildLoggerAck(envelope));
      }),
    };

    const emitter = createLoggerIntercomEmitter({
      cwd,
      runId: "run-1",
      target: { phase: "execute", sessionName: "task-run" },
      transport,
    });

    emitter.emit(makeEvent("sent"));

    expect(transport.send).toHaveBeenCalledOnce();
    expect(readdirSync(emitter.pendingDir)).toEqual([]);
  });

  it("preserves the pending record and aborts when transport delivery fails", () => {
    const cwd = makeTempDir();
    const emitter = createLoggerIntercomEmitter({
      cwd,
      runId: "run-2",
      target: { phase: "execute", sessionName: "task-run" },
      transport: {
        send() {
          throw new Error("logger unavailable");
        },
      },
    });

    expect(() => emitter.emit(makeEvent("stuck"))).toThrow("pending record preserved");

    const files = readdirSync(emitter.pendingDir);
    expect(files).toEqual(["00000000.json"]);
    const payload = JSON.parse(readFileSync(join(emitter.pendingDir, files[0] ?? ""), "utf8")) as {
      envelope: LoggerEventEnvelope;
    };
    expect(payload.envelope.seq).toBe(0);
    expect(payload.envelope.event).toMatchObject({ type: "milestone", message: "stuck" });
  });

  it("replays pending records before new events and continues sequence numbers across restarts", () => {
    const cwd = makeTempDir();
    const failingEmitter = createLoggerIntercomEmitter({
      cwd,
      runId: "run-3",
      target: { phase: "execute", sessionName: "task-run" },
      transport: {
        send() {
          throw new Error("logger unavailable");
        },
      },
    });

    expect(() => failingEmitter.emit(makeEvent("first"))).toThrow();

    const deliveredSeqs: number[] = [];
    const deliveredMessages: string[] = [];
    const resumedEmitter = createLoggerIntercomEmitter({
      cwd,
      runId: "run-3",
      target: { phase: "execute", sessionName: "task-run" },
      transport: {
        send(payload) {
          const envelope = parseLoggerEnvelope(payload);
          if (envelope.type !== "event") {
            throw new Error("unexpected envelope");
          }
          deliveredSeqs.push(envelope.seq);
          deliveredMessages.push(envelope.event.type === "milestone" ? envelope.event.message : "unknown");
          return JSON.stringify(buildLoggerAck(envelope));
        },
      },
    });

    resumedEmitter.emit(makeEvent("second"));

    expect(deliveredSeqs).toEqual([0, 1]);
    expect(deliveredMessages).toEqual(["first", "second"]);
    expect(readdirSync(resumedEmitter.pendingDir)).toEqual([]);
  });
});
