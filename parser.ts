/**
 * Plan parser — reads ralpix-format markdown plans.
 *
 * Format:
 *   # Plan: Title
 *   ## Overview
 *   ...
 *   ## Success Criteria
 *   - [ ] item
 *   ### Task N: Title
 *   - [ ] / - [x] checklist items
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Plan, PlanItem, PlanTask } from "./types.js";

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

const RE_H1 = /^#\s+Plan:\s*(.+)/i;
const RE_H2 = /^##\s+(.+)/i;
const RE_H3_TASK = /^###\s+Task\s+(\d+):\s*(.+)/i;
const RE_CHECKBOX = /^-\s+\[([ x])\]\s+(.+)/i;
const RE_EMPTY = /^\s*$/;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

interface ParseState {
  section: "overview" | "context" | "criteria" | "task";
  overviewLines: string[];
  contextLines: string[];
  criteria: PlanItem[];
  tasks: PlanTask[];
  currentTask: PlanTask | null;
  taskLines: string[];
}

export function parsePlan(filePath: string): Plan {
  if (!existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  let title = "Untitled Plan";

  const state: ParseState = {
    section: "overview",
    overviewLines: [],
    contextLines: [],
    criteria: [],
    tasks: [],
    currentTask: null,
    taskLines: [],
  };

  function flushTask(): void {
    if (!state.currentTask) return;
    state.currentTask.description = state.taskLines.join("\n").trim();
    if (state.currentTask.items.length === 0 && state.currentTask.description) {
      // No checkboxes — treat whole task as one implicit item
      state.currentTask.items = [{ text: state.currentTask.description, done: false }];
    }
    state.tasks.push(state.currentTask);
    state.currentTask = null;
    state.taskLines = [];
  }

  for (const line of lines) {
    // H1: Plan title
    const h1m = line.match(RE_H1);
    if (h1m) {
      title = h1m[1].trim();
      continue;
    }

    // H2: sections
    const h2m = line.match(RE_H2);
    if (h2m) {
      const heading = h2m[1].trim().toLowerCase();
      if (heading.startsWith("overview")) {
        state.section = "overview";
      } else if (heading.startsWith("context")) {
        state.section = "context";
      } else if (heading.startsWith("success")) {
        state.section = "criteria";
      } else if (heading.startsWith("open question") || heading.startsWith("v2")) {
        flushTask();
        state.section = "overview"; // ignore v2 sections
      }
      continue;
    }

    // H3: Task
    const h3m = line.match(RE_H3_TASK);
    if (h3m) {
      flushTask();
      state.section = "task";
      const num = parseInt(h3m[1], 10);
      state.currentTask = {
        id: `task-${num}`,
        number: num,
        title: `Task ${num}: ${h3m[2].trim()}`,
        description: "",
        items: [],
        status: "pending",
      };
      state.taskLines = [];
      continue;
    }

    // Checkbox
    const cbm = line.match(RE_CHECKBOX);
    if (cbm && (state.section === "task" || state.section === "criteria")) {
      const item: PlanItem = { text: cbm[2].trim(), done: cbm[1] === "x" };
      if (state.section === "task" && state.currentTask) {
        state.currentTask.items.push(item);
      } else if (state.section === "criteria") {
        state.criteria.push(item);
      }
      continue;
    }

    // Skip empty lines between sections
    if (RE_EMPTY.test(line) && state.section !== "task") continue;

    // Collect content
    if (state.section === "overview") {
      state.overviewLines.push(line);
    } else if (state.section === "context") {
      state.contextLines.push(line);
    } else if (state.section === "task" && state.currentTask) {
      state.taskLines.push(line);
    }
  }

  flushTask();

  // Infer status from checkboxes
  for (const task of state.tasks) {
    if (task.items.length === 0) continue;
    const allDone = task.items.every((i) => i.done);
    const anyDone = task.items.some((i) => i.done);
    if (allDone) {
      task.status = "completed";
    } else if (anyDone) {
      task.status = "in-progress";
    }
  }

  return {
    path: filePath,
    title,
    overview: state.overviewLines.join("\n").trim(),
    context: state.contextLines.join("\n").trim(),
    successCriteria: state.criteria,
    tasks: state.tasks,
  };
}

/** Find the next pending (not completed, not failed) task */
export function findNextPendingTask(plan: Plan): PlanTask | null {
  return plan.tasks.find((t) => t.status === "pending") ?? null;
}

/** Update checkboxes in the plan file to reflect task status */
export function updatePlanTaskStatus(
  planPath: string,
  taskId: string,
  taskTitle: string,
  status: "in-progress" | "completed" | "failed",
): void {
  const content = readFileSync(planPath, "utf-8");
  const lines = content.split("\n");

  const taskRe = new RegExp(`^###\\s+${taskTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  let inTask = false;
  const newLines = lines.map((line) => {
    if (taskRe.test(line)) {
      inTask = true;
      return line;
    }
    if (inTask) {
      if (/^###\s+Task/i.test(line) || /^##\s+/.test(line)) {
        inTask = false;
        return line;
      }
      // Update checkboxes
      const m = line.match(RE_CHECKBOX);
      if (m) {
        const mark = status === "completed" ? "x" : " ";
        return `- [${mark}] ${m[2]}`;
      }
    }
    return line;
  });

  writeFileSync(planPath, newLines.join("\n"), "utf-8");
}
