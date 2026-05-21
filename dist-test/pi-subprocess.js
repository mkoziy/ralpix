import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModelArg } from "./config.js";
const DEFAULT_FZF_COMMAND = "rg --files --hidden --follow --glob '!.git'";
function compactWhitespace(text) {
    return text.replaceAll(/\s+/g, " ").trim();
}
function truncateForLog(text, limit = 120) {
    if (text.length <= limit)
        return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}
function stringifyArgValue(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    return null;
}
function summarizeObjectArgs(args) {
    const preview = Object.entries(args)
        .flatMap(([key, value]) => {
        const stringValue = stringifyArgValue(value);
        if (stringValue == null || stringValue.trim().length === 0)
            return [];
        return [`${key}=${stringValue}`];
    })
        .slice(0, 3);
    return compactWhitespace(preview.join(" "));
}
export function summarizePiToolCall(toolName, args) {
    if (args !== null && typeof args === "object") {
        const record = args;
        const command = record["cmd"] ?? record["command"];
        if (typeof command === "string" && command.trim().length > 0) {
            return compactWhitespace(`${toolName} ${truncateForLog(command.trim(), 100)}`);
        }
        const query = record["q"];
        if (typeof query === "string" && query.trim().length > 0) {
            return compactWhitespace(`${toolName} ${truncateForLog(query.trim(), 100)}`);
        }
        const preview = summarizeObjectArgs(record);
        if (preview.length > 0)
            return `${toolName} ${truncateForLog(preview, 100)}`;
    }
    return toolName;
}
function stripRalpixCompletionBlocks(text) {
    return text
        .replaceAll(/<ralpix_task_result>[\S\s]*?<\/ralpix_task_result>/gi, "")
        .replaceAll(/<ralpix_review_result>[\S\s]*?<\/ralpix_review_result>/gi, "")
        .trim();
}
export function summarizeAssistantProgress(text) {
    const stripped = stripRalpixCompletionBlocks(text);
    if (stripped.length === 0)
        return null;
    const firstLine = stripped
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    if (firstLine == null)
        return null;
    return truncateForLog(compactWhitespace(firstLine));
}
export function createPiProgressHooks(onProgress, onUsage) {
    const activeTools = new Map();
    const logToolStart = (event) => {
        if (event.toolCallId == null || event.toolName == null)
            return;
        const label = summarizePiToolCall(event.toolName, event.args);
        activeTools.set(event.toolCallId, { label, startedAt: Date.now() });
        onProgress?.(`tool started: ${label}`);
    };
    const logToolEnd = (event) => {
        if (event.toolCallId == null)
            return;
        const active = activeTools.get(event.toolCallId);
        activeTools.delete(event.toolCallId);
        const label = active?.label ?? summarizePiToolCall(event.toolName ?? "tool", event.args);
        const durationSeconds = active == null ? null : Math.max(1, Math.round((Date.now() - active.startedAt) / 1000));
        const durationLabel = durationSeconds == null ? "" : ` in ${String(durationSeconds)}s`;
        onProgress?.(`${event.isError === true ? "tool failed" : "tool finished"}${durationLabel}: ${label}`);
    };
    const logAssistantSummary = (event) => {
        if (event.message?.role !== "assistant")
            return;
        const summary = summarizeAssistantProgress(parseAssistantTextParts(event.message.content).join("\n"));
        if (summary !== null)
            onProgress?.(`assistant: ${summary}`);
    };
    const logQueueUpdate = (event) => {
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
        ...(onUsage === undefined ? {} : { onUsage }),
        onEvent(event) {
            if (onProgress == null)
                return;
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
function getPiExecutable() {
    const currentScript = process.argv[1];
    const isBunVirtual = typeof currentScript === "string" && currentScript.startsWith("/$bunfs/root/");
    if (typeof currentScript === "string" && !isBunVirtual && existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript] };
    }
    return { command: "pi", args: [] };
}
async function writeTempPrompt(content) {
    const dir = await fs.mkdtemp(join(tmpdir(), "ralpix-prompt-"));
    const filePath = join(dir, "prompt.md");
    await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
    return { dir, filePath };
}
async function cleanupTempDir(dir) {
    await fs.rm(dir, { recursive: true, force: true });
}
function parseAssistantTextParts(content) {
    if (content === undefined)
        return [];
    const parts = [];
    for (const part of content) {
        if (part.type === "text")
            parts.push(part.text);
    }
    return parts;
}
function parseJsonEvent(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
function extractLastAssistantText(lines) {
    let parts = [];
    for (const line of lines) {
        const event = parseJsonEvent(line);
        if (event?.type === "message_end" && event.message?.role === "assistant") {
            parts = parseAssistantTextParts(event.message.content);
        }
    }
    return parts.join("\n").trim();
}
function buildPiSubprocessEnv(piAgentDir) {
    const env = { ...process.env };
    if (piAgentDir != null) {
        env["PI_CODING_AGENT_DIR"] = piAgentDir;
    }
    env["FZF_DEFAULT_COMMAND"] ??= DEFAULT_FZF_COMMAND;
    env["FZF_CTRL_T_COMMAND"] ??= DEFAULT_FZF_COMMAND;
    return env;
}
export async function runPiSubprocessPrompt(cwd, promptContent, modelCfg, includeEffort = true, timeoutMs = 30 * 60 * 1000, hooks, piAgentDir) {
    const invocation = getPiExecutable();
    const args = [...invocation.args, "--mode", "json", "-p", "--no-session"];
    const modelArg = buildModelArg(modelCfg);
    if (modelArg !== null) {
        args.push("--model", modelArg);
    }
    else if (modelCfg.provider !== null && modelCfg.provider.length > 0) {
        args.push("--provider", modelCfg.provider);
    }
    if (includeEffort && modelCfg.effort !== null) {
        args.push("--thinking", modelCfg.effort);
    }
    const { dir, filePath } = await writeTempPrompt(promptContent);
    args.push(`@${filePath}`);
    return await new Promise((resolvePromise) => {
        hooks?.onLifecycle?.("pi subprocess started");
        const proc = spawn(invocation.command, args, {
            cwd,
            env: buildPiSubprocessEnv(piAgentDir),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let lastActivity = Date.now();
        const timeout = setTimeout(() => {
            hooks?.onLifecycle?.(`timeout after ${String(Math.round(timeoutMs / 1000))}s; terminating subprocess`);
            proc.kill("SIGTERM");
            setTimeout(() => {
                if (!proc.killed)
                    proc.kill("SIGKILL");
            }, 5000);
        }, timeoutMs);
        const heartbeat = setInterval(() => {
            const seconds = Math.round((Date.now() - lastActivity) / 1000);
            if (seconds < 15)
                return;
            hooks?.onLifecycle?.(`idle for ${String(seconds)}s waiting for subprocess output`);
        }, 30000);
        let stdout = "";
        let stderr = "";
        let stdoutBuffer = "";
        proc.stdout.on("data", (data) => {
            const chunk = data.toString();
            stdout += chunk;
            stdoutBuffer += chunk;
            lastActivity = Date.now();
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) {
                const event = parseJsonEvent(line);
                if (event === null)
                    continue;
                hooks?.onEvent?.(event);
                if (event.type === "message_end" &&
                    event.message?.role === "assistant" &&
                    event.message.usage != null &&
                    (event.message.usage.input ?? 0) + (event.message.usage.output ?? 0) > 0 &&
                    hooks?.onUsage != null) {
                    const { provider = "unknown", model = "unknown", usage } = event.message;
                    hooks.onUsage(provider, model, {
                        input: usage.input ?? 0,
                        output: usage.output ?? 0,
                        cacheRead: usage.cacheRead ?? 0,
                        cacheWrite: usage.cacheWrite ?? 0,
                        cost: usage.cost?.total ?? 0,
                    });
                }
            }
        });
        proc.stderr.on("data", (data) => {
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
//# sourceMappingURL=pi-subprocess.js.map