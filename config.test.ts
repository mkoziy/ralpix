import assert from "node:assert/strict";
import test from "node:test";

import { applyModelConfigToSession, buildSessionModelChange, mergeConfig, resolveModel } from "./config.js";

import type { RalpixConfig } from "./types.js";

function makeConfig(overrides: Partial<RalpixConfig>): RalpixConfig {
  return {
    defaultModel: null,
    defaultProvider: null,
    defaultEffort: null,
    commitEnabled: true,
    commitMessageTemplate: "ralpix: {{taskTitle}}",
    reviewEnabled: true,
    reviewFirstModel: null,
    reviewSecondModel: null,
    reviewFirstEffort: null,
    reviewSecondEffort: null,
    maxRetries: 2,
    reviewMaxIterations: 5,
    movePlanOnCompletion: false,
    externalReviewEnabled: true,
    externalReviewModel: null,
    externalReviewEffort: null,
    externalReviewMaxIterations: 5,
    externalReviewPatience: 3,
    planModel: null,
    planEffort: null,
    plansDir: "docs/plans",
    models: {},
    ...overrides,
  };
}

void test("higher-precedence flat phase model overrides inherited preset model", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        "review-first": {
          model: "global-reviewer",
          provider: "openai",
          effort: "high",
        },
      },
    }),
    { reviewFirstModel: "project-reviewer" },
  );

  assert.deepEqual(resolveModel(merged, "review-first"), {
    model: "project-reviewer",
    provider: "openai",
    effort: "high",
  });
});

void test("higher-precedence flat effort overrides inherited preset effort", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        "review-second": {
          model: "global-reviewer",
          provider: "anthropic",
          effort: "high",
        },
      },
    }),
    { reviewSecondEffort: "low" },
  );

  assert.deepEqual(resolveModel(merged, "review-second"), {
    model: "global-reviewer",
    provider: "anthropic",
    effort: "low",
  });
});

void test("buildSessionModelChange supports structured and qualified models only", () => {
  assert.deepEqual(buildSessionModelChange({
    model: "openai/gpt-5",
    provider: null,
    effort: null,
  }), {
    provider: "openai",
    model: "gpt-5",
  });

  assert.deepEqual(buildSessionModelChange({
    model: "sonnet",
    provider: "anthropic",
    effort: null,
  }), {
    provider: "anthropic",
    model: "sonnet",
  });

  assert.equal(buildSessionModelChange({
    model: "gpt-5",
    provider: null,
    effort: null,
  }), null);

  assert.equal(buildSessionModelChange({
    model: null,
    provider: "openai",
    effort: null,
  }), null);
});

void test("applyModelConfigToSession applies model pair and optional effort", () => {
  const calls: string[] = [];
  applyModelConfigToSession({
    appendModelChange(provider, model) {
      calls.push(`model:${provider}/${model}`);
    },
    appendThinkingLevelChange(level) {
      calls.push(`effort:${level}`);
    },
  }, {
    model: "anthropic/claude-sonnet-4-5",
    provider: null,
    effort: "high",
  });

  applyModelConfigToSession({
    appendModelChange(provider, model) {
      calls.push(`skip-model:${provider}/${model}`);
    },
    appendThinkingLevelChange(level) {
      calls.push(`skip-effort:${level}`);
    },
  }, {
    model: "gpt-5",
    provider: null,
    effort: "low",
  }, false);

  assert.deepEqual(calls, [
    "model:anthropic/claude-sonnet-4-5",
    "effort:high",
  ]);
});
