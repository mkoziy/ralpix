import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LogWriter, createLogWriterEmitter, progressDirForPhase } from "../logger.js";

import type { AgentEvent } from "../events.js";

const PHASE_EVENT: AgentEvent = {
  type: "phase_start",
  phase: "execute",
  createdAt: "2026-01-01T00:00:00.000Z",
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ralpix-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("progressDirForPhase", () => {
  it("returns correct path", () => {
    const dir = progressDirForPhase("/my/project", "execute");
    expect(dir).toBe("/my/project/.ralpix/progress/execute");
  });
});

describe("LogWriter — filePath", () => {
  it("points to correct subdirectory and filename", () => {
    const writer = new LogWriter(tmpDir, "execute", "my-session");
    expect(writer.filePath).toBe(join(tmpDir, ".ralpix", "progress", "execute", "my-session.jsonl"));
  });

  it("uses phase in path", () => {
    const writer = new LogWriter(tmpDir, "brainstorm", "s1");
    expect(writer.filePath).toContain("brainstorm");
    expect(writer.filePath).toContain("s1.jsonl");
  });
});

describe("LogWriter — write()", () => {
  it("creates directory and writes JSONL line", () => {
    const writer = new LogWriter(tmpDir, "execute", "test-session");
    writer.write(PHASE_EVENT);

    expect(existsSync(writer.filePath)).toBe(true);
    const content = readFileSync(writer.filePath, "utf-8");
    const line = JSON.parse(content.trim()) as { type: string; phase: string };
    expect(line.type).toBe("phase_start");
    expect(line.phase).toBe("execute");
  });

  it("appends, does not overwrite on subsequent writes", () => {
    const writer = new LogWriter(tmpDir, "execute", "test-session");
    const event2: AgentEvent = { type: "phase_end", phase: "execute", createdAt: "2026-01-01T00:00:01.000Z" };

    writer.write(PHASE_EVENT);
    writer.write(event2);

    const content = readFileSync(writer.filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as { type: string }).type).toBe("phase_start");
    expect((JSON.parse(lines[1]!) as { type: string }).type).toBe("phase_end");
  });

  it("writes full event JSON per line", () => {
    const writer = new LogWriter(tmpDir, "execute", "test-session");
    const complexEvent: AgentEvent = {
      type: "task_end",
      phase: "execute",
      createdAt: "2026-01-01T00:00:00.000Z",
      taskId: "t1",
      taskNumber: 1,
      taskTitle: "Build it",
      success: true,
      usage: {
        step: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.005 },
        total: { input: 100, output: 50, cost: 0.005 },
      },
    };

    writer.write(complexEvent);

    const parsed = JSON.parse(readFileSync(writer.filePath, "utf-8").trim()) as typeof complexEvent;
    expect(parsed.taskTitle).toBe("Build it");
    expect(parsed.usage.step.input).toBe(100);
  });
});

describe("createLogWriterEmitter", () => {
  it("wraps LogWriter as AgentEventEmitter", () => {
    const writer = new LogWriter(tmpDir, "plan", "emitter-test");
    const emitter = createLogWriterEmitter(writer);

    emitter.emit({ type: "phase_start", phase: "plan", createdAt: "2026-01-01T00:00:00.000Z" });

    expect(existsSync(writer.filePath)).toBe(true);
    const line = JSON.parse(readFileSync(writer.filePath, "utf-8").trim()) as { type: string };
    expect(line.type).toBe("phase_start");
  });
});
