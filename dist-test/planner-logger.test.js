import assert from "node:assert/strict";
import test from "node:test";
import { fmtTokens, formatUsageSummary, progressDirForCwd } from "./logger.js";
import { planCreationDebugFilePath } from "./planner-debug.js";
import { buildPlanCreationPrompt, planCreationAttemptConfigs, plannerLaunchConfigs, } from "./planner-prompt.js";
void test("progressDirForCwd uses project-local .ralpix/progress", () => {
    assert.equal(progressDirForCwd("/tmp/example"), "/tmp/example/.ralpix/progress");
});
void test("planCreationDebugFilePath uses project-local progress directory", () => {
    assert.equal(planCreationDebugFilePath("/tmp/example"), "/tmp/example/.ralpix/progress/plan-creation-debug.txt");
});
void test("formatUsageSummary formats token counts and costs", () => {
    assert.equal(formatUsageSummary({ input: 12_300, output: 1_100, cost: 0.084 }, { input: 24_800, output: 2_000, cost: 0.167 }), "step in 12.3k out 1.1k cost $0.084  total in 24.8k out 2.0k cost $0.167");
    // Values ≥ 100k round to whole k
    assert.equal(formatUsageSummary({ input: 150_000, output: 9_500, cost: 1.234 }, { input: 200_000, output: 10_500, cost: 2.567 }), "step in 150k out 9.5k cost $1.234  total in 200k out 10.5k cost $2.567");
});
void test("fmtTokens formats token counts with k suffix", () => {
    assert.equal(fmtTokens(0), "0");
    assert.equal(fmtTokens(1), "1");
    assert.equal(fmtTokens(999), "999");
    assert.equal(fmtTokens(1000), "1.0k");
    assert.equal(fmtTokens(9999), "10.0k");
    assert.equal(fmtTokens(10_000), "10.0k");
    assert.equal(fmtTokens(99_999), "100.0k");
    assert.equal(fmtTokens(100_000), "100k");
    assert.equal(fmtTokens(150_000), "150k");
    assert.equal(fmtTokens(999_999), "1000k");
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
//# sourceMappingURL=planner-logger.test.js.map