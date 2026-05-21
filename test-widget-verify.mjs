function fmtTokens(n) {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function usageLinesFor(id, usageById) {
  const perModel = usageById.get(id);
  if (perModel === undefined) return [];
  return [...perModel.entries()].map(
    ([key, usage]) => `${key}  in ${fmtTokens(usage.input)}  out ${fmtTokens(usage.output)}  $${usage.cost.toFixed(3)}`,
  );
}

const REVIEW_STAGE_LABELS = {
  "first-pass": "First pass",
  "external-review": "External review",
  "external-eval": "External eval",
  "second-pass": "Second pass",
};

function formatReviewStageLine(stage) {
  const label = REVIEW_STAGE_LABELS[stage.id];
  const suffix = stage.detail === undefined || stage.detail.length === 0 ? "" : ` — ${stage.detail}`;

  switch (stage.status) {
    case "complete": {
      return { color: "success", text: `✓ ${label}${suffix}` };
    }
    case "failed": {
      return { color: "error", text: `✗ ${label}${suffix}` };
    }
    case "active": {
      return { color: "accent", text: `▶ ${label}${suffix}` };
    }
    case "skipped": {
      return { color: "muted", text: `- ${label}${suffix}` };
    }
    case "pending": {
      return { color: "muted", text: `○ ${label}${suffix}` };
    }
  }
}

function buildStatusWidgetView(state, tasks, total, totalCost = 0, taskUsageById = new Map(), reviewUsageById = new Map()) {
  const { completedTasks, currentTaskId, failedTasks, planTitle, phase, review } = state;
  const done = completedTasks.length;
  const costSuffix = totalCost > 0 ? `  $${totalCost.toFixed(3)}` : "";

  const lines = [
    { color: "accent", text: `Plan: ${planTitle}` },
    { color: "muted", text: `Phase: ${phase} | ${done}/${total} tasks` },
  ];

  for (const task of tasks) {
    if (completedTasks.includes(task.id)) {
      lines.push({ color: "success", text: `✓ ${task.title}` });
    } else if (failedTasks.includes(task.id)) {
      lines.push({ color: "error", text: `✗ ${task.title}` });
    } else if (currentTaskId === task.id) {
      lines.push({ color: "accent", text: `▶ ${task.title}` });
    } else {
      lines.push({ color: "muted", text: `○ ${task.title}` });
    }
    for (const usageLine of usageLinesFor(task.id, taskUsageById)) {
      lines.push({ color: "muted", text: `  ${usageLine}` });
    }
  }

  if (review !== undefined) {
    const visibleStages = review.stages.filter((stage) => stage.status !== "pending");
    lines.push({ color: "muted", text: "" });
    lines.push({ color: "accent", text: "Review" });
    for (const stage of visibleStages) {
      lines.push(formatReviewStageLine(stage));
      for (const usageLine of usageLinesFor(stage.id, reviewUsageById)) {
        lines.push({ color: "muted", text: `  ${usageLine}` });
      }
    }
  }

  return {
    statusText: `📋 ralpix: ${phase} ${done}/${total}${costSuffix}`,
    lines,
  };
}

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

console.log("Actual output:");
console.log(JSON.stringify(view.lines.map(l => l.text), null, 2));

console.log("\nExpected output:");
console.log(JSON.stringify([
  "Plan: Demo",
  "Phase: reviewing | 1/1 tasks",
  "✓ Task 1",
  "  opencode-go/deepseek-v4-pro  in 1.0k  out 2.0k  $0.010",
  "",
  "Review",
  "✓ First pass",
  "▶ Second pass — iteration 2/5",
  "  opencode-go/glm-5.1  in 3.2k  out 800  $0.024",
], null, 2));
