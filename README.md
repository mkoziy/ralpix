# ralpix

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)

Autonomous plan execution extension for [pi](https://github.com/earendil-works/pi-coding-agent). Write a markdown plan — ralpix executes every task hands-off, each in a fresh `pi` session, then runs a multi-model review pipeline before it calls it done.

Inspired by [ralphex](https://github.com/umputun/ralphex).

---

## Features

- **Isolated task execution** — each task gets a clean `pi` session; no context bleed between tasks
- **Auto-commit** — commits after every successful task with a configurable message template
- **Branch guardrail** — warns when you're on `main`/`master` before executing a plan and offers to create a feature branch
- **Interactive brainstorm phase** — collaborative Q&A to explore approaches and validate design before writing a plan
- **Interactive plan creation** — describe a feature in one line, get a validated markdown plan back
- **Multi-model review pipeline** — first pass (5 parallel agents) → optional external review (different provider) → second pass (critical issues only)
- **Readable live transcript** — append-only session history in the main transcript, plus a compact sticky summary shared across brainstorm, plan creation, execution, and review
- **Stalemate detection** — exits the external review loop when two models keep disagreeing, saving tokens
- **Three-layer config** — bundled defaults → `~/.ralpix/config.json` → `./.ralpix/config.json`
- **Prompt customization** — override any prompt globally or per-project
- **Progress logs** — structured, timestamped log of every step written to `.ralpix/progress/`

---

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Plan Format](#plan-format)
- [Brainstorm](#brainstorm)
- [Plan Creation](#plan-creation)
- [Standalone Review](#standalone-review)
- [Configuration](#configuration)
  - [Config reference](#config-reference)
  - [Per-project config](#per-project-config)
  - [Pi profile for subprocesses](#pi-profile-for-subprocesses)
- [Prompt Customization](#prompt-customization)
  - [Template variables](#template-variables)
  - [External review phase](#external-review-phase)
  - [Choosing review models](#choosing-review-models)
- [Progress Logs](#progress-logs)
- [Directory Structure](#directory-structure)
- [Examples](#examples)
- [Architecture](#architecture)
- [Release](#release)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

```bash
# 1. Initialize ralpix — creates ~/.ralpix/ with default prompts, agents, and config
/ralpix init

# Running init again asks whether to overwrite existing files,
# or just create any missing ones (e.g. after an update added new prompts)
/ralpix init

# 2a. Brainstorm first, then create a plan (recommended for new features)
/ralpix brainstorm "add health check endpoint"

# 2b. Create a plan directly
/ralpix plan "add health check endpoint"

# 2c. Or write a plan manually and execute it directly
/ralpix docs/plans/my-feature.md

# 3. Review code without a plan
/ralpix review
```

What happens when you execute a plan:

1. If you're on `main` or `master`, ralpix offers to create a feature branch (e.g. `ralpix/20260523-add-health-check`)
2. Plan is parsed into tasks
3. Each task runs in an isolated `pi` session seeded from the merged ralpix config
4. A task counts as successful only if the agent reports `Success: true` and the host did not observe any tool failures or a non-zero child exit
5. Auto-commit after each successful task
6. Progress is logged to per-phase JSONL files under `./.ralpix/progress/{execute,review}/`
7. After all tasks: review pipeline runs (first pass → optional external review → second pass)
8. Plan checkboxes are updated automatically

---

## Installation

**Option 1 — symlink from source (recommended for development):**

```bash
git clone https://github.com/mkoziy/ralpix
ln -s "$(pwd)/ralpix" ~/.pi/agent/extensions/ralpix
```

**Option 2 — pi install (coming soon):**

```bash
pi install git:github.com/mkoziy/ralpix
```

After installing from source, run `npm ci` inside the extension directory:

```bash
cd ~/.pi/agent/extensions/ralpix
npm ci
```

---

## Plan Format

ralpix plans are plain markdown files. The format is intentionally flexible — add rich context sections when they help the implementer:

```markdown
# Plan: My Feature

## Overview
Brief description of what this plan achieves.

## Context
Files/components involved, existing patterns, dependencies.

## Design Decisions
- BadgerDB for durable storage
- Claim-based pull for natural load spreading

## Key Layout
```
job:{queue}:{ulid}  → JSON: {payload, status, ...}
queue:{queue}:pending:{ulid} → "" (index)
```

## Invariants
- Every reserved key must have a corresponding job record
- The sweeper cross-checks to catch crash-orphaned records

## Auth
Admin API: HTTP Basic Auth. Worker API: Bearer token.

## API Surface
```
POST /queues/{queue}/jobs   schedule
GET  /queues/{queue}/next   claim next job
```

## Success Criteria
- [ ] Feature works
- [ ] Tests pass

### Task 1: Set up the foundation
**Files:**
- Create: `src/store.ts`
- Modify: `src/config.ts`

- [ ] Create module structure
- [ ] Write interface definitions
- [ ] Write tests for store initialization

### Task 2: Implement core logic
**Files:**
- Create: `src/engine.ts`
- Create: `src/engine_test.ts`

- [ ] Write main algorithm
- [ ] Add error handling
- [ ] Write tests for success and error cases
```

Rules:

| Element | Required | Description |
|---------|----------|-------------|
| `# Plan: <Title>` | Yes | Plan title, injected into prompts |
| `## Overview` | No | Description injected into every task prompt |
| `## Context` | No | Codebase findings, patterns, dependencies |
| `## Design Decisions` | No | Why this approach over alternatives |
| `## Key Layout` | No | Data structures, schemas, storage layouts |
| `## Invariants` | No | Rules that must hold across all tasks |
| `## Auth / Security` | No | Auth model, permission rules |
| `## API Surface` | No | Endpoints, methods, request/response shapes |
| `## Testing Strategy` | No | Unit vs integration vs e2e expectations |
| `## Success Criteria` | No | Overall success checklist |
| `### Task N: <Title>` | Yes | One section per task |
| `**Files:**` | No | Files to create or modify in this task |
| `- [ ]` / `- [x]` | No | Checkboxes; if absent, the entire task description is treated as one item |

**Arbitrary `##` sections are preserved.** Any heading not listed above is captured and injected into every task prompt as additional context. This lets you add `## Deployment Notes`, `## Rollback Plan`, or any other section the implementer needs.

---

## Brainstorm

Before writing a plan, explore the problem space with a collaborative design dialogue:

```bash
/ralpix brainstorm "add JWT authentication to the API"
```

The brainstorm phase runs in four stages, driven by an AI design partner:

1. **Understand** — Asks clarifying questions (one at a time) about purpose, constraints, and integration points
2. **Explore Approaches** — Proposes 2-3 approaches with trade-offs after enough context is gathered
3. **Design** — Breaks the chosen approach into sections (architecture, components, data flow, error handling, testing), presenting one at a time for your validation
4. **Complete** — Summarizes the validated design into a structured context string

You control the flow — answer questions, pick an approach, validate or reject design sections. There is no fixed question limit; the AI transitions between phases when it has enough context. A safety cap of 15 rounds prevents runaway subprocesses.

If a brainstorm is interrupted or a subprocess fails, ralpix saves an unfinished checkpoint under `.ralpix/progress/brainstorm/`. The next brainstorm start shows a picker of unfinished sessions plus `Start new brainstorm`, so you can resume from the last confirmed Q&A/approach/design state. Completed brainstorms are hidden from the picker. If you delete an old unfinished checkpoint file manually, it disappears from the picker.

After completion, ralpix offers to create a plan using the brainstorm context. The design decisions, selected approach, and validated sections are injected into the plan creation prompt so the generated plan is grounded in the work you just did.

When `brainstormEnabled: true` (default), creating a plan directly with `/ralpix plan` also offers the brainstorm phase first.

## Standalone Review

Review branch changes or uncommitted code without creating a plan:

```bash
/ralpix review
```

You'll be asked interactively:
1. **What to review** — branch diff vs main, uncommitted changes, or both
2. **Mode** — review-only (report findings, no code changes) or review-and-fix (same pipeline as plan execution)

The review uses the same multi-model pipeline as plan execution:
- **First pass** — 5 parallel agents comprehensively review all changes
- **External review** (if enabled) — independent model finds issues
- **Second pass** — focused re-review for remaining critical/major issues

Progress is logged to `.ralpix/progress/review/<session>.jsonl`.

Use this when you want a fresh set of eyes on a PR, a quick sanity check before committing, or an independent audit of uncommitted work.

## Plan Creation

Skip writing plans by hand — describe what you want and ralpix creates the plan for you:

```bash
/ralpix plan "add JWT authentication to the API"
```

You can also update an existing plan by pointing to its file:

```bash
/ralpix plan docs/plans/20260523-jwt-auth.md "add refresh token rotation"
```

ralpix loads the existing plan, treats your description as revision instructions, and generates an updated draft. The original file is overwritten once you accept.

If you pass only an existing plan path with no extra instructions, ralpix treats it as a reopen flow instead of creating a new draft. Paths prefixed with `@` such as `@docs/plans/20260523-jwt-auth.md` are treated the same way.

The model will:

1. **Ask clarifying questions** in the UI when needed (option picker + free-form answer)
2. **Generate a plan draft** in ralpix format — optionally enriched with `## Context`, `## Design Decisions`, `## Key Layout`, `## Invariants`, `## API Surface`, and other sections when they help the implementer
3. **Validate** the draft structure before saving
4. **Save** it to `docs/plans/YYYYMMDD-<plan-title>.md`
5. **Pause for review** — Accept, Revise (with feedback), Reload after editing the file elsewhere, or Reject
6. **Offer AI plan review** after you accept — a plan-review agent plus a critic agent inspect the saved plan for over-engineering, missing tests, weak assumptions, and convention mismatches
7. **Auto-revise from review feedback** when those agents find issues — the planner rewrites the saved draft automatically, then returns control with the updated file
8. **Offer execution** only after you explicitly accept (or skip review)

The saved file is the source of truth, so you can inspect or edit it in any editor before continuing.

---

## Configuration

ralpix uses a three-layer merge — each layer overrides the one above:

| Layer | Path | Purpose |
|-------|------|---------|
| Bundled | Inside extension | Shipped defaults |
| Global | `~/.ralpix/config.json` | Your personal defaults |
| Project | `./.ralpix/config.json` | Per-project overrides |

### Config reference

```jsonc
// ~/.ralpix/config.json
{
  "defaultModel": "opencode-go/deepseek-v4-flash",  // Task execution model
  "defaultProvider": null,                            // e.g. "anthropic"
  "defaultEffort": "low",          // Reasoning effort (low/medium/high)
  "piAgentDir": null,              // Override default ~/.ralpix/pi-agent profile
  "commitEnabled": true,           // Auto-commit after each task
  "commitMessageTemplate": "ralpix: {{taskTitle}}",
  "reviewEnabled": true,           // Run review pipeline after tasks
  "reviewFirstModel": "opencode-go/glm-5.1",
  "reviewSecondModel": "opencode-go/kimi-k2.6",
  "reviewFirstEffort": "high",
  "reviewSecondEffort": "medium",
  "maxRetries": 2,                 // Max retries per task on failure
  "reviewMaxRetries": 1,           // Max retries per review session on failure
  "reviewTimeoutMs": 1800000,      // Max ms per review session (default: 30 min)
  "brainstormTimeoutMs": 600000,   // Max ms per brainstorm round (default: 10 min)
  "reviewMaxIterations": 10,
  "brainstormEnabled": true,
  "brainstormModel": "opencode-go/glm-5.1",
  "brainstormEffort": "medium",
  "externalReviewEnabled": true,
  "externalReviewModel": "openai-codex/gpt-5.5",
  "externalReviewEffort": "medium",
  "externalReviewMaxIterations": 10,
  "externalReviewPatience": 3,     // Exit after N unchanged rounds (stalemate)
  "planModel": "openai-codex/gpt-5.5",
  "planEffort": "medium",
  "plansDir": "docs/plans",        // Directory for created/stored plan files
  "epistemicEnabled": true,        // Inject temporal context + verification rules into every subprocess
  "trainingCutoff": "2025-01-01",  // Model knowledge cutoff (YYYY-MM-DD)
  "highRiskLibraries": [            // Libraries that frequently break APIs
    "next", "react", "langchain",
    "openai", "anthropic", "pydantic",
    "fastapi", "prisma"
  ]
}
```

Provider notes:

- `openai/...` — plain OpenAI provider, requires `OPENAI_API_KEY`
- `openai-codex/...` — ChatGPT Plus/Pro Codex OAuth, requires `/login` inside `pi`
- `opencode-go/...` — OpenCode Go provider, requires `OPENCODE_API_KEY`

### Per-project config

Create `./.ralpix/config.json` at your project root:

```jsonc
{
  "commitEnabled": false,
  "reviewEnabled": false,
  "defaultModel": "openai/gpt-5",
  "piAgentDir": ".ralpix/pi-agent"  // Relative to project root
}
```

### Pi profile for subprocesses

`/ralpix init` creates a dedicated Pi profile for child sessions at `~/.ralpix/pi-agent/`. ralpix exports this directory as `PI_CODING_AGENT_DIR` for task, review, and plan subprocesses.

Set `piAgentDir` only when you want to override the default. Paths resolve relative to the project root unless absolute or starting with `~/`.

Default layout after `/ralpix init`:

```
~/.ralpix/
├── config.json
├── prompts/
├── agents/
└── pi-agent/
    ├── AGENTS.md
    ├── auth.json -> ~/.pi/agent/auth.json   # Symlink — shares credentials
    └── settings.json
```

---

## Prompt Customization

ralpix ships default prompts that you can override globally or per-project:

```
~/.ralpix/
└── prompts/
    ├── brainstorm.md        # Pre-plan design dialogue
    ├── task-default.md      # Runs for each task
    ├── review-first.md      # First review pass (5 agents)
    ├── review-second.md     # Second review pass
    ├── plan-creation.md     # Interactive plan creation
    ├── external-review.md   # External reviewer prompt
    ├── external-eval.md     # Main model evaluates external findings
    └── finalize.md          # Final summary

~/.ralpix/agents/
    ├── quality.md           # Correctness, security, edge cases
    ├── implementation.md    # Goal alignment
    ├── testing.md           # Test coverage
    ├── simplification.md    # Over-engineering detection
    ├── documentation.md     # Docs review
    └── epistemic.md         # Version/API anti-hallucination rules
```

To override per-project:

```bash
mkdir -p .ralpix/prompts
cp ~/.ralpix/prompts/task-default.md .ralpix/prompts/task-default.md
# Edit .ralpix/prompts/task-default.md
```

### Template variables

| Variable | Description |
|----------|-------------|
| `{{DESCRIPTION}}` | User's one-line plan description (plan creation) |
| `{{BRAINSTORM_CONTEXT}}` | Accumulated design dialogue from brainstorm phase (plan creation) |
| `{{OVERVIEW}}` | Plan overview text |
| `{{TASK_TITLE}}` | Current task title |
| `{{TASK_DESCRIPTION}}` | Task description + checklist |
| `{{GOAL}}` | Plan title (review prompts) |
| `{{PROGRESS_FILE}}` | Path to append-only JSONL progress log |
| `{{DEFAULT_BRANCH}}` | Main/master branch name |
| `{{DIFF_COMMANDS}}` | Git diff commands for reviewer context gathering |
| `{{FIX_INSTRUCTIONS}}` | Fix step instructions (varies by review mode) |
| `{{FINDINGS}}` | External reviewer findings (for eval prompt) |
| `{{agent:name}}` | Inline agent content, e.g. `{{agent:quality}}` |

### External review phase

Between first and second review, ralpix can run an **external review** — an independent pass by a different model/provider, catching blind spots that single-model review misses.

How it works:

1. The `externalReviewModel` reviews the diff and reports findings
2. Your `defaultModel` evaluates each finding, fixes confirmed issues, and commits
3. The loop repeats until clean, stalemate (`externalReviewPatience` consecutive unchanged rounds), or `externalReviewMaxIterations`

Diff scope: first iteration reviews the full branch diff (`git diff main...HEAD`); subsequent iterations review only uncommitted changes from the previous fix round.

Example config:

```jsonc
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",
  "externalReviewMaxIterations": 10,
  "externalReviewPatience": 3
}
```

### Choosing review models

```jsonc
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "reviewFirstModel": "openai/gpt-5",           // Broad analysis
  "reviewSecondModel": "anthropic/claude-sonnet-4-5"  // Focused review
}
```

---

## Progress Logs

All progress is logged as append-only JSONL under `./.ralpix/progress/`:

- Brainstorm: `.ralpix/progress/brainstorm/<session>.jsonl`
- Plan creation: `.ralpix/progress/plan/<session>.jsonl`
- Plan execution: `.ralpix/progress/execute/<session>.jsonl`
- Review: `.ralpix/progress/review/<session>.jsonl`

Each line is one complete `AgentEvent` object:

```typescript
interface AgentEvent {
  type: string;
  phase: "brainstorm" | "plan" | "execute" | "review";
  createdAt: string;
  // event-specific fields
}
```

Usage events store numeric token and pricing data for future parsing:

```typescript
interface JsonlUsageData {
  step?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost: number;
  };
  total?: {
    input: number;
    output: number;
    cost: number;
  };
  breakdown?: Array<{
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost: number;
  }>;
}
```

Example lines:

```json
{"type":"task_start","phase":"execute","createdAt":"2026-05-12T14:30:05.123Z","taskId":"task-1","taskNumber":1,"taskTitle":"Set up the foundation","itemCount":3}
{"type":"attempt_end","phase":"execute","createdAt":"2026-05-12T14:32:10.457Z","taskId":"task-1","attempt":1,"success":true,"usage":{"step":{"input":8200,"output":1100,"cacheRead":4100,"cacheWrite":0,"cost":0.084},"total":{"input":12300,"output":1100,"cost":0.084}}}
{"type":"stage_start","phase":"review","createdAt":"2026-05-12T14:45:00.000Z","stage":"first-pass","detail":"checking all completed tasks"}
{"type":"stage_finish","phase":"review","createdAt":"2026-05-12T14:48:00.001Z","stage":"second-pass","status":"complete","usage":{"step":{"input":6100,"output":900,"cacheRead":2100,"cacheWrite":0,"cost":0.052},"total":{"input":8200,"output":900,"cost":0.052}}}
```

These logs are intended to be machine-readable first: they are append-only, preserve raw token and pricing data, and are suitable for future HTML/report generation.

---

## Directory Structure

```
~/.pi/agent/extensions/ralpix/      # Extension (read-only bundled defaults)
├── bundled/
│   ├── config.json
│   ├── prompts/
│   └── agents/

~/.ralpix/                           # Global config (created by /ralpix init)
├── config.json
├── prompts/
├── agents/
├── progress/
└── pi-agent/
    ├── AGENTS.md
    ├── auth.json -> ~/.pi/agent/auth.json
    └── settings.json

./.ralpix/                           # Project-local overrides
├── config.json
└── prompts/
    └── task-default.md
```

---

## Examples

### From idea to merged feature

```bash
/ralpix plan "add rate limiting middleware for Express API"
# → Clarifying questions → plan draft → you review → accept → execute

# ralpix takes over:
# Task 1: Create Redis rate limiter module  ✓  commit a1b2c3d
# Task 2: Wire middleware into Express app    ✓  commit d4e5f6a
# Task 3: Add configuration and tests        ✓  commit g7h8i9j
#
# First review: 5 agents check everything
# External review: GPT double-checks the diff
# Second review: critical issues only → clean
```

### Review existing changes with a second opinion

```bash
# Configure external review
cat > .ralpix/config.json << 'EOF'
{
  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",
  "reviewFirstModel": "anthropic/claude-sonnet-4-5",
  "reviewSecondModel": "anthropic/claude-sonnet-4-5"
}
EOF

# Minimal plan (already-done tasks jump straight to review)
cat > docs/plans/review-changes.md << 'EOF'
# Plan: Review branch changes

## Overview
Review and fix issues in the current branch.

### Task 1: Review changes
- [x] Changes already made
EOF

/ralpix docs/plans/review-changes.md
# → First review → External review finds issues → Main model fixes → Second review
```

### Fast iteration — tasks only, no review

```bash
cat > .ralpix/config.json << 'EOF'
{
  "reviewEnabled": false,
  "externalReviewEnabled": false
}
EOF

/ralpix docs/plans/prototype.md
```

### Full multi-model setup

```jsonc
// .ralpix/config.json
{
  "defaultModel": "anthropic/claude-opus-4-5",
  "defaultEffort": "high",

  "reviewFirstModel": "openai/gpt-5.2",

  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",
  "externalReviewMaxIterations": 10,
  "externalReviewPatience": 3,

  "reviewSecondModel": "anthropic/claude-sonnet-4-5",

  "maxRetries": 2,
  "commitEnabled": true,
  "commitMessageTemplate": "ralpix: {{taskTitle}}"
}
```

### Per-project prompt with custom conventions

```bash
mkdir -p .ralpix/prompts
cat > .ralpix/prompts/task-default.md << 'EOF'
# Task Execution — MyProject

You are working on MyProject, a Go microservice.

## Plan Context
{{OVERVIEW}}

## Current Task
### {{TASK_TITLE}}
{{TASK_DESCRIPTION}}

## Project Conventions
- Use Go 1.24+ with standard library where possible
- Tests use testify/assert
- Error handling: always wrap with fmt.Errorf("context: %w", err)
- Logging: use slog, not log
- Database: sqlc for queries, no ORM

## Instructions
- Complete all checklist items
- Run `go test ./...` after changes
- Run `golangci-lint run` before committing
EOF

/ralpix docs/plans/add-grpc-endpoint.md
```

---

## Architecture

### Brainstorm → Plan creation (interactive)

```
┌──────────────────────────────────────────────────────┐
│  /ralpix brainstorm "description"                   │
│    │                                                  │
│    ├─► Q&A round 1                                   │
│    │   └─► User answers question                     │
│    ├─► Q&A round 2  (AI decides when to move on)    │
│    │   └─► User answers question                     │
│    ├─► Propose approaches → User selects one        │
│    ├─► Design section 1 → User validates / rejects  │
│    ├─► Design section 2 → User validates / rejects  │
│    └─► Summarize design context                     │
│        └─► Offer to create plan                     │
│                                                      │
│  /ralpix plan "description"                          │
│    │                                                  │
│    ├─► Optional brainstorm (if brainstormEnabled)   │
│    ├─► Model explores codebase                      │
│    ├─► Model asks clarifying questions              │
│    ├─► Model generates plan draft                  │
│    └─► User accepts / revises / reloads            │
│        └─► Plan saved to docs/plans/                │
│            └─► Option: AI review → execute           │
└──────────────────────────────────────────────────────┘
```

### Task execution

Each task runs as an isolated `pi` subprocess — no context contamination between tasks. ralpix now writes a readable session transcript as it works, while a small sticky status line shows what is currently active. The transcript preserves the full history of brainstorm Q&A, plan revisions, task attempts, and review stages:

```
┌──────────────────────────────────────────────────────┐
│  /ralpix docs/plans/feature.md                       │
│    │                                                  │
│    ├─► On main/master? → Offer branch creation       │
│    │   └─► e.g. ralpix/20260523-add-health-check    │
│    │                                                  │
│    ├─► spawn pi (task-default)          Task 1        │
│    │   ├─► Transcript: running → retrying → complete│
│    │   └─► auto-commit                                │
│    │                                                  │
│    ├─► spawn pi (task-default)          Task 2        │
│    │   ├─► Transcript: running → complete           │
│    │   └─► auto-commit                                │
│    │                                                  │
│    ├─► spawn pi (review-first)          Review 1      │
│    │   └─► 5 agents, one-shot                        │
│    │                                                  │
│    ├─► external review loop (if enabled)              │
│    │   ├─► spawn pi (external-review)   Find issues   │
│    │   ├─► spawn pi (external-eval)     Fix issues    │
│    │   └─► loop until clean / stalemate               │
│    │                                                  │
│    └─► review loop (iterative)          Review 2      │
│        ├─► spawn pi (review-second)     Iteration 1   │
│        │   └─► HEAD changed → loop                   │
│        └─► spawn pi (review-second)     Iteration 2   │
│            └─► HEAD unchanged → done                  │
│                                                       │
│  Progress: ./.ralpix/progress/<plan>.jsonl            │
└──────────────────────────────────────────────────────┘
```

---

## Release

Releases are published locally, not via GitHub Actions.

**Requirements:**

- `gh` authenticated to the target repository
- `npm`

```bash
make release VERSION=1.2.3
```

**What it does:**

1. Verifies the working tree is clean and the tag does not already exist
2. Runs `npm ci` and `npm run check`
3. Counts commits since the previous semver tag and uses that range in release notes
4. Pushes the git tag
5. Creates the GitHub release

**Tag behavior:**

- Stable `1.2.3` and prerelease `1.2.3-rc1` are both supported; prereleases are marked as such on GitHub

---

## Troubleshooting

**Extension not found**

```bash
ls -la ~/.pi/agent/extensions/ralpix/index.ts
# Missing? Re-link:
ln -s "$(pwd)" ~/.pi/agent/extensions/ralpix
```

**Plan not found**

Use a path relative to the current working directory or an absolute path:

```bash
/ralpix docs/plans/my-plan.md
/ralpix /absolute/path/to/plan.md
```

**Task execution hangs**

```bash
which pi   # Verify pi is on PATH
```

**Progress log is empty**

```bash
ls -la .ralpix/progress/   # Verify directory exists and is writable
```

---

## Contributing

Contributions are welcome. Please open an issue before starting larger changes so we can discuss the approach.

**Development setup:**

```bash
git clone https://github.com/mkoziy/ralpix
cd ralpix
npm ci
```

**Validation (run before every commit):**

```bash
npm run check   # lint + typecheck
```

**Guidelines:**

- Read `AGENTS.md` for the repo map and change guardrails before editing
- Keep changes scoped to one subsystem; this is a small codebase but each file touches runtime behavior
- If you change user-visible behavior, update `README.md` and the relevant bundled prompts in the same PR
- Prefer backward-compatible changes; breaking changes need a version bump and clear migration notes

---

## License

MIT — see [LICENSE](LICENSE).
