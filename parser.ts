import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Plan, PlanItem, PlanTask } from "./types.js";

const RE_H1 = /^#\s+plan:\s*(.+)/i;
const RE_H2 = /^##\s+(.+)/i;
const RE_H3_TASK = /^###\s+task\s+(\d+):\s*(.+)/i;
const RE_CHECKBOX = /^-\s+\[([ x])]\s+(.+)/i;
const RE_H3_OR_H2 = /^(?:###\s+task|##\s+)/i;

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

function flushCurrentTask(state: ParseState): void {
  if (state.currentTask === null) return;
  state.currentTask.description = state.taskLines.join("\n").trim();
  if (state.currentTask.items.length === 0 && state.currentTask.description.length > 0) {
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
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  }
  state.currentExtraKey = null;
}

function handleH2(heading: string): { section: ParseState["section"]; extraKey?: string } | "flush" {
  const lower = heading.toLowerCase();
  if (lower.startsWith("overview")) return { section: "overview" };
  if (lower.startsWith("context")) return { section: "context" };
  if (lower.startsWith("success")) return { section: "criteria" };
  if (lower.startsWith("open question") || lower.startsWith("v2") || lower.startsWith("validation")) {
    return "flush";
  }
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
    state.extraSections[state.currentExtraKey]?.push(line);
  }
}

function inferTaskStatuses(tasks: PlanTask[]): void {
  for (const task of tasks) {
    if (task.items.length === 0) continue;
    const allDone = task.items.every((i) => i.done);
    const anyDone = task.items.some((i) => i.done);
    if (allDone) task.status = "completed";
    else if (anyDone) task.status = "in-progress";
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export function parsePlan(content: string, sourcePath = ""): Plan {
  const lines = content.split("\n");
  let title = "Untitled Plan";
  const state = createInitialState();

  for (const line of lines) {
    const h1Match = RE_H1.exec(line);
    if (h1Match !== null) {
      title = h1Match[1]?.trim() ?? title;
      continue;
    }

    const h2Match = RE_H2.exec(line);
    if (h2Match !== null) {
      const heading = h2Match[1] ?? "";
      const result = handleH2(heading);
      flushCurrentTask(state);
      flushExtraSection(state);
      if (result === "flush") {
        state.section = "ignore";
      } else {
        state.section = result.section;
        if (result.section === "extra" && result.extraKey !== undefined) {
          state.currentExtraKey = result.extraKey;
          state.extraSections[result.extraKey] ??= [];
        }
      }
      continue;
    }

    if (RE_H3_TASK.test(line)) {
      flushCurrentTask(state);
      flushExtraSection(state);
      handleH3(line, state);
      continue;
    }

    if (RE_CHECKBOX.test(line) && (state.section === "task" || state.section === "criteria")) {
      handleCheckbox(line, state);
      continue;
    }

    if ((/^\s*$/).test(line) && state.section !== "task") continue;

    collectLine(line, state);
  }

  flushCurrentTask(state);
  flushExtraSection(state);
  inferTaskStatuses(state.tasks);

  const extraSections: Record<string, string> = {};
  for (const [key, sectionLines] of Object.entries(state.extraSections)) {
    const trimmed = sectionLines.join("\n").trim();
    if (trimmed.length > 0) extraSections[key] = trimmed;
  }

  return {
    path: sourcePath,
    title,
    overview: state.overviewLines.join("\n").trim(),
    context: state.contextLines.join("\n").trim(),
    successCriteria: state.criteria,
    tasks: state.tasks,
    extraSections,
  };
}

export function loadPlan(filePath: string): Plan {
  if (!existsSync(filePath)) throw new Error(`Plan file not found: ${filePath}`);
  return parsePlan(readFileSync(filePath, "utf-8"), filePath);
}

export function findNextPendingTask(plan: Plan): PlanTask | null {
  return plan.tasks.find((t) => t.status === "pending") ?? null;
}

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

      const match = RE_CHECKBOX.exec(line);
      if (match?.[2] !== undefined) return `- [${mark}] ${match[2]}`;
    }
    return line;
  });

  writeFileSync(planPath, newLines.join("\n"), "utf-8");
}
