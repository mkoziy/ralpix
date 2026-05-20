import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatModelConfigForProgress, progressDirForCwd } from "./logger.js";
import { planCreationDebugFilePath } from "./planner-debug.js";
import {
  buildPlanCreationPrompt,
  planCreationAttemptConfigs,
  plannerLaunchConfigs,
} from "./planner-prompt.js";

void test("progressDirForCwd uses project-local .ralpix/progress", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ralpix-progress-")));
  assert.equal(
    progressDirForCwd(root),
    join(root, ".ralpix", "progress"),
  );
});

void test("planCreationDebugFilePath uses project-local progress directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ralpix-progress-")));
  assert.equal(
    planCreationDebugFilePath(root),
    join(root, ".ralpix", "progress", "plan-creation-debug.txt"),
  );
});

void test("formatModelConfigForProgress prints provider model and thinking", () => {
  assert.equal(
    formatModelConfigForProgress({
      model: "openai-codex/gpt-5.5",
      provider: null,
      effort: "high",
    }),
    "provider=openai-codex model=gpt-5.5 thinking=high",
  );

  assert.equal(
    formatModelConfigForProgress({
      model: null,
      provider: "anthropic",
      effort: null,
    }),
    "provider=anthropic model=provider default thinking=default",
  );

  assert.equal(
    formatModelConfigForProgress({
      model: null,
      provider: null,
      effort: null,
    }),
    "provider=default model=session default thinking=default",
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
