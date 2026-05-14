# ralpix

Autonomous plan execution extension for [pi](https://github.com/earendil-works/pi-coding-agent).

Inspired by [ralphex](https://github.com/umputun/ralphex) — runs markdown plans hands-off, each task in a fresh pi session to keep the model sharp.

## Installation

```bash
# Option 1: link from source
ln -s $(pwd) ~/.pi/agent/extensions/ralpix

# Option 2: pi install (coming soon)
pi install git:github.com/mkoziy/ralpix
```

## Quick Start

```bash
# 1. Initialize ralpix (creates ~/.ralpix/ with default prompts, agents, and config)
/ralpix init

# 2a. Create a plan interactively (recommended)
/ralpix plan "add health check endpoint"

# 2b. Or write a plan manually (see Plan Format below)
# 3. Execute it
/ralpix docs/plans/my-feature.md
```

What happens:
1. Plan is parsed
2. Each task runs in an isolated `pi --mode json -p --no-session` process
3. Auto-commit after each successful task
4. Progress is logged to `~/.ralpix/progress/<plan-name>.txt`
5. After all tasks: review pipeline runs (first pass → second pass)
6. Plan checkboxes are updated automatically

## Plan Creation

Don't want to write plans manually? Use interactive plan creation:

```bash
/ralpix plan "add JWT authentication to the API"
```

The model will:
1. **Explore** your codebase to understand project structure and conventions
2. **Ask clarifying questions** (pick from options in the UI)
3. **Generate a plan draft** in ralpix format
4. **Show it for review** — you can Accept, Revise (with feedback), or Reject
5. **Save** to `docs/plans/` and offer to execute immediately

**Requirements:** Your project should have a `README.md` and source files for the model to explore.

## Plan Format

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
- `# Plan: <Title>` — Required
- `## Overview` — Plan description (injected into task prompts)
- `## Success Criteria` — Overall success checklist
- `### Task N: <Title>` — Each task, with optional description and `- [ ]` / `- [x]` checkboxes
- If a task has no checkboxes, the entire task description is treated as one item

## Configuration

ralpix uses a three-layer config merge:

| Layer | Path | Purpose |
|-------|------|---------|
| Bundled | Inside extension | Default values |
| Global | `~/.ralpix/config.json` | Your defaults |
| Project | `./.ralpix/config.json` | Per-project overrides |

```jsonc
// ~/.ralpix/config.json
{
  "defaultModel": null,           // e.g. "anthropic/claude-sonnet-4-5"
  "defaultProvider": null,        // e.g. "anthropic"
  "commitEnabled": true,          // Auto-commit after each task
  "commitMessageTemplate": "ralpix: {{taskTitle}}",
  "reviewEnabled": true,          // Run review pipeline after tasks
  "reviewFirstModel": null,       // Model for first review (falls back to defaultModel)
  "reviewSecondModel": null,      // Model for second review
  "reviewFirstEffort": null,      // Thinking effort for first review
  "reviewSecondEffort": null,     // Thinking effort for second review
  "maxRetries": 2,                // Max retries per task on failure
  "reviewMaxIterations": 5,       // Max iterations for review loop
  "movePlanOnCompletion": false,  // Move plan.md → completed/plan.md when done
  "externalReviewEnabled": true,  // Enable external review phase (different model)
  "externalReviewModel": null,    // Model for external review (null = defaultModel)
  "externalReviewEffort": null,   // Thinking effort for external review
  "externalReviewMaxIterations": 5, // Max iterations in external review loop
  "externalReviewPatience": 3     // Stalemate: exit after N unchanged rounds
}
```

### Per-project config

Create `./.ralpix/config.json` in your project root to override settings for that project:

```jsonc
{
  "commitEnabled": false,         // Don't auto-commit in this project
  "reviewEnabled": false,         // Skip review pipeline
  "defaultModel": "openai/gpt-5"  // Use GPT-5 for this project
}
```

### Per-project prompts

Override the default task prompt for a specific project:

```bash
mkdir -p .ralpix/prompts
cp ~/.ralpix/prompts/task-default.md .ralpix/prompts/task-default.md
# Edit .ralpix/prompts/task-default.md
```

## Prompt Customization

ralpix ships with default prompts you can customize:

```
~/.ralpix/
├── prompts/
│   ├── task-default.md      # Used for each task execution
│   ├── review-first.md      # First review pass (5 agents)
│   ├── review-second.md     # Second review pass (2 agents)
│   ├── plan-creation.md     # Interactive plan creation
│   ├── external-review.md   # External review (different model finds issues)
│   ├── external-eval.md     # External review eval (main model fixes issues)
│   └── finalize.md          # Final summary
├── agents/
│   ├── quality.md           # Correctness, security, edge cases
│   ├── implementation.md    # Goal alignment verification
│   ├── testing.md           # Test coverage review
│   ├── simplification.md    # Over-engineering detection
│   └── documentation.md     # Documentation review
```

### Template Variables

Prompts support `{{VARIABLE}}` expansion:

| Variable | Description |
|----------|-------------|
| `{{OVERVIEW}}` | Plan overview text |
| `{{TASK_TITLE}}` | Current task title |
| `{{TASK_DESCRIPTION}}` | Task description + checklist |
| `{{GOAL}}` | Plan title (review) |
| `{{PROGRESS_FILE}}` | Path to progress log |
| `{{DEFAULT_BRANCH}}` | Main/master branch name |
| `{{DIFF_INSTRUCTION}}` | Git diff command for external reviewer |
| `{{FINDINGS}}` | External reviewer findings (for eval prompt) |
| `{{agent:name}}` | Inline agent content (e.g. `{{agent:quality}}`) |

### External Review Phase

Between the first and second review, ralpix can run an **external review** — an independent code review by a different AI model/provider. This catches blind spots that single-model review misses.

**How it works:**
1. A different model (configured via `externalReviewModel`) reviews the diff and reports findings
2. Your main model (`defaultModel`) evaluates each finding, fixes confirmed issues, and commits
3. The loop repeats until clean, stalemate, or max iterations

**Example config** for external review with OpenAI:

```jsonc
{
  "defaultModel": "anthropic/claude-sonnet-4-5",  // Main model for tasks and fixes
  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",         // Different model for review
  "externalReviewMaxIterations": 5,
  "externalReviewPatience": 3
}
```

**Stalemate detection:** If `externalReviewPatience` consecutive rounds produce no changes (models disagree on findings), the loop exits to save tokens.

**Diff scope:** First iteration reviews the full branch diff (`git diff main...HEAD`). Subsequent iterations review only uncommitted changes from the previous fix round.

**Prompts:**
- `~/.ralpix/prompts/external-review.md` — prompt sent to the external reviewer model
- `~/.ralpix/prompts/external-eval.md` — prompt sent to the main model for evaluation/fixing

### Choosing Review Models

Set `reviewFirstModel` and `reviewSecondModel` to use different models for review:

```jsonc
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "reviewFirstModel": "openai/gpt-5",    // Better at broad analysis
  "reviewSecondModel": "anthropic/claude-sonnet-4-5"  // Better at focused review
}
```

## Progress Logs

All execution is logged to `~/.ralpix/progress/<plan-name>.txt`:

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
[2026-05-12T14:32:10.456Z] TASK_END    Task 1: Set up the foundation  ✓ SUCCESS — commit a1b2c3d
[2026-05-12T14:32:10.457Z] TASK_START  Task 2: Implement core logic
...
[2026-05-12T14:45:00.000Z] REVIEW_FIRST   COMPLETE (iteration 1)
[2026-05-12T14:48:00.000Z] REVIEW_SECOND  COMPLETE (iteration 1)
[2026-05-12T14:48:00.001Z] PLAN_COMPLETE  All tasks finished
```

## Directory Structure

```
~/.pi/agent/extensions/ralpix/      # Extension (read-only bundled defaults)
├── bundled/
│   ├── config.json
│   ├── prompts/                     # Default prompt templates
│   └── agents/                      # Default agent definitions

~/.ralpix/                           # Global config (created by /ralpix init)
├── config.json
├── prompts/                         # Custom prompt overrides
├── agents/                          # Custom agent overrides
└── progress/                        # Execution logs

./.ralpix/                           # Project-local overrides
├── config.json
└── prompts/
    └── task-default.md
```

## Architecture

Each task runs as an isolated pi process:

```
┌────────────────────────────────────────────┐
│  Parent Session (user's pi)                │
│                                            │
│  /ralpix plan.md                           │
│    │                                       │
│    ├─► spawn pi --mode json -p --no-session│  Task 1
│    │   └─► auto-commit                     │
│    │                                       │
│    ├─► spawn pi --mode json -p --no-session│  Task 2
│    │   └─► auto-commit                     │
│    │                                       │
│    ├─► spawn pi (review-first)             │  First review (one-shot, 5 agents)
│    │                                       │
│    └─► review loop (iterative)             │  Review loop
│        ├─► spawn pi (review-second)        │    Iteration 1 (2 agents)
│        │   └─► check HEAD: changed → loop  │
│        ├─► spawn pi (review-second)        │    Iteration 2
│        │   └─► check HEAD: unchanged → done│
│                                            │
│  Progress: ~/.ralpix/progress/<plan>.txt   │
└────────────────────────────────────────────┘
```

This ensures each task gets a clean context window — no contamination from previous tasks.

## Troubleshooting

### Extension not found
Make sure the extension is linked in the right directory:
```bash
ls -la ~/.pi/agent/extensions/ralpix/index.ts
```

If missing, run:
```bash
ln -s $(pwd) ~/.pi/agent/extensions/ralpix
```

### Plan not found
Use absolute or relative paths from the current working directory:
```bash
/ralpix docs/plans/my-plan.md
/ralpix /absolute/path/to/plan.md
```

### Task execution hangs
Check if pi is installed and available on PATH:
```bash
which pi
```

### Progress log is empty
Check that `~/.ralpix/progress/` exists and is writable:
```bash
ls -la ~/.ralpix/progress/
```

## v2 Ideas

- **Parallel review**: Run review agents in parallel using `spawn()`
- **Worktree isolation**: `--worktree` flag for isolated git worktrees
- **Per-task model override**: YAML frontmatter in plans
- **Validation commands**: `## Validation` section in plans with auto-run
- **Web dashboard**: `--serve` flag for progress viewing
- **Notifications**: Telegram/Slack hooks on completion/failure
