/**
 * Interactive plan creation — model explores codebase, asks clarifying
 * questions, generates a plan draft, and iterates on user feedback.
 *
 * Called by the /ralpix plan <description> command.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { RalpixConfig } from "./types.js";
import { loadPrompt, expandPrompt } from "./prompt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a description into a filesystem-safe plan filename. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  // When the description contains no ASCII alphanumerics (e.g. Cyrillic,
  // CJK), the regex strips everything and we get an empty slug.  Fall back
  // to a short hash so the filename stays non-empty and unique.
  if (slug) return slug;

  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return "plan-" + Math.abs(hash).toString(36).slice(0, 12);
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
  pi: ExtensionAPI,
  config: RalpixConfig,
): Promise<string | null> {
  // Validate
  if (!description || description.trim().length < 5) {
    ctx.ui.notify("Plan description too short (min 5 characters)", "error");
    return null;
  }

  ctx.ui.notify(`Creating plan for: "${description}"...`, "info");

  // Load and expand the plan creation prompt
  const template = loadPrompt("plan-creation", ctx.cwd);
  const prompt = expandPrompt(template, {
    DESCRIPTION: description,
  });

  // Captured from tool calls
  let planContent: string | null = null;
  let lastAction: "accept" | "reject" | null = null;

  // planModel → defaultModel → (pi session default)
  const desiredModel = config.planModel || config.defaultModel;
  // planEffort → defaultEffort → (pi session default)
  const desiredEffort = config.planEffort || config.defaultEffort;

  // Run in a new session, seeding model/effort via setup entries so the
  // plan session picks up the configuration without mutating global state.
  await ctx.newSession({
    setup: async (sm) => {
      if (desiredModel) {
        const slash = desiredModel.indexOf("/");
        if (slash >= 0) {
          sm.appendModelChange(
            desiredModel.slice(0, slash),
            desiredModel.slice(slash + 1),
          );
        }
      }
      if (desiredEffort) {
        sm.appendThinkingLevelChange(desiredEffort);
      }
    },
    withSession: async (planCtx) => {
      // ── ralpix_ask_question ──────────────────────────────────────
      planCtx.registerTool({
        name: "ralpix_ask_question",
        label: "Ask User Question",
        description:
          "Ask the user a clarifying question during plan creation. " +
          "Use this when you need to understand requirements, preferences, " +
          "or constraints before writing the plan.",
        promptSnippet: "Ask user: {{question}}",
        parameters: Type.Object({
          question: Type.String({
            description: "The question to ask the user",
          }),
          options: Type.Array(Type.String(), {
            description: "Answer options for the user to pick from",
          }),
        }),
        async execute(_toolCallId, params) {
          const question = params.question as string;
          const options = params.options as string[];

          const answer = await ctx.ui.select(question, options);

          if (!answer) {
            // User cancelled
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

      // ── ralpix_submit_plan_draft ──────────────────────────────────
      planCtx.registerTool({
        name: "ralpix_submit_plan_draft",
        label: "Submit Plan Draft",
        description:
          "Submit a plan draft for user review. The user will accept, " +
          "request revisions, or reject. If revisions are requested, " +
          "update the plan and call this tool again.",
        promptSnippet: "Submit plan draft for review",
        parameters: Type.Object({
          planContent: Type.String({
            description: "The complete plan in ralpix markdown format",
          }),
        }),
        async execute(_toolCallId, params) {
          const content = params.planContent as string;

          // Show review chooser
          const reviewChoice = await ctx.ui.select(
            "Review the plan draft:",
            ["✓ Accept — save and finish", "↻ Revise — provide feedback", "✗ Reject — discard the plan"],
          );

          // Handle "revise"
          if (reviewChoice?.includes("Revise")) {
            const feedback = await ctx.ui.input(
              "What changes would you like?",
              "Add more details, change approach, fix issues...",
            );

            return {
              content: [
                {
                  type: "text",
                  text: feedback
                    ? `User requested revisions: ${feedback}`
                    : "User requested revisions (no specific feedback provided).",
                },
              ],
              details: { action: "revise", feedback: feedback || "" },
            };
          }

          // Handle "accept"
          if (reviewChoice?.includes("Accept")) {
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

          // Handle "reject" (or cancelled)
          lastAction = "reject";

          return {
            content: [
              { type: "text", text: "Plan rejected by user." },
            ],
            details: { action: "reject" },
          };
        },
      });

      // ── Send prompt and wait ─────────────────────────────────────
      await planCtx.sendUserMessage(prompt);
      await planCtx.waitForIdle();
    },
  });

  // ── After session: handle results ─────────────────────────────────

  if (lastAction === "reject") {
    ctx.ui.notify("Plan creation cancelled (user rejected)", "warning");
    return null;
  }

  if (!planContent) {
    ctx.ui.notify(
      "Plan creation failed — model did not submit a plan draft",
      "error",
    );
    return null;
  }

  // Determine plan path
  const plansDir = resolve(ctx.cwd, config.plansDir || "docs/plans");
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
    if (!overwrite) {
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

  if (execute?.includes("Execute")) {
    return planPath;
  }

  return null;
}
