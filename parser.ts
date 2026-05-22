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

const RE_H1 = /^#\s+plan:\s*(.+)/i;
const RE_H2 = /^##\s+(.+)/i;
const RE_H3_TASK = /^###\s+task\s+(\d+):\s*(.+)/i;
const RE_CHECKBOX = /^-\s+\[([ x])]\s+(.+)/i;
const RE_EMPTY = /^\s*$/;
const RE_H3_OR_H2 = /^(?:###\s+task|##\s+)/i;

// ---------------------------------------------------------------------------
// Section handlers (break up cognitive complexity)
// ---------------------------------------------------------------------------

interface ParseState {
  section: "overview" | "context" | "criteria" | "task" | "ignore" | "extra";
  overviewLines: string[];
  contextLines: string[];
  criteria: PlanItem[];
  tasks: PlanTask[];
  currentTask: PlanTask | null;
  taskLines: string[];
  extraSections: Record<string, string[]>;
  currentExtraKey: string | null;
}

function flushCurrentTask(state: ParseState): void {
  if (state.currentTask === null) return;
  state.currentTask.description = state.taskLines.join("\n").trim();
  if (state.currentTask.items.length === 0 && state.currentTask.description.length > 0) {
    // No checkboxes — treat whole task as one implicit item
    state.currentTask.items = [{ text: state.currentTask.description, done: false }];
  }
  state.tasks.push(state.currentTask);
  state.currentTask = null;
  state.taskLines = [];
}

function flushExtraSection(state: ParseState): void {
  if (state.currentExtraKey === null) return;
  const lines = state.extraSections[state.currentExtraKey];
  if (lines !== undefined) {
    // Trim leading/trailing blank lines but preserve internal ones
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  }
  state.currentExtraKey = null;
}

function handleH1(line: string): string | null {
  const match = RE_H1.exec(line);
  return match?.[1]?.trim() ?? null;
}

function handleH2(heading: string): { section: ParseState["section"]; extraKey?: string } | "flush" {
  const lower = heading.toLowerCase();
  if (lower.startsWith("overview")) return { section: "overview" };
  if (lower.startsWith("context")) return { section: "context" };
  if (lower.startsWith("success")) return { section: "criteria" };
  if (lower.startsWith("open question") || lower.startsWith("v2") || lower.startsWith("validation")) {
    return "flush";
  }
  // Treat all other H2 headings as extra sections (Design Decisions, Key Layout, etc.)
  return { section: "extra", extraKey: heading.trim() };
}

function handleH3(line: string, state: ParseState): void {
  const match = RE_H3_TASK.exec(line);
  if (match === null) return;
  const numStr = match[1];
  const taskTitle = match[2];
  if (numStr === undefined || taskTitle === undefined) return;

  const num = Number.parseInt(numStr, 10);
  state.section = "task";
  state.currentTask = {
    id: `task-${num}`,
    number: num,
    title: `Task ${num}: ${taskTitle.trim()}`,
    description: "",
    items: [],
    status: "pending",
  };
  state.taskLines = [];
}

function handleCheckbox(line: string, state: ParseState): void {
  const match = RE_CHECKBOX.exec(line);
  if (match === null) return;
  const done = match[1];
  const text = match[2];
  if (done === undefined || text === undefined) return;

  const item: PlanItem = { text: text.trim(), done: done === "x" };
  if (state.section === "task" && state.currentTask !== null) {
    state.currentTask.items.push(item);
  } else if (state.section === "criteria") {
    state.criteria.push(item);
  }
}

function collectLine(line: string, state: ParseState): void {
  if (state.section === "overview") {
    state.overviewLines.push(line);
  } else if (state.section === "context") {
    state.contextLines.push(line);
  } else if (state.section === "task" && state.currentTask !== null) {
    state.taskLines.push(line);
  } else if (state.section === "extra" && state.currentExtraKey !== null) {
    const bucket = state.extraSections[state.currentExtraKey];
    if (bucket !== undefined) bucket.push(line);
  }
}

function inferTaskStatuses(tasks: PlanTask[]): void {
  for (const task of tasks) {
    if (task.items.length === 0) continue;
    const allDone = task.items.every((i) => i.done);
    const anyDone = task.items.some((i) => i.done);
    if (allDone) {
      task.status = "completed";
    } else if (anyDone) {
      task.status = "in-progress";
    }
  }
}

function createInitialState(): ParseState {
  return {
    section: "overview",
    overviewLines: [],
    contextLines: [],
    criteria: [],
    tasks: [],
    currentTask: null,
    taskLines: [],
    extraSections: {},
    currentExtraKey: null,
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export function parsePlan(filePath: string): Plan {
  if (!existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  let title = "Untitled Plan";
  const state = createInitialState();

  for (const line of lines) {
    // H1: Plan title
    const h1Title = handleH1(line);
    if (h1Title !== null) {
      title = h1Title;
      continue;
    }

    // H2: sections
    const h2Match = RE_H2.exec(line);
    if (h2Match !== null) {
      const heading = h2Match[1] ?? "";
      const result = handleH2(heading);
      if (result === "flush") {
        flushCurrentTask(state);
        flushExtraSection(state);
        state.section = "ignore";
      } else {
        flushCurrentTask(state);
        flushExtraSection(state);
        state.section = result.section;
        if (result.section === "extra" && result.extraKey !== undefined) {
          state.currentExtraKey = result.extraKey;
          state.extraSections[result.extraKey] ??= [];
        }
      }
      continue;
    }

    // H3: Task
    if (RE_H3_TASK.test(line)) {
      flushCurrentTask(state);
      flushExtraSection(state);
      handleH3(line, state);
      continue;
    }

    // Checkbox
    if (RE_CHECKBOX.test(line) && (state.section === "task" || state.section === "criteria")) {
      handleCheckbox(line, state);
      continue;
    }

    // Skip empty lines between sections
    if (RE_EMPTY.test(line) && state.section !== "task") continue;

    // Collect content
    collectLine(line, state);
  }

  flushCurrentTask(state);
  flushExtraSection(state);
  inferTaskStatuses(state.tasks);

  const extraSections: Record<string, string> = {};
  for (const [key, sectionLines] of Object.entries(state.extraSections)) {
    const trimmed = sectionLines.join("\n").trim();
    if (trimmed.length > 0) {
      extraSections[key] = trimmed;
    }
  }

  return {
    path: filePath,
    title,
    overview: state.overviewLines.join("\n").trim(),
    context: state.contextLines.join("\n").trim(),
    successCriteria: state.criteria,
    tasks: state.tasks,
    extraSections,
  };
}

/** Find the next pending (not completed, not failed) task */
export function findNextPendingTask(plan: Plan): PlanTask | null {
  return plan.tasks.find((t) => t.status === "pending") ?? null;
}

/** Update checkboxes in the plan file to reflect task status */
export function updatePlanTaskStatus(
  planPath: string,
  _taskId: string,
  taskTitle: string,
  status: "in-progress" | "completed" | "failed",
): void {
  const content = readFileSync(planPath, "utf-8");
  const lines = content.split("\n");

  const escapedTitle = taskTitle.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
  const taskRe = new RegExp(String.raw`^###\s+${escapedTitle}`);
  let inTask = false;
  const mark = status === "completed" ? "x" : " ";

  const newLines = lines.map((line) => {
    if (taskRe.test(line)) {
      inTask = true;
      return line;
    }
    if (inTask) {
      if (RE_H3_OR_H2.test(line)) {
        inTask = false;
        return line;
      }
      // Update checkboxes
      const match = RE_CHECKBOX.exec(line);
      if (match?.[2] !== undefined) {
        return `- [${mark}] ${match[2]}`;
      }
    }
    return line;
  });

  writeFileSync(planPath, newLines.join("\n"), "utf-8");
}
