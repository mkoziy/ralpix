# Design: External Review Phase

## Overview

Add an external review phase to the ralpix review pipeline. The external reviewer is a different AI model/provider (e.g. openai/gpt-5.2) that independently reviews code changes, finds issues, and passes them to the main model for evaluation and fixing. This gives a "second pair of eyes" from a different model family, catching blind spots that single-provider review misses.

Inspired by ralphex's codex phase, but instead of requiring the codex binary, ralpix uses its own `pi` spawn mechanism with a configurable alternative model.

## Motivation

- Single-model review has blind spots — the same model that wrote the code reviews it
- Different model families (Anthropic vs OpenAI) have different strengths and catch different issues
- No external binary dependency needed — just a model name in config
- Fully hands-off: no prompts during execution

## Architecture

### Flow

```
Phase 1: First Review (5 agents, one-shot)
    │  reviewFirstModel, review-first.md
    │
    ▼
Phase 2.5: External Review Loop (if externalReviewEnabled)
    │
    ├─► spawn pi with externalReviewModel + external-review.md
    │   diff scope: first iteration = defaultBranch...HEAD, subsequent = working tree
    │   output: findings text
    │
    ├─► spawn pi with defaultModel + external-eval.md
    │   evaluates findings, fixes confirmed issues, commits
    │   signal: EXTERNAL_REVIEW_DONE → exit loop
    │
    ├─► stalemate detection: N rounds without HEAD changes → exit
    ├─► max iterations safety net
    │
    └─► loop
    │
    ▼
Phase 2: Second Review (2 agents, iterative loop)
    │  reviewSecondModel, review-second.md
    │
    ▼
Finalize (optional)
```

### Signals

- `EXTERNAL_REVIEW_DONE` — emitted by the main model in the eval prompt when all findings are resolved or no valid issues remain. Triggers clean exit from the external review loop.

### Stalemate Detection

After each eval+fix round, compare HEAD hash before and after. If `externalReviewPatience` consecutive rounds produce no commits, exit the loop. This prevents infinite loops when models disagree on what constitutes an issue.

### Diff Scope

- **First iteration:** `git diff <defaultBranch>...HEAD` — full branch changes for comprehensive review
- **Subsequent iterations:** `git diff` — only uncommitted working-tree changes from the previous fix round

The main model is instructed to commit fixes in the eval prompt, so subsequent iterations naturally narrow scope.

## Configuration

### New fields in config.json

```jsonc
{
  // ... existing fields ...

  "externalReviewEnabled": true,          // Enable external review phase (default: true)
  "externalReviewModel": null,            // Model for external review (null → defaultModel)
  "externalReviewEffort": null,           // Thinking effort for external review
  "externalReviewMaxIterations": 5,       // Max iterations in external review loop
  "externalReviewPatience": 3             // Stalemate: exit after N unchanged rounds
}
```

### Priority

- `externalReviewModel`: config → `defaultModel` (if null). If both null, phase is skipped with a warning.
- `externalReviewEffort`: config → null (no effort flag)
- `externalReviewMaxIterations`: config → 5 (bundled default)
- `externalReviewPatience`: config → 3 (bundled default)

## New Prompt Files

### external-review.md

Template for the external review model. Tells it to review code changes for bugs, security issues, logic errors, and edge cases.

Variables: `{{GOAL}}`, `{{DEFAULT_BRANCH}}`, `{{PROGRESS_FILE}}`, `{{DIFF_INSTRUCTION}}`

### external-eval.md

Template for the main model. Receives findings from the external reviewer, evaluates their validity, fixes confirmed issues, and commits.

Variables: `{{GOAL}}`, `{{PROGRESS_FILE}}`, `{{FINDINGS}}`

Expected signal: `EXTERNAL_REVIEW_DONE` when all findings resolved.

## Code Changes

### Files to modify

| File | Changes |
|------|---------|
| `types.ts` | Add `externalReviewEnabled`, `externalReviewModel`, `externalReviewEffort`, `externalReviewMaxIterations`, `externalReviewPatience` to `RalpixConfig` |
| `bundled/config.json` | Add new fields with defaults |
| `config.ts` | Load/merge new fields, validate effort |
| `reviewer.ts` | Add `runExternalReviewLoop()`, update `runReviewPipeline()` to call it between first and second review |
| `bundled/prompts/external-review.md` | New file |
| `bundled/prompts/external-eval.md` | New file |
| `logger.ts` | Add `logExternalReview()` method |

### No changes to

- `index.ts` — external review is transparently part of the review pipeline
- `executor.ts` — reuse existing `runTaskProcess()` via new review-spawning functions
- `parser.ts` — no plan format changes
- `prompt.ts` — existing `expandPrompt()` handles new templates

## Error Handling

- If external review model is null and defaultModel is also null → skip phase, log warning
- If external review process fails (non-zero exit) → log error, skip remaining review loop iterations, proceed to Phase 2
- If eval process fails → log error, skip remaining loop iterations
- Stalemate → log, exit loop gracefully, proceed to Phase 2
- Ctrl+C (SIGINT) during loop → handled by existing signal handling

## Testing

- Unit: config merge with new fields
- Unit: stalemate counter logic
- Integration: full run with externalReviewEnabled=true, different model
- Integration: full run with externalReviewEnabled=false (phase skipped)
- Integration: stalemate triggers after patience rounds
