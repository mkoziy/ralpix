import assert from "node:assert/strict";
import test from "node:test";

import { progressDirForCwd } from "./logger.js";
import { buildPlanCreationPrompt, planCreationAttemptConfigs } from "./planner-prompt.js";

void test("progressDirForCwd uses project-local .ralpix/progress", () => {
  assert.equal(
    progressDirForCwd("/tmp/example"),
    "/tmp/example/.ralpix/progress",
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
