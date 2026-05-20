import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { buildModelArg } from "./config.js";
import { sandboxPiInvocation, workspaceTempDir } from "./workspace.js";

import type { ModelConfig } from "./types.js";

interface JsonEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  steering?: readonly string[];
  followUp?: readonly string[];
  message?: {
    role: string;
    content?: Array<{ type: string; text: string }>;
  };
}

interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiSubprocessResult {
  exitCode: number;
  output: string;
  error: string;
  lastAssistantText: string;
}

export interface PiSubprocessHooks {
  onEvent?: (event: JsonEvent) => void;
  onLifecycle?: (message: string) => void;
}

function compactWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function truncateForLog(text: string, limit = 120): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function stringifyArgValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function summarizeObjectArgs(args: Record<string, unknown>): string {
  const preview = Object.entries(args)
    .flatMap(([key, value]) => {
      const stringValue = stringifyArgValue(value);
      if (stringValue == null || stringValue.trim().length === 0) return [];
      return [`${key}=${stringValue}`];
    })
    .slice(0, 3);

  return compactWhitespace(preview.join(" "));
}

export function summarizePiToolCall(toolName: string, args: unknown): string {
  if (args !== null && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const command = record["cmd"] ?? record["command"];
    if (typeof command === "string" && command.trim().length > 0) {
      return compactWhitespace(`${toolName} ${truncateForLog(command.trim(), 100)}`);
    }

    const query = record["q"];
    if (typeof query === "string" && query.trim().length > 0) {
      return compactWhitespace(`${toolName} ${truncateForLog(query.trim(), 100)}`);
    }

    const preview = summarizeObjectArgs(record);
    if (preview.length > 0) return `${toolName} ${truncateForLog(preview, 100)}`;
  }

  return toolName;
}

function stripRalpixCompletionBlocks(text: string): string {
  return text
    .replaceAll(/<ralpix_task_result>[\S\s]*?<\/ralpix_task_result>/gi, "")
    .replaceAll(/<ralpix_review_result>[\S\s]*?<\/ralpix_review_result>/gi, "")
    .trim();
}

export function summarizeAssistantProgress(text: string): string | null {
  const stripped = stripRalpixCompletionBlocks(text);
  if (stripped.length === 0) return null;

  const firstLine = stripped
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstLine == null) return null;
  return truncateForLog(compactWhitespace(firstLine));
}

export function createPiProgressHooks(onProgress?: (detail: string) => void): PiSubprocessHooks {
  const activeTools = new Map<string, { label: string; startedAt: number }>();

  const logToolStart = (event: JsonEvent): void => {
    if (event.toolCallId == null || event.toolName == null) return;
    const label = summarizePiToolCall(event.toolName, event.args);
    activeTools.set(event.toolCallId, { label, startedAt: Date.now() });
    onProgress?.(`tool started: ${label}`);
  };

  const logToolEnd = (event: JsonEvent): void => {
    if (event.toolCallId == null) return;
    const active = activeTools.get(event.toolCallId);
    activeTools.delete(event.toolCallId);
    const label = active?.label ?? summarizePiToolCall(event.toolName ?? "tool", event.args);
    const durationSeconds = active == null ? null : Math.max(1, Math.round((Date.now() - active.startedAt) / 1000));
    const durationLabel = durationSeconds == null ? "" : ` in ${String(durationSeconds)}s`;
    onProgress?.(`${event.isError === true ? "tool failed" : "tool finished"}${durationLabel}: ${label}`);
  };

  const logAssistantSummary = (event: JsonEvent): void => {
    if (event.message?.role !== "assistant") return;
    const summary = summarizeAssistantProgress(parseAssistantTextParts(event.message.content).join("\n"));
    if (summary !== null) onProgress?.(`assistant: ${summary}`);
  };

  const logQueueUpdate = (event: JsonEvent): void => {
    const steering = event.steering?.length ?? 0;
    const followUp = event.followUp?.length ?? 0;
    if (steering > 0 || followUp > 0) {
      onProgress?.(`queue updated: steering ${String(steering)}, follow-up ${String(followUp)}`);
    }
  };

  return {
    onLifecycle(message) {
      onProgress?.(message);
    },
    onEvent(event) {
      if (onProgress == null) return;

      if (event.type === "tool_execution_start") {
        logToolStart(event);
        return;
      }
      if (event.type === "tool_execution_end") {
        logToolEnd(event);
        return;
      }
      if (event.type === "message_end") {
        logAssistantSummary(event);
        return;
      }
      if (event.type === "queue_update") {
        logQueueUpdate(event);
      }
    },
  };
}

function getPiExecutable(): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (typeof currentScript === "string" && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

async function writeTempPrompt(cwd: string, content: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(join(workspaceTempDir(cwd), "prompt-"));
  const filePath = join(dir, "prompt.md");
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function parseAssistantTextParts(content: Array<{ type: string; text: string }> | undefined): string[] {
  if (content === undefined) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") parts.push(part.text);
  }
  return parts;
}

function parseJsonEvent(line: string): JsonEvent | null {
  try {
    return JSON.parse(line) as JsonEvent;
  } catch {
    return null;
  }
}

function extractLastAssistantText(lines: string[]): string {
  let parts: string[] = [];
  for (const line of lines) {
    const event = parseJsonEvent(line);
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      parts = parseAssistantTextParts(event.message.content);
    }
  }
  return parts.join("\n").trim();
}

export async function runPiSubprocessPrompt(
  cwd: string,
  promptContent: string,
  modelCfg: ModelConfig,
  includeEffort = true,
  timeoutMs = 30 * 60 * 1000,
  hooks?: PiSubprocessHooks,
): Promise<PiSubprocessResult> {
  const invocation = getPiExecutable();
  const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];
  const modelArg = buildModelArg(modelCfg);

  if (modelArg !== null) {
    args.push("--model", modelArg);
  } else if (modelCfg.provider !== null && modelCfg.provider.length > 0) {
    args.push("--provider", modelCfg.provider);
  }

  if (includeEffort && modelCfg.effort !== null) {
    args.push("--thinking", modelCfg.effort);
  }

  const { dir, filePath } = await writeTempPrompt(cwd, promptContent);
  args.push(`@${filePath}`);
  const sandboxed = sandboxPiInvocation(cwd, {
    command: invocation.command,
    args,
  });

  return await new Promise((resolvePromise) => {
    hooks?.onLifecycle?.("pi subprocess started");
    const proc = spawn(sandboxed.command, sandboxed.args, {
      cwd,
      env: sandboxed.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastActivity = Date.now();
    const timeout = setTimeout(() => {
      hooks?.onLifecycle?.(`timeout after ${String(Math.round(timeoutMs / 1000))}s; terminating subprocess`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - lastActivity) / 1000);
      if (seconds < 15) return;
      hooks?.onLifecycle?.(`idle for ${String(seconds)}s waiting for subprocess output`);
    }, 30000);

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      stdoutBuffer += chunk;
      lastActivity = Date.now();

      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseJsonEvent(line);
        if (event !== null) hooks?.onEvent?.(event);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      lastActivity = Date.now();
    });

    proc.on("close", (code) => {
      void cleanupTempDir(dir).finally(() => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        hooks?.onLifecycle?.(`pi subprocess exited with code ${String(code ?? 1)}`);
        resolvePromise({
          exitCode: code ?? 1,
          output: stdout,
          error: stderr,
          lastAssistantText: extractLastAssistantText(stdout.split("\n")),
        });
      });
    });

    proc.on("error", (error) => {
      void cleanupTempDir(dir).finally(() => {
        clearTimeout(timeout);
        clearInterval(heartbeat);
        hooks?.onLifecycle?.(`pi subprocess error: ${error.message}`);
        resolvePromise({
          exitCode: 1,
          output: stdout,
          error: error.message,
          lastAssistantText: extractLastAssistantText(stdout.split("\n")),
        });
      });
    });
  });
}
