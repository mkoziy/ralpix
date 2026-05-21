/**
 * Task execution engine — runs each task in an isolated pi session.
 */
import { execSync } from "node:child_process";
import { buildModelArg, resolveModel, resolvePiAgentDir } from "./config.js";
import { updatePlanTaskStatus } from "./parser.js";
import { createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { loadPrompt, expandPrompt } from "./prompt.js";
export function buildTaskPrompt(promptContent) {
    return [
        promptContent,
        "",
        "## Completion Contract",
        "End your final response with this exact block and nothing after it:",
        "<RALPIX_TASK_RESULT>",
        "Success: true|false",
        "Summary: <one-line concise summary>",
        "</RALPIX_TASK_RESULT>",
        "Use `Success: true` only when the task is complete.",
        "Use `Success: false` with the blocker or failure reason when you cannot complete the task.",
        "Do not end your response without this block.",
    ].join("\n");
}
export function parseTaskSessionReport(text) {
    const match = (/<ralpix_task_result>\s*([\S\s]*?)\s*<\/ralpix_task_result>/i).exec(text);
    if (match?.[1] == null)
        return null;
    const body = match[1];
    const successMatch = (/^\s*success:\s*(true|false)\s*$/im).exec(body);
    const summaryMatch = (/^\s*summary:\s*(.+)$/im).exec(body);
    const successRaw = successMatch?.[1]?.toLowerCase();
    const summary = summaryMatch?.[1]?.trim();
    if (successRaw == null || summary == null || summary.length === 0)
        return null;
    return {
        success: successRaw === "true",
        summary,
    };
}
async function runTaskSession(ctx, promptContent, modelCfg, piAgentDir, onProgress, onUsage) {
    const result = await runPiSubprocessPrompt(ctx.cwd, buildTaskPrompt(promptContent), modelCfg, true, 30 * 60 * 1000, createPiProgressHooks(onProgress, onUsage), piAgentDir);
    const report = parseTaskSessionReport(result.lastAssistantText);
    if (report !== null)
        return report;
    const stderr = result.error.trim();
    const assistantText = result.lastAssistantText.trim();
    let detail = `pi exited with code ${String(result.exitCode)}`;
    if (assistantText.length > 0)
        detail = assistantText;
    if (stderr.length > 0)
        detail = stderr;
    return {
        success: false,
        summary: `Task session did not report a structured result. ${detail}`.slice(0, 500),
    };
}
function tryCommit(cwd, message, enabled) {
    if (!enabled)
        return null;
    try {
        const status = execSync("git status --porcelain", { cwd, encoding: "utf-8" });
        if (status.trim().length === 0)
            return null;
        const escapedMessage = message.replaceAll('"', String.raw `\"`);
        execSync(`git add -A && git commit -m "${escapedMessage}"`, {
            cwd,
            encoding: "utf-8",
            stdio: "pipe",
        });
        return execSync("git rev-parse --short HEAD", { cwd, encoding: "utf-8" }).trim();
    }
    catch {
        return null;
    }
}
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function executeTask(ctx, _pi, task, config, plan, logger, hooks) {
    hooks?.onTaskStart?.(task);
    logger.logTaskStart(task);
    const template = loadPrompt("task-default", ctx.cwd);
    const prompt = expandPrompt(template, {
        OVERVIEW: plan.overview.length > 0 ? plan.overview : plan.title,
        TASK_TITLE: task.title,
        TASK_DESCRIPTION: task.description.length > 0
            ? task.description
            : task.items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n"),
    });
    updatePlanTaskStatus(plan.path, task.id, task.title, "in-progress");
    const modelCfg = resolveModel(config, "task");
    const piAgentDir = resolvePiAgentDir(ctx.cwd, config);
    let lastError;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
        try {
            const modelLabel = buildModelArg(modelCfg) ?? modelCfg.provider ?? "session default";
            logger.logTaskInfo(task, `attempt ${attempt} launched (${modelLabel})`);
            ctx.ui.notify(`ralpix: ${task.title} — attempt ${attempt} started`, "info");
            const result = await runTaskSession(ctx, prompt, modelCfg, piAgentDir, (detail) => {
                logger.logTaskInfo(task, `attempt ${attempt}: ${detail}`);
            }, hooks?.onUsage);
            if (result.success) {
                const commitMsg = config.commitMessageTemplate
                    .replaceAll("{{taskTitle}}", task.title)
                    .replaceAll("{{taskNumber}}", String(task.number));
                const hash = tryCommit(ctx.cwd, commitMsg, config.commitEnabled);
                logger.logTaskEnd(task, true, hash === null ? "no commit" : `commit ${hash}`);
                updatePlanTaskStatus(plan.path, task.id, task.title, "completed");
                const taskResult = {
                    success: true,
                    summary: result.summary.slice(0, 200).length > 0
                        ? result.summary.slice(0, 200)
                        : `Task ${task.number} completed`,
                };
                hooks?.onTaskFinish?.(task, taskResult);
                return taskResult;
            }
            lastError = result.summary;
            if (attempt <= config.maxRetries) {
                logger.logTaskEnd(task, false, `attempt ${attempt} failed, retrying (${lastError})`);
            }
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (attempt <= config.maxRetries) {
                logger.logTaskEnd(task, false, `attempt ${attempt} failed, retrying`);
            }
        }
    }
    const finalError = lastError ?? "Unknown error";
    logger.logTaskEnd(task, false, finalError);
    updatePlanTaskStatus(plan.path, task.id, task.title, "failed");
    const taskResult = { success: false, error: finalError };
    hooks?.onTaskFinish?.(task, taskResult);
    return taskResult;
}
export async function executeAllTasks(ctx, pi, plan, config, logger, hooks) {
    const results = [];
    for (const task of plan.tasks) {
        if (task.status === "completed") {
            results.push({ success: true, summary: "Already completed" });
            continue;
        }
        if (task.status === "failed") {
            results.push({ success: false, error: "Previously failed" });
            continue;
        }
        const result = await executeTask(ctx, pi, task, config, plan, logger, hooks);
        results.push(result);
        if (!result.success)
            break;
    }
    return results;
}
//# sourceMappingURL=executor.js.map