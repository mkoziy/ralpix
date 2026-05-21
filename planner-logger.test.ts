import assert from "node:assert/strict";
import test from "node:test";

import { formatUsageSummary, progressDirForCwd } from "./logger.js";
import { planCreationDebugFilePath } from "./planner-debug.js";
import {
  buildPlanCreationPrompt,
  planCreationAttemptConfigs,
  plannerLaunchConfigs,
} from "./planner-prompt.js";

void test("progressDirForCwd uses project-local .ralpix/progress", () => {
  assert.equal(
    progressDirForCwd("/tmp/example"),
    "/tmp/example/.ralpix/progress",
  );
});

void test("planCreationDebugFilePath uses project-local progress directory", () => {
  assert.equal(
    planCreationDebugFilePath("/tmp/example"),
    "/tmp/example/.ralpix/progress/plan-creation-debug.txt",
  );
});

void test("formatUsageSummary uses lowercase step and total labels", () => {
  assert.equal(
    formatUsageSummary(
      { input: 12_300, output: 1_100, cost: 0.084 },
      { input: 24_800, output: 2_000, cost: 0.167 },
    ),
    "step in 12.3k out 1.1k cost $0.084  total in 24.8k out 2.0k cost $0.167",
  );
});

void test("buildPlanCreationPrompt requires draft submission before session ends", () => {
  const prompt = buildPlanCreationPrompt("# Plan Creation\n\nBase instructions");

  assert.match(prompt, /Completion Contract/);
  assert.match(prompt, /ralpix_submit_plan_draft/);
  assert.match(prompt, /do not end the session without either submitting a draft/i);
});

void test("buildPlanCreationPrompt adds a retry notice on follow-up attempts", () => {
  const prompt = buildPlanCreationPrompt("# Plan Creation", 2);

  assert.match(prompt, /Retry Notice/);
  assert.match(prompt, /previous attempt ended without submitting a draft/i);
});

void test("planCreationAttemptConfigs degrades from configured to session default", () => {
  assert.deepEqual(planCreationAttemptConfigs(), [
    { includeEffort: true, seedSessionConfig: true },
    { includeEffort: false, seedSessionConfig: true },
    { includeEffort: false, seedSessionConfig: false },
  ]);
});

void test("plannerLaunchConfigs degrades from configured launch to pi defaults", () => {
  assert.deepEqual(plannerLaunchConfigs(), [
    { modelPhase: "plan", includeEffort: true },
    { modelPhase: "plan", includeEffort: false },
    { modelPhase: "task", includeEffort: false },
    { modelPhase: null, includeEffort: false },
  ]);
});
