# ralpix

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)

Autonomous plan execution extension for [pi](https://github.com/earendil-works/pi-coding-agent). Write a markdown plan — ralpix executes every task hands-off, each in a fresh `pi` session, then runs a multi-model review pipeline before it calls it done.

Inspired by [ralphex](https://github.com/umputun/ralphex).

---

## Features

- **Isolated task execution** — each task gets a clean `pi` session; no context bleed between tasks
- **Auto-commit** — commits after every successful task with a configurable message template
- **Interactive plan creation** — describe a feature in one line, get a validated markdown plan back
- **Multi-model review pipeline** — first pass (5 parallel agents) → optional external review (different provider) → second pass (critical issues only)
- **Live review stage UI** — the status widget shows review phases and iteration progress, not just task execution
- **Stalemate detection** — exits the external review loop when two models keep disagreeing, saving tokens
- **Three-layer config** — bundled defaults → `~/.ralpix/config.json` → `./.ralpix/config.json`
- **Prompt customization** — override any prompt globally or per-project
- **Progress logs** — structured, timestamped log of every step written to `.ralpix/progress/`

---

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Plan Format](#plan-format)
- [Plan Creation](#plan-creation)
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

# 2a. Create a plan interactively (recommended)
/ralpix plan "add health check endpoint"

# 2b. Or write a plan manually and execute it directly
/ralpix docs/plans/my-feature.md
```

What happens when you execute a plan:

1. Plan is parsed into tasks
2. Each task runs in an isolated `pi` session seeded from the merged ralpix config
3. Auto-commit after each successful task
4. Progress is logged to `./.ralpix/progress/<plan-name>.txt`
5. After all tasks: review pipeline runs (first pass → optional external review → second pass)
6. Plan checkboxes are updated automatically

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

ralpix plans are plain markdown files:

```markdown
# Plan: My Feature

## Overview
Brief description of what this plan achieves.

## Success Criteria
- [ ] Feature works
- [ ] Tests pass

### Task 1: Set up the foundation
Description of what needs to be done.

- [ ] Create module structure
- [ ] Write interface definitions

### Task 2: Implement core logic
- [ ] Write main algorithm
- [ ] Add error handling
```

Rules:

| Element | Required | Description |
|---------|----------|-------------|
| `# Plan: <Title>` | Yes | Plan title, injected into prompts |
| `## Overview` | No | Description injected into every task prompt |
| `## Success Criteria` | No | Overall success checklist |
| `### Task N: <Title>` | Yes | One section per task |
| `- [ ]` / `- [x]` | No | Checkboxes; if absent, the entire task description is treated as one item |

---

## Plan Creation

Skip writing plans by hand — describe what you want and ralpix creates the plan for you:

```bash
/ralpix plan "add JWT authentication to the API"
```

The model will:

1. **Ask clarifying questions** in the UI when needed (option picker + free-form answer)
2. **Generate a plan draft** in ralpix format
3. **Validate** the draft structure before saving
4. **Save** it to `docs/plans/YYYYMMDD-<plan-title>.md`
5. **Pause for review** — Accept, Revise (with feedback), Reload after editing the file elsewhere, or Reject
6. **Offer execution** only after you explicitly accept

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
  "reviewMaxIterations": 5,
  "movePlanOnCompletion": false,   // Move plan.md → completed/plan.md when done
  "externalReviewEnabled": true,
  "externalReviewModel": "openai-codex/gpt-5.5",
  "externalReviewEffort": "medium",
  "externalReviewMaxIterations": 5,
  "externalReviewPatience": 3,     // Exit after N unchanged rounds (stalemate)
  "planModel": "openai-codex/gpt-5.5",
  "planEffort": "medium"
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
    └── documentation.md     # Docs review
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
| `{{OVERVIEW}}` | Plan overview text |
| `{{TASK_TITLE}}` | Current task title |
| `{{TASK_DESCRIPTION}}` | Task description + checklist |
| `{{GOAL}}` | Plan title (review prompts) |
| `{{PROGRESS_FILE}}` | Path to progress log |
| `{{DEFAULT_BRANCH}}` | Main/master branch name |
| `{{DIFF_INSTRUCTION}}` | Git diff command for external reviewer |
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
  "externalReviewMaxIterations": 5,
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

All execution is logged to `./.ralpix/progress/<plan-name>.txt`:

```
============================================================
Ralpix Plan Execution
============================================================
Plan:    My Feature
Path:    /home/user/project/docs/plans/my-feature.md
Tasks:   3
Started: 2026-05-12T14:30:00.000Z

[2026-05-12T14:30:00.001Z] PLAN_START  My Feature (3 tasks)
[2026-05-12T14:30:05.123Z] TASK_START  Task 1: Set up the foundation
[2026-05-12T14:30:05.124Z] TASK_INFO   Task 1: Set up the foundation  attempt 1 launched (openai-codex/gpt-5.5)
[2026-05-12T14:30:09.870Z] TASK_INFO   Task 1: Set up the foundation  attempt 1: tool started: exec_command rg -n "health" src
[2026-05-12T14:30:10.401Z] TASK_INFO   Task 1: Set up the foundation  attempt 1: tool finished in 1s: exec_command rg -n "health" src
[2026-05-12T14:30:12.208Z] TASK_INFO   Task 1: Set up the foundation  attempt 1: assistant: Audited the existing health-check wiring and test coverage.
[2026-05-12T14:32:10.456Z] TASK_END    Task 1: Set up the foundation  ✓ SUCCESS — commit a1b2c3d
[2026-05-12T14:32:10.457Z] task_usage  Task 1: Set up the foundation  step in 12.3k out 1.1k cost $0.084  total in 24.8k out 2.0k cost $0.167
[2026-05-12T14:32:10.458Z] TASK_START  Task 2: Implement core logic
...
[2026-05-12T14:45:00.000Z] REVIEW_FIRST   COMPLETE (iteration 1)
[2026-05-12T14:48:00.000Z] REVIEW_SECOND  COMPLETE (iteration 1)
[2026-05-12T14:48:00.001Z] review_usage review pipeline  step in 8.2k out 900 cost $0.052  total in 33.0k out 2.9k cost $0.219
[2026-05-12T14:48:00.002Z] PLAN_COMPLETE  All tasks finished
```

`TASK_INFO` lines show live subprocess summaries: attempt starts, tool/command previews, short assistant status notes, and idle heartbeats.

`task_usage` and `review_usage` lines report per-step and cumulative token counts with cost, using the format:

```
task_usage  Task N: <title>  step in <input> out <output> cost $<cost>  total in <input> out <output> cost $<cost>
review_usage review pipeline  step in <input> out <output> cost $<cost>  total in <input> out <output> cost $<cost>
```

Token counts are abbreviated (e.g. `12.3k`, `150k`).

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
  "externalReviewMaxIterations": 5,
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

### Plan creation (interactive)

```
┌─────────────────────────────────────────────┐
│  /ralpix plan "description"                  │
│    │                                         │
│    ├─► ctx.newSession()                      │
│    │   ├─► Model explores codebase           │
│    │   ├─► Model calls ralpix_ask_question   │
│    │   │   └─► User picks answer             │
│    │   ├─► Model generates plan draft        │
│    │   └─► Model calls ralpix_submit_plan    │
│    │       └─► User accepts / revises        │
│    │                                         │
│    └─► Plan saved to docs/plans/             │
│        └─► Option: execute immediately       │
└─────────────────────────────────────────────┘
```

### Task execution

Each task runs as an isolated `pi` subprocess — no context contamination between tasks:

```
┌──────────────────────────────────────────────────────┐
│  /ralpix docs/plans/feature.md                       │
│    │                                                  │
│    ├─► spawn pi (task-default)          Task 1        │
│    │   └─► auto-commit                                │
│    │                                                  │
│    ├─► spawn pi (task-default)          Task 2        │
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
│  Progress: ./.ralpix/progress/<plan>.txt              │
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
