/**
 * ralpix — Autonomous Plan Execution Extension for pi
 *
 * Reads ralpix-format markdown plans and executes tasks hands-off.
 * Each task runs in an isolated pi process (spawn) to keep context sharp.
 *
 * Commands:
 *   /ralpix plan <desc>  — Create a plan interactively
 *   /ralpix init          — Initialise ~/.ralpix/ with defaults
 *   /ralpix <path>        — Execute a plan
 *
 * Tools (for LLM):
 *   ralpix_mark_task_done — Mark current task as complete
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join as pathJoin, parse as pathParse } from "node:path";
import { Type } from "typebox";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { initRalpixHome, loadConfig, ralpixHomeDir } from "./config.js";
import { parsePlan } from "./parser.js";
import { ProgressLogger } from "./logger.js";
import { executeAllTasks } from "./executor.js";
import { runReviewPipeline } from "./reviewer.js";
import { runPlanCreation } from "./planner.js";
import type { RalpixState } from "./types.js";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

const STATE_TYPE = "ralpix-state";

function persistState(pi: ExtensionAPI, state: RalpixState): void {
  pi.appendEntry(STATE_TYPE, state);
}

function restoreState(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): RalpixState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "custom" && e.customType === STATE_TYPE) {
      return e.data as RalpixState;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function ralpixExtension(pi: ExtensionAPI): void {
  // ---- /ralpix command ----------------------------------------------------

  pi.registerCommand("ralpix", {
    description: "Execute a ralpix plan (/ralpix <path>, /ralpix init, /ralpix plan <desc>)",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();

      // ── Existing path? Execute it directly (handles files named
      //     "plan something.md" or any path starting with "plan ").
      if (trimmed && existsSync(resolve(ctx.cwd, trimmed))) {
        await runPlan(trimmed, ctx, pi);
        return;
      }

      // ── /ralpix plan <description> ─────────────────────────────
      if (trimmed.startsWith("plan ") || trimmed === "plan") {
        const description = trimmed.slice(5).trim();
        if (!description) {
          ctx.ui.notify("Usage: /ralpix plan <description>", "error");
          return;
        }

        // Auto-init if needed
        if (!existsSync(ralpixHomeDir())) {
          ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
          initRalpixHome();
        }

        const config = loadConfig(ctx.cwd);
        const planPath = await runPlanCreation(description, ctx, pi, config);
        if (planPath) {
          // User chose to execute
          await runPlan(planPath, ctx, pi);
        }
        return;
      }

      // ── /ralpix init ───────────────────────────────────────────
      if (!trimmed || trimmed === "init") {
        const ok = await ctx.ui.confirm(
          "Initialize ralpix?",
          "Create ~/.ralpix/ with default prompts, agents, and config?",
        );
        if (!ok) return;
        initRalpixHome();
        ctx.ui.notify(
          "ralpix initialized — ~/.ralpix/ created with defaults",
          "success",
        );
        return;
      }

      // Execute a plan
      await runPlan(trimmed, ctx, pi);
    },
  });

  // ---- tool: ralpix_mark_task_done ----------------------------------------

  pi.registerTool({
    name: "ralpix_mark_task_done",
    label: "Mark Task Done",
    description: "Mark the current plan task as complete during execution",
    promptSnippet: "Mark a ralpix plan task as done",
    parameters: Type.Object({
      taskId: Type.Optional(
        Type.String({ description: "Task ID to mark done (uses current if omitted)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          {
            type: "text",
            text: `Task ${params.taskId ?? "current"} marked as done.`,
          },
        ],
        details: {},
      };
    },
  });

  // ---- session_start — restore state and notify on interrupted runs ---------

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }>;
    const state = restoreState(entries);

    if (state && state.phase !== "complete" && state.phase !== "idle") {
      // Notify about interrupted run, suggest resume
      const resumeCmd = state.planPath
        ? `/ralpix ${state.planPath.replace(process.env.HOME ?? "", "~")}`
        : "/ralpix";
      ctx.ui.notify(
        `ralpix: previous run of "${state.planTitle}" was interrupted (phase: ${state.phase}).\nResume with: ${resumeCmd}`,
        "warning",
      );

      // Update widget to show last known state
      if (ctx.hasUI) {
        updateStatusWidget(state, ctx);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Plan execution orchestrator
// ---------------------------------------------------------------------------

async function runPlan(
  rawPath: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  // Resolve path
  const planPath = resolve(ctx.cwd, rawPath);

  // Validate
  if (!existsSync(planPath)) {
    ctx.ui.notify(`Plan file not found: ${planPath}`, "error");
    return;
  }

  // Auto-init if ~/.ralpix/ doesn't exist
  if (!existsSync(ralpixHomeDir())) {
    ctx.ui.notify("First run — initialising ~/.ralpix/...", "info");
    initRalpixHome();
  }

  // Load config and parse plan
  const config = loadConfig(ctx.cwd);
  const plan = parsePlan(planPath);

  ctx.ui.notify(
    `ralpix: "${plan.title}" — ${plan.tasks.length} tasks, ${plan.tasks.filter((t) => t.status === "pending").length} pending`,
    "info",
  );

  // Setup progress logger
  const planStem = planPath.split("/").pop()?.replace(/\.md$/, "") ?? "plan";
  const logger = new ProgressLogger(planStem);
  logger.logStart(plan);

  // Initial state
  const state: RalpixState = {
    planPath,
    planTitle: plan.title,
    currentTaskId: null,
    phase: "executing",
    completedTasks: plan.tasks.filter((t) => t.status === "completed").map((t) => t.id),
    failedTasks: plan.tasks.filter((t) => t.status === "failed").map((t) => t.id),
    progressFile: logger.filePath,
  };
  persistState(pi, state);
  updateStatusWidget(state, ctx);

  // ---- Execute tasks ------------------------------------------------------
  const pendingCount = plan.tasks.filter((t) => t.status === "pending").length;
  if (pendingCount > 0) {
    ctx.ui.notify(`Executing ${pendingCount} pending tasks...`, "info");

    const results = await executeAllTasks(
      ctx,
      pi,
      plan,
      config,
      logger,
    );

    // Update state
    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      const result = results[i];
      if (result?.success) {
        if (!state.completedTasks.includes(task.id)) {
          state.completedTasks.push(task.id);
        }
      } else if (result && !result.success) {
        if (!state.failedTasks.includes(task.id)) {
          state.failedTasks.push(task.id);
        }
      }
    }

    const allSuccess = results.every((r) => r?.success);
    if (!allSuccess) {
      ctx.ui.notify(
        `ralpix: execution stopped — ${state.failedTasks.length} task(s) failed`,
        "error",
      );
      state.phase = "idle";
      persistState(pi, state);
      updateStatusWidget(state, ctx);
      // Re-parse to get updated task titles
      const updatedPlan = parsePlan(planPath);
      updateStatusWidget({ ...state }, ctx);
      return;
    }
  }

  // ---- Review pipeline ----------------------------------------------------
  state.phase = "reviewing";
  persistState(pi, state);
  updateStatusWidget(state, ctx);

  ctx.ui.notify("All tasks complete. Starting review pipeline...", "info");

  try {
    await runReviewPipeline(ctx, pi, plan, config, logger);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Review pipeline error: ${msg}`, "warning");
    logger.logReview("first", `ERROR: ${msg}`);
  }

  // ---- Complete -----------------------------------------------------------
  state.phase = "complete";
  persistState(pi, state);
  updateStatusWidget(state, ctx);
  logger.logComplete();

  const done = state.completedTasks.length;
  const failed = state.failedTasks.length;
  ctx.ui.notify(
    `ralpix: "${plan.title}" complete — ${done} done, ${failed} failed. Progress: ${logger.filePath}`,
    failed > 0 ? "warning" : "success",
  );

  // Move plan on completion if configured
  if (config.movePlanOnCompletion && existsSync(planPath)) {
    try {
      const { dir, base } = pathParse(planPath);
      const completedDir = pathJoin(dir, "completed");
      mkdirSync(completedDir, { recursive: true });
      renameSync(planPath, pathJoin(completedDir, base));
      ctx.ui.notify(`Plan moved to ${completedDir}/${base}`, "info");
    } catch (err) {
      // Non-fatal — plan move is optional
    }
  }

  // Clear widget after a brief pause
  setTimeout(() => {
    ctx.ui.setWidget("ralpix", undefined);
    ctx.ui.setStatus("ralpix", undefined);
  }, 5000);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function updateStatusWidget(
  state: RalpixState,
  ctx: {
    ui: {
      setStatus: (k: string, v: string | undefined) => void;
      setWidget: (k: string, v: string[] | undefined) => void;
      theme: { fg: (c: string, t: string) => string };
    };
  },
): void {
  const { completedTasks, failedTasks, planTitle, phase } = state;

  // Try to re-parse plan for fresh task titles
  let taskTitles: string[] = [];
  let total = completedTasks.length + failedTasks.length;
  try {
    if (existsSync(state.planPath)) {
      const plan = parsePlan(state.planPath);
      taskTitles = plan.tasks.map((t) => t.title);
      total = plan.tasks.length;
    }
  } catch {
    // Plan may have been moved
  }

  const done = completedTasks.length;

  ctx.ui.setStatus(
    "ralpix",
    ctx.ui.theme.fg("accent", `📋 ralpix: ${phase} ${done}/${total}`),
  );

  const lines: string[] = [
    ctx.ui.theme.fg("accent", `Plan: ${planTitle}`),
    ctx.ui.theme.fg("muted", `Phase: ${phase} | ${done}/${total} tasks`),
  ];

  for (let i = 0; i < taskTitles.length; i++) {
    const tid = `task-${i + 1}`;
    let icon: string;
    let color: string;
    if (completedTasks.includes(tid)) {
      icon = "✓";
      color = "success";
    } else if (failedTasks.includes(tid)) {
      icon = "✗";
      color = "error";
    } else {
      icon = "○";
      color = "muted";
    }
    lines.push(ctx.ui.theme.fg(color, `${icon} ${taskTitles[i]}`));
  }

  ctx.ui.setWidget("ralpix", lines);
}
