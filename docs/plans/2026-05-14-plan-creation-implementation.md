# Interactive Plan Creation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `/ralpix plan <description>` command — model explores codebase, asks questions, generates plan draft, iterates on feedback.

**Architecture:** New `planner.ts` module with `runPlanCreation()`. Uses `ctx.newSession()` with two registered tools (`ralpix_ask_question`, `ralpix_submit_plan_draft`). Plan creation prompt lives in `bundled/prompts/plan-creation.md`.

**Tech Stack:** TypeScript, pi ExtensionAPI (newSession, registerTool, ui.select, ui.confirm)

---

### Task 1: Add plansDir config field

**Files:**
- Modify: `types.ts`
- Modify: `bundled/config.json`
- Modify: `config.ts`

**Step 1: Add to RalpixConfig**

In `types.ts`, add after `movePlanOnCompletion`:

```typescript
  /** Directory for created/stored plan files */
  plansDir: string;
```

**Step 2: Add default**

In `bundled/config.json`, add:

```jsonc
  "plansDir": "docs/plans"
```

**Step 3: Load in config.ts**

In `loadConfig()`, the merge logic already handles flat fields. No special loading needed — the field is read as-is from config.

In `initRalpixHome()`, ensure `plansDir` survives through config copy (it's in bundled defaults already).

**Step 4: Commit**

```bash
git add types.ts bundled/config.json config.ts
git commit -m "feat: add plansDir config field"
```

---

### Task 2: Create plan-creation.md prompt

**Files:**
- Create: `bundled/prompts/plan-creation.md`

**Step 1: Write prompt**

```markdown
# Plan Creation

You are creating an implementation plan for a software project.

## Request
{{DESCRIPTION}}

## Instructions

### Phase 1: Explore
1. Read the project's README.md to understand what this project is
2. Explore key source files to understand the codebase structure
3. Read package.json (or equivalent) to understand dependencies
4. Identify patterns, conventions, and architecture

### Phase 2: Clarify
Use the `ralpix_ask_question` tool to ask the user clarifying questions:
- What approach should you take? (if multiple options exist)
- Any constraints or preferences?
- Specific libraries or patterns to use/avoid?

**Be concise.** Ask at most 2-3 questions. Group related questions. Only ask when genuinely uncertain.

### Phase 3: Draft
Generate a complete implementation plan in ralpix format. The plan must follow this exact structure:

```markdown
# Plan: <Concise Title>

## Overview
<2-3 sentences describing what this plan achieves>

## Validation Commands
- `<test command>`
- `<lint command>`

### Task 1: <Title>
- [ ] <Specific checklist item>
- [ ] <Specific checklist item>

### Task 2: <Title>
- [ ] <Specific checklist item>
```

Rules:
- Tasks should be small, concrete, and independently valuable
- Each task has 2-5 checklist items
- Include `## Validation Commands` with test/lint commands
- Use `- [ ]` for all items (pending state)
- Tasks are in dependency order (earlier tasks don't depend on later ones)

### Phase 4: Submit
Call `ralpix_submit_plan_draft` with the complete plan text.
The user will accept, request revisions, or reject.
If revisions are requested, apply the feedback and call `ralpix_submit_plan_draft` again.
```

**Step 2: Add to init list**

In `config.ts` `initRalpixHome()`, add `"plan-creation"` to the prompts array.

**Step 3: Commit**

```bash
git add bundled/prompts/plan-creation.md config.ts
git commit -m "feat: add plan-creation.md prompt template"
```

---

### Task 3: Create planner.ts module

**Files:**
- Create: `planner.ts`

**Step 1: Implement runPlanCreation**

```typescript
/**
 * Interactive plan creation — model explores codebase, asks questions,
 * generates a plan draft, and iterates on user feedback.
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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Public API (called from index.ts)
// ---------------------------------------------------------------------------

/**
 * Run interactive plan creation in a new pi session.
 * Registers tools for asking questions and submitting plan drafts.
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

  // Prepare result variable (captured from tool call)
  let planContent: string | null = null;
  let lastAction: string | null = null;

  // Run in a new session
  await ctx.newSession({
    withSession: async (planCtx) => {
      // ---- Register ask_question tool ----
      planCtx.registerTool({
        name: "ralpix_ask_question",
        label: "Ask User Question",
        description: "Ask the user a clarifying question during plan creation",
        promptSnippet: "Ask user: {{question}}",
        parameters: Type.Object({
          question: Type.String({ description: "The question to ask" }),
          options: Type.Array(Type.String(), {
            description: "Options for the user to choose from",
          }),
        }),
        async execute(_toolCallId, params) {
          const answer = await ctx.ui.select(
            params.question as string,
            (params.options as string[]).map((o: string) => ({
              id: o,
              label: o,
              subtitle: undefined,
            })),
          );
          return {
            content: [{ type: "text", text: `User selected: ${answer}` }],
            details: { answer },
          };
        },
      });

      // ---- Register submit_plan_draft tool ----
      planCtx.registerTool({
        name: "ralpix_submit_plan_draft",
        label: "Submit Plan Draft",
        description: "Submit a plan draft for user review",
        promptSnippet: "Submit plan draft for review",
        parameters: Type.Object({
          planContent: Type.String({ description: "The complete plan in ralpix markdown format" }),
        }),
        async execute(_toolCallId, params) {
          const content = params.planContent as string;

          // Show the draft to the user
          const reviewChoice = await ctx.ui.select(
            "Review the plan draft:",
            [
              { id: "accept", label: "✓ Accept", subtitle: "Save and finish" },
              { id: "revise", label: "↻ Revise", subtitle: "Provide feedback for changes" },
              { id: "reject", label: "✗ Reject", subtitle: "Discard the plan" },
            ],
          );

          if (reviewChoice === "revise") {
            const feedback = await ctx.ui.prompt(
              "What changes would you like?",
              "",
            );
            return {
              content: [
                {
                  type: "text",
                  text: feedback
                    ? `User requested revisions: ${feedback}`
                    : "User requested revisions (no specific feedback)",
                },
              ],
              details: { action: "revise", feedback },
            };
          }

          if (reviewChoice === "accept") {
            planContent = content;
            lastAction = "accept";
            return {
              content: [{ type: "text", text: "Plan accepted! The user approved the plan draft." }],
              details: { action: "accept" },
            };
          }

          // reject
          lastAction = "reject";
          return {
            content: [{ type: "text", text: "Plan rejected by user." }],
            details: { action: "reject" },
          };
        },
      });

      // ---- Send the prompt and wait ----
      await planCtx.sendUserMessage(prompt);
      await planCtx.waitForIdle();
    },
  });

  // ---- After session: handle results ----

  if (lastAction === "reject") {
    ctx.ui.notify("Plan creation cancelled (user rejected)", "warning");
    return null;
  }

  if (!planContent) {
    ctx.ui.notify("Plan creation failed — model did not submit a plan draft", "error");
    return null;
  }

  // Determine plan filename from description
  const plansDir = resolve(ctx.cwd, config.plansDir || "docs/plans");
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  const planName = slugify(description);
  const planPath = join(plansDir, `${planName}.md`);

  // Check if already exists
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

  // Write plan to file
  writeFileSync(planPath, planContent, "utf-8");
  ctx.ui.notify(`Plan saved to ${planPath}`, "success");

  // Offer to execute
  const execute = await ctx.ui.select(
    "Plan created. What next?",
    [
      { id: "execute", label: "▶ Execute plan now", subtitle: `Run /ralpix ${planPath}` },
      { id: "done", label: "✓ Done", subtitle: "Exit, execute later" },
    ],
  );

  if (execute === "execute") {
    return planPath; // Caller will execute
  }

  return null;
}
```

**Step 2: Commit**

```bash
git add planner.ts
git commit -m "feat: add planner.ts with runPlanCreation()"
```

---

### Task 4: Integrate into index.ts

**Files:**
- Modify: `index.ts`

**Step 1: Import planner**

Add import at top:

```typescript
import { runPlanCreation } from "./planner.js";
```

**Step 2: Add plan creation branch**

In the `/ralpix` command handler, BEFORE the `init` check and path execution, add:

```typescript
// Check for "plan <description>" subcommand
if (trimmed.startsWith("plan ")) {
  const description = trimmed.slice(5).trim();
  if (!description) {
    ctx.ui.notify("Usage: /ralpix plan <description>", "error");
    return;
  }
  const planPath = await runPlanCreation(description, ctx, pi, config);
  if (planPath) {
    // User chose to execute — run the plan
    await runPlan(planPath, ctx, pi);
  }
  return;
}
```

Insert right after `const trimmed = (args ?? "").trim();` and BEFORE `if (!trimmed || trimmed === "init")`.

**Step 3: Verify integration**

Check that the command routing is:
1. `plan <desc>` → plan creation
2. `init` → init ralpix home
3. `<path>` → execute existing plan

**Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: integrate /ralpix plan command into extension"
```

---

### Task 5: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add plan creation section**

After the Quick Start section, add:

```markdown
## Plan Creation

Instead of writing plans manually, use interactive plan creation:

```bash
/ralpix plan "add JWT authentication to the API"
```

The model will:
1. Explore your codebase to understand project structure
2. Ask clarifying questions (pick from options)
3. Generate a plan draft in ralpix format
4. Show it for your review: Accept / Revise / Reject
5. Save to `docs/plans/` and offer to execute immediately

**Requirements:** Your project must have a `README.md` and source files for the model to explore.
```

**Step 2: Update command list**

Add to the commands section:

```
/ralpix plan <description>  — Create a plan interactively
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document plan creation command"
```

---

### Task 6: End-to-end verification

**Files:**
- None (manual test)

**Step 1: Setup test repo**

```bash
cd /tmp
mkdir ralpix-plan-test && cd ralpix-plan-test
git init && git commit --allow-empty -m "init"
echo "# Test Project" > README.md
mkdir src
echo 'console.log("hello");' > src/index.ts
git add -A && git commit -m "initial codebase"
```

**Step 2: Run plan creation**

```bash
# In pi session:
/ralpix plan "add a greeting function that takes a name parameter"
```

**Step 3: Verify**

- [ ] Model asks clarifying questions (or not, if description is clear)
- [ ] Model submits a plan draft
- [ ] Accept → plan saved to `docs/plans/add-a-greeting-function.md`
- [ ] Plan has correct format: `# Plan:`, `## Overview`, `## Validation Commands`, `### Task N:`
- [ ] Choice to execute immediately works

**Step 4: Test revise flow**

- [ ] Run again, choose "Revise" at draft review
- [ ] Enter feedback: "add TypeScript types"
- [ ] Model resubmits with types included

**Step 5: Test reject flow**

- [ ] Run again, choose "Reject" at draft review
- [ ] No file created, clean exit

---

## Summary

| Task | Files | Effort |
|------|-------|--------|
| 1. Config field | types.ts, bundled/config.json, config.ts | Small |
| 2. Prompt template | bundled/prompts/plan-creation.md | Small |
| 3. Planner module | planner.ts (new) | Large |
| 4. Integration | index.ts | Small |
| 5. Documentation | README.md | Small |
| 6. E2E verification | — | Medium |
