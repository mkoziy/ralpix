import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createPiProgressHooks, runPiSubprocessPrompt } from "../pi-subprocess.js";
import { stubRunSession } from "./stubs.js";

import type { SpawnedPiProcess } from "../pi-subprocess.js";

function makeCtx() {
  return {
    cwd: "/tmp/ralpix-test",
    hasUI: false,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
    sessionManager: {
      appendModelChange: vi.fn(),
      appendThinkingLevelChange: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
    },
    newSession: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function createMockProcess(): SpawnedPiProcess & {
  emitClose: (code: number | null, signal?: NodeJS.Signals | null) => void;
  emitError: (error: Error) => void;
  writeStdout: (line: string) => void;
  writeStderr: (line: string) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;

  return {
    stdout,
    stderr,
    on(event, listener) {
      if (event === "close") onClose = listener;
      if (event === "error") onError = listener;
      return this;
    },
    kill: vi.fn().mockReturnValue(true),
    emitClose(code, signal = null) {
      stdout.end();
      stderr.end();
      onClose?.(code, signal);
    },
    emitError(error) {
      onError?.(error);
    },
    writeStdout(line) {
      stdout.write(`${line}\n`);
    },
    writeStderr(line) {
      stderr.write(line);
    },
  };
}

describe("createPiProgressHooks", () => {
  it("forwards milestones and usage checkpoints through the session", () => {
    const session = stubRunSession();
    const ledger = {
      add: vi.fn(),
      totalText: vi.fn().mockReturnValue("in 10 out 5 $0.001"),
    };

    const hooks = createPiProgressHooks(session, ledger);
    hooks.onProgress("progress", "planning");
    hooks.onUsage("openai-codex", "gpt-5.5", {
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.001,
    });

    expect(session.milestone).toHaveBeenCalledWith("progress", "planning");
    expect(ledger.add).toHaveBeenCalledWith("openai-codex", "gpt-5.5", {
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.001,
    });
    expect(session.usageCheckpoint).toHaveBeenCalledWith("in 10 out 5 $0.001");
  });
});

describe("runPiSubprocessPrompt", () => {
  it("extracts usage and forwards progress events", async () => {
    const session = stubRunSession();
    const ledger = {
      add: vi.fn(),
      totalText: vi.fn().mockReturnValue("in 12 out 4 $0.015"),
    };
    const proc = createMockProcess();
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => {
        proc.writeStdout(JSON.stringify({
          type: "progress",
          kind: "subprocess",
          message: "starting",
        }));
        proc.writeStdout(JSON.stringify({
          type: "usage",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: {
            input: 12,
            output: 4,
            cacheRead: 3,
            cacheWrite: 0,
            cost: 0.015,
          },
        }));
        proc.writeStdout(JSON.stringify({
          type: "result",
          success: true,
          message: "done",
        }));
        proc.emitClose(0);
      });
      return proc;
    });

    const result = await runPiSubprocessPrompt(
      makeCtx(),
      { command: "pi", spawnProcess },
      "Do the task",
      {
        model: "gpt-5.5",
        provider: "openai-codex",
        effort: "medium",
        ledger,
      },
      session,
    );

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(session.milestone).toHaveBeenCalledWith("subprocess", "starting");
    expect(ledger.add).toHaveBeenCalledWith("openai-codex", "gpt-5.5", {
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 0,
      cost: 0.015,
    });
    expect(session.usageCheckpoint).toHaveBeenCalledWith("in 12 out 4 $0.015");
    expect(result.status).toBe("success");
    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 0,
      cost: 0.015,
    });
  });

  it("distinguishes a clean agent failure from a subprocess crash", async () => {
    const failureProc = createMockProcess();
    const crashProc = createMockProcess();
    const session = stubRunSession();

    const cleanFailure = runPiSubprocessPrompt(
      makeCtx(),
      {
        spawnProcess: vi.fn().mockImplementation(() => {
          queueMicrotask(() => {
            failureProc.writeStdout(JSON.stringify({
              type: "result",
              success: false,
              error: "validator rejected output",
              usage: {
                input: 2,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.001,
              },
            }));
            failureProc.emitClose(0);
          });
          return failureProc;
        }),
      },
      "Prompt",
      { model: "gpt-5.5", provider: "openai-codex", effort: null },
      session,
    );

    const crash = runPiSubprocessPrompt(
      makeCtx(),
      {
        spawnProcess: vi.fn().mockImplementation(() => {
          queueMicrotask(() => {
            crashProc.writeStderr("segfault");
            crashProc.emitClose(1);
          });
          return crashProc;
        }),
      },
      "Prompt",
      { model: "gpt-5.5", provider: "openai-codex", effort: null },
      session,
    );

    const [failureResult, crashResult] = await Promise.all([cleanFailure, crash]);

    expect(failureResult.status).toBe("failure");
    expect(failureResult.success).toBe(false);
    expect(failureResult.message).toBe("validator rejected output");

    expect(crashResult.status).toBe("crash");
    expect(crashResult.success).toBe(false);
    expect(crashResult.exitCode).toBe(1);
    expect(crashResult.stderr).toContain("segfault");
  });
});
