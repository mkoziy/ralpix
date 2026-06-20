import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunSession } from "./event-bus.js";
import type { ModelConfig, SubprocessUsage } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface UsageLedger {
  add: (provider: string, model: string, usage: SubprocessUsage) => void;
  totalText?: () => string;
}

export interface PiProgressHooks {
  onProgress: (kind: string, message: string) => void;
  onUsage: (provider: string | null, model: string | null, usage: SubprocessUsage) => void;
}

export interface SpawnedPiProcess {
  stdout: {
    on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  } | null;
  stderr: {
    on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  } | null;
  on: {
    (event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedPiProcess;
    (event: "error", listener: (error: Error) => void): SpawnedPiProcess;
  };
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface PiCommand {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  spawnProcess?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      shell: false;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ) => SpawnedPiProcess;
}

export interface RunPiSubprocessConfig extends ModelConfig {
  piAgentDir?: string | null;
  timeoutMs?: number | null;
  env?: NodeJS.ProcessEnv;
  ledger?: UsageLedger | null;
}

export interface SubprocessResult {
  status: "success" | "failure" | "crash";
  success: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  usage: SubprocessUsage;
  message?: string;
}

interface ParsedResultState {
  success: boolean;
  message?: string;
}

const DEFAULT_USAGE: SubprocessUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

export function createPiProgressHooks(
  session: RunSession,
  ledger?: UsageLedger | null,
): PiProgressHooks {
  return {
    onProgress(kind, message) {
      session.milestone(kind, message);
    },
    onUsage(provider, model, usage) {
      if (provider !== null && model !== null) {
        ledger?.add(provider, model, usage);
      }
      const totalText = ledger?.totalText?.();
      if (typeof totalText === "string" && totalText.length > 0) {
        session.usageCheckpoint(totalText);
      }
    },
  };
}

export async function runPiSubprocessPrompt(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  prompt: string,
  config: RunPiSubprocessConfig,
  session: RunSession,
): Promise<SubprocessResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ralpix-pi-"));
  const promptFile = join(tmpDir, "prompt.md");
  await writeFile(promptFile, prompt, "utf8");

  const hooks = createPiProgressHooks(session, config.ledger);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let buffer = "";
  let usage = cloneUsage(DEFAULT_USAGE);
  let parsedResult: ParsedResultState | null = null;

  const args = buildPiArgs(pi.args ?? [], promptFile, config);
  const command = pi.command ?? "pi";
  const env = {
    ...process.env,
    ...pi.env,
    ...config.env,
    ...(typeof config.piAgentDir === "string" ? { PI_CODING_AGENT_DIR: config.piAgentDir } : {}),
  };
  const spawnProcess = pi.spawnProcess ?? defaultSpawnProcess;

  try {
    return await new Promise<SubprocessResult>((resolve) => {
      const child = spawnProcess(command, args, {
        cwd: ctx.cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeoutMs = config.timeoutMs;
      const timeout = typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
          const killed = child.kill("SIGTERM");
          const timeoutLabel = String(timeoutMs);
          stderrChunks.push(`timeout after ${timeoutLabel}ms${killed ? "" : " (kill failed)"}`);
        }, timeoutMs)
        : null;

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        stdoutChunks.push(text);
        buffer = consumeOutputBuffer(buffer + text, hooks, (nextUsage, nextResult) => {
          usage = nextUsage;
          parsedResult = nextResult;
        }, usage, parsedResult);
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(chunk.toString());
      });

      child.on("error", (error: Error) => {
        if (timeout !== null) clearTimeout(timeout);
        resolve({
          status: "crash",
          success: false,
          exitCode: null,
          signal: null,
          stdout: stdoutChunks.join(""),
          stderr: joinStderr(stderrChunks, error.message),
          usage,
          message: error.message,
        });
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timeout !== null) clearTimeout(timeout);
        buffer = consumeOutputBuffer(buffer, hooks, (nextUsage, nextResult) => {
          usage = nextUsage;
          parsedResult = nextResult;
        }, usage, parsedResult, true);
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");
        resolve(finalizeSubprocessResult(code, signal, stdout, stderr, usage, parsedResult));
      });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function buildPiArgs(baseArgs: string[], promptFile: string, config: RunPiSubprocessConfig): string[] {
  const args = [...baseArgs, "--mode", "json", "-p", "--no-session"];
  const model = modelArgument(config);
  if (model !== null) args.push("--model", model);
  if (config.effort !== null) args.push("--thinking", config.effort);
  args.push(`@${promptFile}`);
  return args;
}

function modelArgument(config: RunPiSubprocessConfig): string | null {
  if (config.model === null || config.model.length === 0) return null;
  if (config.model.includes("/")) return config.model;
  if (config.provider !== null && config.provider.length > 0) {
    return `${config.provider}/${config.model}`;
  }
  return config.model;
}

function consumeOutputBuffer(
  input: string,
  hooks: PiProgressHooks,
  assign: (usage: SubprocessUsage, result: ParsedResultState | null) => void,
  currentUsage: SubprocessUsage,
  currentResult: ParsedResultState | null,
  flushRemainder = false,
): string {
  let usage = currentUsage;
  let result = currentResult;
  let buffer = input;

  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const parsed = parseJsonLine(line);
    if (parsed === null) continue;
    const next = applyJsonMessage(parsed, hooks, usage, result);
    usage = next.usage;
    result = next.result;
  }

  if (flushRemainder) {
    const line = buffer.trim();
    if (line.length > 0) {
      const parsed = parseJsonLine(line);
      if (parsed !== null) {
        const next = applyJsonMessage(parsed, hooks, usage, result);
        usage = next.usage;
        result = next.result;
      }
    }
    buffer = "";
  }

  assign(usage, result);
  return buffer;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function applyJsonMessage(
  payload: Record<string, unknown>,
  hooks: PiProgressHooks,
  currentUsage: SubprocessUsage,
  currentResult: ParsedResultState | null,
): { usage: SubprocessUsage; result: ParsedResultState | null } {
  let usage = currentUsage;
  let result = currentResult;

  const progress = extractProgress(payload);
  if (progress !== null) hooks.onProgress(progress.kind, progress.message);

  const nextUsage = extractUsage(payload);
  if (nextUsage !== null) {
    usage = nextUsage;
    const model = extractModel(payload);
    hooks.onUsage(model.provider, model.model, nextUsage);
  }

  const nextResult = extractResultState(payload);
  if (nextResult !== null) result = nextResult;

  return { usage, result };
}

function extractProgress(payload: Record<string, unknown>): { kind: string; message: string } | null {
  const type = readString(payload["type"]) ?? readString(payload["event"]);
  if (type === null) return null;
  if (!["progress", "milestone", "status", "update"].includes(type)) return null;

  const message = readString(payload["message"]) ??
    readString(payload["label"]) ??
    readString(payload["text"]) ??
    readString(payload["detail"]);
  if (message === null) return null;

  return {
    kind: readString(payload["kind"]) ?? type,
    message,
  };
}

function extractUsage(payload: Record<string, unknown>): SubprocessUsage | null {
  const direct = normalizeUsage(payload["usage"]);
  if (direct !== null) return direct;
  const nested = payload["result"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return normalizeUsage((nested as Record<string, unknown>)["usage"]);
  }
  return null;
}

function extractModel(payload: Record<string, unknown>): { provider: string | null; model: string | null } {
  const provider = readString(payload["provider"]);
  const model = readString(payload["model"]);
  if (provider !== null || model !== null) return { provider, model };

  const nested = payload["usage"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    const usage = nested as Record<string, unknown>;
    return {
      provider: readString(usage["provider"]),
      model: readString(usage["model"]),
    };
  }

  return { provider: null, model: null };
}

function extractResultState(payload: Record<string, unknown>): ParsedResultState | null {
  const direct = normalizeResultState(payload);
  if (direct !== null) return direct;

  const nested = payload["result"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return normalizeResultState(nested as Record<string, unknown>);
  }

  return null;
}

function normalizeResultState(payload: Record<string, unknown>): ParsedResultState | null {
  const success = readBoolean(payload["success"]) ?? readBoolean(payload["ok"]);
  if (success === null) return null;
  const message = readString(payload["message"]) ?? readString(payload["error"]);
  const result: ParsedResultState = { success };
  if (message !== null) result.message = message;
  return result;
}

function normalizeUsage(value: unknown): SubprocessUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const input = readNumber(entry["input"]);
  const output = readNumber(entry["output"]);
  const cacheRead = readNumber(entry["cacheRead"]);
  const cacheWrite = readNumber(entry["cacheWrite"]);
  const cost = readNumber(entry["cost"]);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    cost === null
  ) {
    return null;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
  };
}

function finalizeSubprocessResult(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  usage: SubprocessUsage,
  parsedResult: ParsedResultState | null,
): SubprocessResult {
  if (parsedResult?.success === true && code === 0) {
    const result: SubprocessResult = {
      status: "success",
      success: true,
      exitCode: code,
      signal,
      stdout,
      stderr,
      usage,
    };
    if (parsedResult.message !== undefined) result.message = parsedResult.message;
    return result;
  }

  if (parsedResult?.success === false) {
    const result: SubprocessResult = {
      status: "failure",
      success: false,
      exitCode: code,
      signal,
      stdout,
      stderr,
      usage,
    };
    if (parsedResult.message !== undefined) result.message = parsedResult.message;
    return result;
  }

  if (code === 0) {
    return {
      status: "success",
      success: true,
      exitCode: code,
      signal,
      stdout,
      stderr,
      usage,
    };
  }

  const result: SubprocessResult = {
    status: "crash",
    success: false,
    exitCode: code,
    signal,
    stdout,
    stderr,
    usage,
  };
  if (stderr.length > 0) result.message = stderr.trim();
  return result;
}

function cloneUsage(usage: SubprocessUsage): SubprocessUsage {
  return { ...usage };
}

function joinStderr(parts: string[], suffix: string): string {
  return parts.length === 0 ? suffix : `${parts.join("")}\n${suffix}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  },
): SpawnedPiProcess {
  return spawn(command, args, options);
}
