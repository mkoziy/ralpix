import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildModelArg } from "./config.js";

import type { ModelConfig } from "./types.js";

interface JsonEvent {
  type: string;
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

function getPiExecutable(): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
  if (typeof currentScript === "string" && !isBunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  return { command: "pi", args: [] };
}

async function writeTempPrompt(content: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "ralpix-prompt-"));
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

  const { dir, filePath } = await writeTempPrompt(promptContent);
  args.push(`@${filePath}`);

  return await new Promise((resolvePromise) => {
    hooks?.onLifecycle?.("subprocess spawned");
    const proc = spawn(invocation.command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastActivity = Date.now();
    const timeout = setTimeout(() => {
      hooks?.onLifecycle?.(`timeout after ${String(Math.round(timeoutMs / 1000))}s`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - lastActivity) / 1000);
      hooks?.onLifecycle?.(`still running (${String(seconds)}s since last output)`);
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
        hooks?.onLifecycle?.(`subprocess exited with code ${String(code ?? 1)}`);
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
        hooks?.onLifecycle?.(`subprocess error: ${error.message}`);
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
