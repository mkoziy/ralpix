import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyModelConfigToSession,
  buildSessionModelChange,
  ensureSharedPiAuth,
  mergeConfig,
  resolveModel,
  resolvePiAgentDir,
} from "./config.js";

import type { ModelConfig, RalpixConfig } from "./types.js";

const OPENAI = "openai";
const ANTHROPIC = "anthropic";
const PROJECT_REVIEWER = "project-reviewer";

function preset(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    model: null,
    provider: null,
    effort: null,
    ...overrides,
  };
}

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
    reviewMaxRetries: 1,
    reviewTimeoutMs: 1800000,
    brainstormTimeoutMs: 600000,
    reviewMaxIterations: 10,
    externalReviewEnabled: true,
    externalReviewModel: null,
    externalReviewEffort: null,
    externalReviewMaxIterations: 10,
    externalReviewPatience: 3,
    planModel: null,
    planEffort: null,
    brainstormEnabled: true,
    brainstormModel: null,
    brainstormEffort: null,
    plansDir: "docs/plans",
    piAgentDir: null,
    epistemicEnabled: true,
    trainingCutoff: "2025-01-01",
    highRiskLibraries: null,
    models: {},
    ...overrides,
  };
}

void test("higher-precedence flat phase model overrides inherited preset model", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        "review-first": preset({
          model: "global-reviewer",
          provider: OPENAI,
          effort: "high",
        }),
      },
    }),
    { reviewFirstModel: PROJECT_REVIEWER },
  );

  assert.deepEqual(resolveModel(merged, "review-first"), {
    model: PROJECT_REVIEWER,
    provider: OPENAI,
    effort: "high",
  });
});

void test("higher-precedence flat effort overrides inherited preset effort", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        "review-second": preset({
          model: "global-reviewer",
          provider: ANTHROPIC,
          effort: "high",
        }),
      },
    }),
    { reviewSecondEffort: "low" },
  );

  assert.deepEqual(resolveModel(merged, "review-second"), {
    model: "global-reviewer",
    provider: ANTHROPIC,
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

// ───────────────────────────────────────────────────────────────────
// Partial config override tests
// ───────────────────────────────────────────────────────────────────

void test("mergeConfig deep-merges models per phase — override adds one phase, base phases survive", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        task: preset({ model: "base-task", provider: OPENAI, effort: "low" }),
        plan: preset({ model: "base-plan", provider: ANTHROPIC, effort: "medium" }),
      },
    }),
    {
      models: {
        task: preset({ model: "override-task" }),
      },
    },
  );

  // task phase — merged from override + inherited base fields
  assert.ok(merged.models !== undefined);
  assert.deepEqual(merged.models.task, {
    model: "override-task",
    provider: OPENAI,
    effort: "low",
  });

  // plan phase — inherited entirely from base
  assert.deepEqual(merged.models.plan, {
    model: "base-plan",
    provider: ANTHROPIC,
    effort: "medium",
  });
});

void test("mergeConfig preserves full config across three layers (bundled → global → project)", () => {
  // Layer 1: bundled defaults (everything set)
  const bundled = makeConfig({
    defaultModel: "bundled-default",
    reviewFirstModel: "bundled-reviewer",
    plansDir: "docs/plans",
    reviewMaxIterations: 10,
    maxRetries: 2,
    models: {
      task: preset({ model: "bundled-task", provider: OPENAI, effort: "low" }),
      plan: preset({ model: "bundled-plan", provider: ANTHROPIC, effort: "medium" }),
    },
  });

  // Layer 2: global config overrides some fields
  const globalConfig: Partial<RalpixConfig> = {
    defaultModel: "global-default",
    reviewFirstModel: "global-reviewer",
    models: {
      task: preset({ model: "global-task" }),
    },
  };

  // Layer 3: project config adds a few targeted overrides
  const projectConfig: Partial<RalpixConfig> = {
    reviewFirstModel: PROJECT_REVIEWER,
    maxRetries: 3,
    models: {
      plan: preset({ model: "project-plan", provider: "deepseek" }),
    },
  };

  // Simulate loadConfig sequence
  let config = mergeConfig(bundled, globalConfig);
  config = mergeConfig(config, projectConfig);

  // Project-level flat overrides win
  assert.equal(config.reviewFirstModel, PROJECT_REVIEWER);
  assert.equal(config.maxRetries, 3);

  // Global-level flat overrides that weren't re-overridden survive
  assert.equal(config.defaultModel, "global-default");

  // Bundled defaults that weren't overridden survive
  assert.equal(config.plansDir, "docs/plans");
  assert.equal(config.reviewMaxIterations, 5);

  // Task phase model comes from global (merged into bundled), preserved by project
  assert.ok(config.models !== undefined);
  assert.deepEqual(config.models.task, {
    model: "global-task",
    provider: OPENAI,
    effort: "low",
  });

  // Plan phase model comes from project (merged into bundled-via-global)
  assert.deepEqual(config.models.plan, {
    model: "project-plan",
    provider: "deepseek",
    effort: "medium",
  });
});

void test("mergeConfig sparse project config inherits all base settings", () => {
  const base = makeConfig({
    plansDir: "custom/plans",
    reviewMaxIterations: 3,
    maxRetries: 5,
    reviewFirstModel: "base-reviewer",
    defaultModel: "base-default",
    models: {
      task: preset({ model: "base-task", provider: OPENAI, effort: "low" }),
      "review-first": preset({ model: "base-review-phase", provider: ANTHROPIC, effort: "high" }),
      plan: preset({ model: "base-plan", provider: OPENAI, effort: "medium" }),
    },
  });

  // Project only sets reviewFirstModel (flat) + task model override
  const project: Partial<RalpixConfig> = {
    reviewFirstModel: PROJECT_REVIEWER,
    models: {
      task: preset({ model: "project-task" }),
    },
  };

  const merged = mergeConfig(base, project);

  // Inherited flat fields from base
  assert.equal(merged.plansDir, "custom/plans");
  assert.equal(merged.reviewMaxIterations, 3);
  assert.equal(merged.maxRetries, 5);
  assert.equal(merged.defaultModel, "base-default");

  // Project flat override wins
  assert.equal(merged.reviewFirstModel, PROJECT_REVIEWER);

  // Task phase — merged (override fields + inherited)
  assert.ok(merged.models !== undefined);
  assert.deepEqual(merged.models.task, {
    model: "project-task",
    provider: OPENAI,
    effort: "low",
  });

  // Review-first phase — inherited entirely from base, but model stripped
  // because project has reviewFirstModel flat field
  assert.deepEqual(merged.models["review-first"], {
    provider: ANTHROPIC,
    effort: "high",
  });

  // Plan phase — inherited entirely from base
  assert.deepEqual(merged.models.plan, {
    model: "base-plan",
    provider: OPENAI,
    effort: "medium",
  });
});

void test("mergeConfig null phase model clears that phase preset", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        task: preset({ model: "a", provider: OPENAI, effort: "low" }),
        plan: preset({ model: "b", provider: ANTHROPIC, effort: "medium" }),
      },
    }),
    {
      models: {
        // null means "clear this phase" so caller falls back to flat fields
        task: null as unknown as ModelConfig,
      },
    },
  );

  // task preset should be gone
  assert.equal(merged.models?.task, undefined);

  // plan preset should survive
  assert.ok(merged.models !== undefined);
  assert.deepEqual(merged.models.plan, {
    model: "b",
    provider: ANTHROPIC,
    effort: "medium",
  });
});

void test("mergeConfig override with no models preserves base models untouched", () => {
  const base = makeConfig({
    models: {
      task: preset({ model: "a", provider: OPENAI, effort: "low" }),
      plan: preset({ model: "b", provider: ANTHROPIC, effort: "medium" }),
    },
  });

  const merged = mergeConfig(base, { maxRetries: 10 });

  assert.equal(merged.maxRetries, 10);

  assert.ok(merged.models !== undefined);
  assert.deepEqual(merged.models.task, {
    model: "a",
    provider: OPENAI,
    effort: "low",
  });
  assert.deepEqual(merged.models.plan, {
    model: "b",
    provider: ANTHROPIC,
    effort: "medium",
  });
});

void test("mergeConfig preserves higher-precedence piAgentDir", () => {
  const merged = mergeConfig(
    makeConfig({
      piAgentDir: "~/.pi/agent-ralpix",
    }),
    {
      reviewMaxIterations: 9,
      piAgentDir: ".ralpix/pi-agent",
    },
  );

  assert.equal(merged.piAgentDir, ".ralpix/pi-agent");
  assert.equal(merged.reviewMaxIterations, 9);
});

void test("resolvePiAgentDir falls back to the default ralpix pi-agent profile", () => {
  const resolved = resolvePiAgentDir("/tmp/project", makeConfig({}));
  assert.match(resolved ?? "", /\/\.ralpix\/pi-agent$/);
});

void test("ensureSharedPiAuth links child auth.json to the default Pi auth file", () => {
  const root = mkdtempSync(join(tmpdir(), "ralpix-auth-"));
  const sharedDir = join(root, ".pi", "agent");
  const childDir = join(root, ".ralpix", "pi-agent");
  mkdirSync(sharedDir, { recursive: true });
  mkdirSync(childDir, { recursive: true });

  const sharedAuthPath = join(sharedDir, "auth.json");
  writeFileSync(sharedAuthPath, "{\"token\":\"shared\"}\n");

  ensureSharedPiAuth(childDir, sharedAuthPath);

  const childAuthPath = join(childDir, "auth.json");
  assert.equal(existsSync(childAuthPath), true);
  assert.equal(lstatSync(childAuthPath).isSymbolicLink(), true);
  assert.equal(readFileSync(childAuthPath, "utf-8"), "{\"token\":\"shared\"}\n");
});

void test("mergeConfig override with only models but no base models uses override models", () => {
  const baseModeless = makeConfig({});
  delete baseModeless.models;
  const merged = mergeConfig(baseModeless, {
    models: {
      task: preset({ model: "only-task", provider: OPENAI, effort: "high" }),
    },
  });

  assert.ok(merged.models !== undefined);
  assert.deepEqual(merged.models.task, {
    model: "only-task",
    provider: OPENAI,
    effort: "high",
  });
});

void test("mergeConfig flat defaultProvider strips provider from all inherited presets", () => {
  const merged = mergeConfig(
    makeConfig({
      models: {
        task: preset({ model: "base-task", provider: OPENAI, effort: "low" }),
        plan: preset({ model: "base-plan", provider: ANTHROPIC, effort: "medium" }),
      },
    }),
    { defaultProvider: "deepseek" },
  );

  assert.ok(merged.models !== undefined);

  // defaultProvider strips provider from all presets that weren't
  // explicitly re-set in the same layer's models
  assert.equal(merged.models.task?.provider, undefined);
  assert.equal(merged.models.plan?.provider, undefined);

  // model and effort survive
  assert.equal(merged.models.task?.model, "base-task");
  assert.equal(merged.models.task.effort, "low");
});
