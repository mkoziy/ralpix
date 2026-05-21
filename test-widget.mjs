import { buildStatusWidgetView } from './dist-test/index.js';

const state = {
  planPath: "/tmp/plan.md",
  planTitle: "Demo",
  currentTaskId: null,
  phase: "reviewing",
  completedTasks: ["task-1"],
  failedTasks: [],
  progressFile: "/tmp/progress.txt",
  review: {
    stages: [
      { id: "first-pass", status: "complete" },
      { id: "external-review", status: "skipped" },
      { id: "external-eval", status: "skipped" },
      { id: "second-pass", status: "active", detail: "iteration 2/5" },
    ],
  },
};

const taskUsage = new Map([
  ["task-1", new Map([["opencode-go/deepseek-v4-pro", { input: 1000, output: 2000, cost: 0.01 }]])]
]);
const reviewUsage = new Map([
  ["second-pass", new Map([["opencode-go/glm-5.1", { input: 3200, output: 800, cost: 0.024 }]])]
]);

const view = buildStatusWidgetView(
  state,
  [{ id: "task-1", title: "Task 1" }],
  1,
  0.034,
  taskUsage,
  reviewUsage,
);

console.log(JSON.stringify(view.lines.map(l => l.text), null, 2));
