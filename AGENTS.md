# AGENTS.md

This file is for coding agents working in this repository.

## Purpose

`ralpix` is a TypeScript extension for `pi` that:

- creates markdown implementation plans interactively
- executes plan tasks in isolated `pi` sessions
- runs review/finalization phases after task execution

Most changes here affect orchestration, prompts, or config behavior. Treat small edits as potentially system-wide.

## Repo Map

Start with the smallest relevant surface:

- `index.ts` — extension entry point, `/ralpix` command registration, top-level run orchestration, branch guardrail (`maybeSwitchBranch`)
- `brainstorm.ts` — interactive brainstorm phase (understand → explore → design → complete)
- `executor.ts` — task execution flow
- `planner.ts` — interactive plan creation flow
- `reviewer.ts` — review pipeline
- `tui.ts` — shared TUI components: `ProgressPanel`, `createProgressTui`, `createTokenLedger`
- `parser.ts` — ralpix markdown plan parsing
- `config.ts` — config initialization and layered config loading
- `prompt.ts` — prompt loading/template expansion
- `logger.ts` — progress logging
- `types.ts` — shared types
- `bundled/prompts/*` — default prompts shipped with the extension
- `bundled/agents/*` — bundled review-agent definitions
- `bundled/config.json` — shipped defaults
- `docs/plans/*` — design and implementation plans for existing features
- `README.md` — user-facing behavior and documented plan/config format

## Working Rules

- Read `README.md` before changing user-visible behavior.
- Preserve the documented plan format unless the task explicitly changes the format and its docs.
- Keep config semantics stable: bundled defaults, then `~/.ralpix/config.json`, then `./.ralpix/config.json`.
- Be careful with changes to prompts in `bundled/prompts/`; prompt wording is part of runtime behavior.
- Prefer focused edits. This repo is small enough to understand, but avoid broad refactors unless needed.
- Do not edit generated or vendored dependencies under `node_modules/`.

## Agent Workflow

1. Identify which subsystem the change belongs to before editing.
2. Read the minimal relevant files, then confirm how the behavior is described in `README.md`.
3. Implement the smallest change that preserves existing contracts.
4. If behavior changes, update docs or bundled assets in the same pass.
5. Run validation before claiming success.

For common tasks:

- command routing or run lifecycle: start in `index.ts`
- brainstorm phase: start in `brainstorm.ts` + `bundled/prompts/brainstorm.md`
- plan parsing issues: start in `parser.ts`
- plan creation UX: start in `planner.ts`
- task execution behavior: start in `executor.ts`
- review loop behavior: start in `reviewer.ts`
- TUI panel behavior: start in `tui.ts`; callers are `brainstorm.ts`, `planner.ts`, `executor.ts`
- prompt/template bugs: start in `prompt.ts` plus the relevant file in `bundled/prompts/`
- config issues: start in `config.ts` and `bundled/config.json`

## Validation

Use these commands from the repo root:

```bash
npm run lint
npm run typecheck
npm run check
```

`npm run check` is the main pre-finish validation because it runs lint and typecheck together.

If a change touches parsing, execution, review, or config behavior, also verify the affected flow against:

- `README.md`
- relevant files in `docs/plans/`
- relevant bundled prompts or agents

## Change Guardrails

- Avoid silently changing command semantics for `/ralpix`, `/ralpix init`, or `/ralpix plan`.
- Avoid breaking isolated per-task execution assumptions.
- Avoid introducing config keys or prompt variables without updating the shipped defaults and docs.
- Keep ESM/TypeScript conventions consistent with the existing codebase.
- Prefer backward-compatible changes unless the task explicitly requires a breaking change.

## Done Criteria

Before finishing, ensure:

- the change is scoped to the intended subsystem
- docs are updated if user-visible behavior changed
- `npm run check` passes, or any failure is explained clearly

