/**
 * Interactive plan creation — model explores codebase, asks clarifying
 * questions, generates a plan draft, and iterates on user feedback.
 *
 * Called by the /ralpix plan <description> command.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Type } from "typebox";

import { applyModelConfigToSession, resolveModel } from "./config.js";
import { buildPlanCreationPrompt, planCreationAttemptConfigs } from "./planner-prompt.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

import type { RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a description into a filesystem-safe plan filename. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 60);

  // When the description contains no ASCII alphanumerics (e.g. Cyrillic,
  // CJK), the regex strips everything and we get an empty slug.  Fall back
  // to a short hash so the filename stays non-empty and unique.
  if (slug.length > 0) return slug;

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i) ?? 0;
    hash = Math.trunc((hash << 5) - hash + codePoint);
  }
  return `plan-${Math.abs(hash).toString(36).slice(0, 12)}`;
}

interface PlanCreationSessionResult {
  planContent: string | null;
  lastAction: "accept" | "reject" | null;
}

function notifyPlanCreationRetry(ctx: ExtensionCommandContext, attempt: number): void {
  if (attempt === 1) {
    ctx.ui.notify(
      "Plan session ended without submitting a draft. Retrying without plan effort...",
      "warning",
    );
  } else if (attempt === 2) {
    ctx.ui.notify(
      "Plan session still ended without a draft. Retrying with pi's default session model...",
      "warning",
    );
  }
}

async function runPlanCreationSession(
  prompt: string,
  attempt: number,
  ctx: ExtensionCommandContext,
  planModelCfg: ReturnType<typeof resolveModel>,
  attemptConfig: { includeEffort: boolean; seedSessionConfig: boolean },
): Promise<PlanCreationSessionResult> {
  let planContent: string | null = null;
  let lastAction: "accept" | "reject" | null = null;

  await ctx.newSession({
    setup: (sm) => {
      if (attemptConfig.seedSessionConfig) {
        applyModelConfigToSession(sm, planModelCfg, attemptConfig.includeEffort);
      }
    },
    withSession: async (planCtx) => {
      planCtx.registerTool({
        name: "ralpix_ask_question",
        label: "Ask User Question",
        description:
          "Ask the user a clarifying question during plan creation. " +
          "Use this when you need to understand requirements, preferences, " +
          "or constraints before writing the plan.",
        promptSnippet: "Ask user: {{question}}",
        /* eslint-disable @typescript-eslint/no-unsafe-assignment */
        parameters: Type.Object({
          question: Type.String({
            description: "The question to ask the user",
          }),
          options: Type.Array(Type.String(), {
            description: "Answer options for the user to pick from",
          }),
        }),
        /* eslint-enable @typescript-eslint/no-unsafe-assignment */
        async execute(_toolCallId, params) {
          const question = params["question"] as string;
          const options = params["options"] as string[];

          const answer = await ctx.ui.select(question, options);

          if (answer === undefined || answer.length === 0) {
            return {
              content: [
                { type: "text", text: "User cancelled the question." },
              ],
              details: { cancelled: true },
            };
          }

          return {
            content: [
              { type: "text", text: `User selected: ${answer}` },
            ],
            details: { answer },
          };
        },
      });

      planCtx.registerTool({
        name: "ralpix_submit_plan_draft",
        label: "Submit Plan Draft",
        description:
          "Submit a plan draft for user review. The user will accept, " +
          "request revisions, or reject. If revisions are requested, " +
          "update the plan and call this tool again.",
        promptSnippet: "Submit plan draft for review",
        /* eslint-disable @typescript-eslint/no-unsafe-assignment */
        parameters: Type.Object({
          planContent: Type.String({
            description: "The complete plan in ralpix markdown format",
          }),
        }),
        /* eslint-enable @typescript-eslint/no-unsafe-assignment */
        async execute(_toolCallId, params) {
          const content = params["planContent"] as string;

          const reviewChoice = await ctx.ui.select(
            "Review the plan draft:",
            ["✓ Accept — save and finish", "↻ Revise — provide feedback", "✗ Reject — discard the plan"],
          );

          if (typeof reviewChoice === "string" && reviewChoice.includes("Revise")) {
            const feedback = await ctx.ui.input(
              "What changes would you like?",
              "Add more details, change approach, fix issues...",
            );

            return {
              content: [
                {
                  type: "text",
                  text: typeof feedback === "string" && feedback.length > 0
                    ? `User requested revisions: ${feedback}`
                    : "User requested revisions (no specific feedback provided).",
                },
              ],
              details: { action: "revise", feedback: feedback ?? "" },
            };
          }

          if (typeof reviewChoice === "string" && reviewChoice.includes("Accept")) {
            planContent = content;
            lastAction = "accept";

            return {
              content: [
                {
                  type: "text",
                  text: "Plan accepted! The user approved the plan draft. No further action needed.",
                },
              ],
              details: { action: "accept" },
            };
          }

          lastAction = "reject";

          return {
            content: [
              { type: "text", text: "Plan rejected by user." },
            ],
            details: { action: "reject" },
          };
        },
      });

      await planCtx.sendUserMessage(buildPlanCreationPrompt(prompt, attempt));
      await planCtx.waitForIdle();
    },
  });

  return { planContent, lastAction };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run interactive plan creation.
 *
 * Spawns a new pi session with two registered tools:
 *  - ralpix_ask_question   — model asks user a clarifying question
 *  - ralpix_submit_plan_draft — model submits plan for accept/revise/reject
 *
 * Returns the path to the saved plan file if user chose to execute,
 * or null if user is done / rejected / failed.
 */

export async function runPlanCreation(
  description: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  config: RalpixConfig,
): Promise<string | null> {
  // Validate
  const trimmed = description.trim();
  if (trimmed.length < 5) {
    ctx.ui.notify("Plan description too short (min 5 characters)", "error");
    return null;
  }

  ctx.ui.notify(`Creating plan for: "${description}"...`, "info");

  // Load and expand the plan creation prompt
  const template = loadPrompt("plan-creation", ctx.cwd);
  const prompt = expandPrompt(template, {
    DESCRIPTION: description,
  });

  // Resolve model + effort via the central resolveModel()
  const planModelCfg = resolveModel(config, "plan");

  let planContent: string | null = null;
  let lastAction: "accept" | "reject" | null = null;
  const attemptConfigs = planCreationAttemptConfigs();
  for (const [index, attemptConfig] of attemptConfigs.entries()) {
    const attempt = index + 1;
    const result = await runPlanCreationSession(prompt, attempt, ctx, planModelCfg, attemptConfig);
    planContent = result.planContent;
    lastAction = result.lastAction;
    if (lastAction === "reject" || planContent !== null) break;
    notifyPlanCreationRetry(ctx, attempt);
  }

  // ── After session: handle results ─────────────────────────────────

  if (lastAction === "reject") {
    ctx.ui.notify("Plan creation cancelled (user rejected)", "warning");
    return null;
  }

  if (planContent === null) {
    ctx.ui.notify(
      "Plan creation failed — session ended without submitting a plan draft",
      "error",
    );
    return null;
  }

  // Determine plan path
  const plansDir = resolve(ctx.cwd, config.plansDir.length > 0 ? config.plansDir : "docs/plans");
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  const planName = slugify(description);
  const planPath = join(plansDir, `${planName}.md`);

  // Check if file exists
  if (existsSync(planPath)) {
    const overwrite = await ctx.ui.confirm(
      "Plan already exists",
      `${planPath} already exists. Overwrite?`,
    );
    if (overwrite !== true) {
      ctx.ui.notify("Plan creation cancelled (file exists)", "warning");
      return null;
    }
  }

  // Write plan
  writeFileSync(planPath, planContent, "utf-8");
  ctx.ui.notify(`Plan saved to ${planPath}`, "success");

  // Offer execution
  const execute = await ctx.ui.select(
    "Plan created. What next?",
    ["▶ Execute plan now", "✓ Done — exit, run later"],
  );

  if (typeof execute === "string" && execute.includes("Execute")) {
    return planPath;
  }

  return null;
}
