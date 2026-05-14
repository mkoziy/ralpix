# Design: Interactive Plan Creation

## Overview

Add `/ralpix plan <description>` command that creates ralpix-format implementation plans through interactive dialogue with the AI model. The model explores the codebase, asks clarifying questions, generates a plan draft, and iterates on user feedback — all within a single pi session using registered tools.

Inspired by ralphex's `--plan` flag, but implemented natively for the pi extension SDK using tool-based interaction instead of stdout signal parsing.

## Motivation

Writing plans manually is the biggest friction point for "get shit done" mode. Users should be able to say what they want and get a complete, well-structured plan ready for execution — without writing a single line of markdown.

## Architecture

### Command

```
/ralpix plan "add caching for API responses"
```

### Flow

1. **Init:** Load config, create progress logger, validate description
2. **Session:** `ctx.newSession()` with model, register two tools
3. **Exploration:** Model reads codebase, asks clarifying questions via `ralpix_ask_question`
4. **Draft:** Model generates plan in ralpix format, submits via `ralpix_submit_plan_draft`
5. **Review:** User accepts, revises (with feedback), or rejects — model iterates
6. **Save:** Accepted plan written to `docs/plans/<name>.md`
7. **Execute:** Option to immediately execute the created plan

### Tools

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `ralpix_ask_question` | `question: string`, `options: string[]` | Shows `ctx.ui.select()`, returns chosen answer to model |
| `ralpix_submit_plan_draft` | `planContent: string` | Shows plan to user via `ctx.ui.confirm()`, returns `{ action: "accept" | "revise" | "reject", feedback?: string }` |

### Session Flow

```
ctx.newSession({ withSession: async (planCtx) => {
  // Register tools
  planCtx.registerTool("ralpix_ask_question", ...)
  planCtx.registerTool("ralpix_submit_plan_draft", ...)

  // Send plan creation prompt
  await planCtx.sendUserMessage(planCreationPrompt)

  // Wait for model to finish
  await planCtx.waitForIdle()

  // Check result
  // ...
}})
```

### Plan File Naming

Generated from description: `"add caching for API"` → `docs/plans/add-caching-for-api.md`

## Configuration

New optional field:

```jsonc
{ "plansDir": "docs/plans" }  // Directory for created plans
```

## New Files

| File | Purpose |
|------|---------|
| `bundled/prompts/plan-creation.md` | System prompt for plan creation with instructions for tools |
| `planner.ts` | `runPlanCreation()` — orchestrator for the entire plan creation flow |

## Changes to Existing Files

| File | Changes |
|------|---------|
| `index.ts` | Add plan creation branch in `/ralpix` handler, register new tools |
| `types.ts` | Add `plansDir` to `RalpixConfig` |
| `bundled/config.json` | Add `plansDir` default |
| `config.ts` | Add `plansDir` to loadConfig, init |
| `logger.ts` | Minor: log plan creation phase |

## Out of Scope (YAGNI)

- fzf-based plan selection (pi extension API constraints)
- `$EDITOR` draft editing
- stdout signal parsing (QUESTION/PLAN_DRAFT)
- Multi-round spawn approach
- Auto-continue to execution in the same session (offer explicit choice instead)

## Error Handling

- Empty description → error, show usage
- Model fails to generate plan → error logged, user notified
- User rejects plan → clean exit, nothing saved
- Plan file already exists → ask to overwrite
- plansDir doesn't exist → create it
