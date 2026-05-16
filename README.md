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
2. Each task runs in an isolated `pi` session seeded from the merged ralpix config
3. Auto-commit after each successful task
4. Progress is logged to `./.ralpix/progress/<plan-name>.txt`
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
  "defaultModel": "opencode-go/deepseek-v4-flash", // Task execution default
  "defaultProvider": null,        // e.g. "anthropic"
  "defaultEffort": "low",         // Executor reasoning effort; kept low because the default executor uses a flash-tier model
  "commitEnabled": true,          // Auto-commit after each task
  "commitMessageTemplate": "ralpix: {{taskTitle}}",
  "reviewEnabled": true,          // Run review pipeline after tasks
  "reviewFirstModel": "opencode-go/glm-5.1",   // First review pass
  "reviewSecondModel": "opencode-go/kimi-k2.6", // Second review pass
  "reviewFirstEffort": "high",    // Thinking effort for first review
  "reviewSecondEffort": "medium", // Thinking effort for second review
  "maxRetries": 2,                // Max retries per task on failure
  "reviewMaxIterations": 5,       // Max iterations for review loop
  "movePlanOnCompletion": false,  // Move plan.md → completed/plan.md when done
  "externalReviewEnabled": true,  // Enable external review phase (different model)
  "externalReviewModel": "openai/gpt-5.5", // Independent external reviewer
  "externalReviewEffort": "medium", // Thinking effort for external review
  "externalReviewMaxIterations": 5, // Max iterations in external review loop
  "externalReviewPatience": 3,    // Stalemate: exit after N unchanged rounds
  "planModel": "openai/gpt-5.5",  // Interactive plan creation
  "planEffort": "medium"          // Plan generation effort
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

## Real-World Examples

### Example 1: From idea to merged feature

```bash
# 1. Generate a plan from a one-line description
/ralpix plan "add rate limiting middleware for Express API"
# → Model explores codebase, asks:
#   Q: Which rate limit algorithm? → "Token bucket"
#   Q: Store in memory or Redis? → "Redis"
# → Plan generated, you review and accept
# → Saved to docs/plans/add-rate-limiting-middleware.md
# → Choose "Execute plan now"

# ralpix takes over:
# Task 1: Create Redis rate limiter module  ✓  commit a1b2c3d
# Task 2: Wire middleware into Express app    ✓  commit d4e5f6a
# Task 3: Add configuration and tests        ✓  commit g7h8i9j
#
# First review: 5 agents check everything
# External review: GPT-5.2 double-checks Claude's work
# Second review: critical issues only → clean
#
# Done. 3 tasks, 3 commits, multi-model review completed.
```

### Example 2: Review existing changes with a second opinion

```bash
# You already made changes manually or with Claude Code
# Run external review on your branch

# First, configure external review with GPT:
cat > .ralpix/config.json << 'EOF'
{
  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",
  "reviewFirstModel": "anthropic/claude-sonnet-4-5",
  "reviewSecondModel": "anthropic/claude-sonnet-4-5"
}
EOF

# Create a minimal plan (needed for review context):
cat > docs/plans/review-changes.md << 'EOF'
# Plan: Review branch changes

## Overview
Review and fix issues in the current branch.

### Task 1: Review changes
- [x] Changes already made
EOF

# Execute — tasks are already done, so it jumps to review:
/ralpix docs/plans/review-changes.md
# → First review: Claude reviews (5 agents)
# → External review: GPT-5.2 finds 3 issues Claude missed
# → Main model fixes, GPT re-checks → clean
# → Second review: final critical pass
```

### Example 3: Fast iteration with tasks-only mode

```bash
# Skip all reviews, just execute tasks — great for prototypes

cat > .ralpix/config.json << 'EOF'
{
  "reviewEnabled": false,
  "externalReviewEnabled": false
}
EOF

/ralpix docs/plans/prototype-feature.md
# → Tasks execute sequentially, commits after each
# → No review phases — fast feedback loop
```

### Example 4: Different models for different phases

```jsonc
// .ralpix/config.json — full multi-model setup
{
  // Execution: powerful model for complex code generation
  "defaultModel": "anthropic/claude-opus-4-5",
  "defaultEffort": "high",

  // First review: broad analysis with a different provider
  "reviewFirstModel": "openai/gpt-5.2",

  // External review: third model for independent audit
  "externalReviewEnabled": true,
  "externalReviewModel": "openai/gpt-5.2",
  "externalReviewMaxIterations": 5,
  "externalReviewPatience": 3,

  // Second review: back to main provider, critical issues only
  "reviewSecondModel": "anthropic/claude-sonnet-4-5",

  // Execution control
  "maxRetries": 2,
  "commitEnabled": true,
  "commitMessageTemplate": "ralpix: {{taskTitle}}"
}
```

### Example 5: Per-project prompt customization

```bash
# Project-specific task prompt that knows your conventions
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

# Now ralpix uses your custom prompt for every task in this project
/ralpix docs/plans/add-grpc-endpoint.md
```

## Architecture

### Plan Creation (interactive)

```
┌─────────────────────────────────────────────┐
│  /ralpix plan "description"                  │
│    │                                        │
│    ├─► ctx.newSession()                     │
│    │   ├─► Model explores codebase          │
│    │   ├─► Model calls ralpix_ask_question  │
│    │   │   └─► User picks answer            │
│    │   ├─► Model generates plan draft       │
│    │   └─► Model calls ralpix_submit_plan   │
│    │       └─► User accepts / revises       │
│    │                                        │
│    └─► Plan saved to docs/plans/            │
│        └─► Option: execute immediately      │
└─────────────────────────────────────────────┘
```

### Task Execution

Each task runs as an isolated pi process:

```
┌──────────────────────────────────────────────────────┐
│  /ralpix docs/plans/feature.md                       │
│    │                                                 │
│    ├─► spawn pi (task-default)          Task 1       │
│    │   └─► auto-commit                               │
│    │                                                 │
│    ├─► spawn pi (task-default)          Task 2       │
│    │   └─► auto-commit                               │
│    │                                                 │
│    ├─► spawn pi (review-first)          Review 1     │
│    │   └─► 5 agents, one-shot                       │
│    │                                                 │
│    ├─► external review loop (if enabled)             │
│    │   ├─► spawn pi (external-review)   Find issues  │
│    │   │   └─► GPT reviews the diff                 │
│    │   ├─► spawn pi (external-eval)     Fix issues   │
│    │   │   └─► Claude evaluates & fixes             │
│    │   └─► loop until clean / stalemate              │
│    │                                                 │
│    └─► review loop (iterative)          Review 2     │
│        ├─► spawn pi (review-second)     Iteration 1  │
│        │   └─► check HEAD: changed → loop            │
│        └─► spawn pi (review-second)     Iteration 2  │
│            └─► check HEAD: unchanged → done          │
│                                                      │
│  Progress: ./.ralpix/progress/<plan>.txt              │
└──────────────────────────────────────────────────────┘
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
Check that `./.ralpix/progress/` exists and is writable:
```bash
ls -la .ralpix/progress/
```

## v2 Ideas

- **Parallel review**: Run review agents in parallel using `spawn()`
- **Worktree isolation**: `--worktree` flag for isolated git worktrees
- **Per-task model override**: YAML frontmatter in plans
- **Validation commands**: `## Validation` section in plans with auto-run
- **Web dashboard**: `--serve` flag for progress viewing
- **Notifications**: Telegram/Slack hooks on completion/failure
- **fzf plan selector**: Run `/ralpix` without args, pick a plan from the list
