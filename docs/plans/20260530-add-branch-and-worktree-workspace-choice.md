# Plan: Add Branch and Worktree Workspace Choice

## Overview
Add an interactive workspace choice before task development so users can create a branch, create a git worktree on a new branch, or skip switching. The implementation will replace the current `maybeSwitchBranch` guardrail with workspace lifecycle helpers that can remap `ctx.cwd` into a worktree and optionally clean it up after execution.

## Context
- Current branch guardrail lives in `index.ts` as `maybeSwitchBranch`, with helper functions `getCurrentBranch`, `slugify`, and `suggestBranchName`.
- `runPlan` currently parses the plan before branch switching and uses `ctx.cwd` for logger, task execution, review, and git operations.
- If `ctx.cwd` changes to a worktree, the plan must be reloaded from the copied plan path inside that worktree so `executeAllTasks` updates the worktree copy rather than the original file.
- Progress logs are rooted at `ctx.cwd`, so worktree mode will naturally write logs under `.ralpix/progress/` inside the worktree unless explicitly changed.

## Design Decisions
- Use a new `workspace.ts` module to keep branch/worktree lifecycle code out of the already-large `index.ts`.
- Use `execFileSync` for git operations where possible to avoid shell quoting issues with paths.
- Keep failure behavior non-blocking: if worktree setup fails, notify the user and continue in the original working tree with `mode: "skip"`.
- Store the original cwd in the worktree choice so cleanup can run even after `ctx.cwd` has been remapped.

## Invariants
- After choosing worktree mode, `ctx.cwd` points to the worktree path before task execution, review, logging, and commits begin.
- In worktree mode, the parsed plan used for execution points to the copied plan file inside the worktree.
- Worktree creation failures do not abort plan execution; they fall back to the original cwd and current branch.
- Worktree cleanup never deletes the branch; it only removes the worktree directory.

## Success Criteria
- [ ] Executing a plan presents branch, worktree, and skip choices instead of only the current yes/no branch prompt.
- [ ] Choosing branch preserves existing behavior by creating and checking out the suggested branch in the main working tree.
- [ ] Choosing worktree creates `.ralpix/worktrees/<branch-name>/`, copies the plan there, commits it with `--no-verify`, remaps `ctx.cwd`, and runs tasks/review in the worktree.
- [ ] Worktree cleanup offers remove-or-leave choices after successful completion and preserves the created branch.
- [ ] Worktree setup failures notify the user and continue on the original branch without leaving an unusable half-created workspace.
- [ ] `npm run check` passes.

### Task 1: Extract Workspace Choice Types and Helpers
**Files:**
- Create: `workspace.ts`
- Modify: `index.ts`

- [ ] Move `getCurrentBranch`, `slugify`, and `suggestBranchName` out of `index.ts` into `workspace.ts`, exporting only the helpers needed by the workspace flow.
- [ ] Add a `WorkspaceChoice` discriminated union in `workspace.ts` with `branch`, `worktree`, and `skip` modes; include `originalCwd`, `branchName`, `worktreePath`, and `planPath` where relevant.
- [ ] Replace shell-based branch checkout logic with a focused helper using `execFileSync("git", ["checkout", "-b", branchName], ...)`.
- [ ] Keep `index.ts` compiling by importing the new workspace functions and removing the old branch guardrail helper definitions.

### Task 2: Implement Interactive Workspace Selection
**Files:**
- Modify: `workspace.ts`

- [ ] Implement `chooseWorkspace(ctx, planTitle, planPath)` using `ctx.ui.select` with choices for creating a branch, working in a worktree, and skipping.
- [ ] Include the current branch name in the prompt text, with wording that works both on `main`/`master` and on existing feature branches.
- [ ] Preserve branch mode behavior: create the suggested branch, notify success, and return `{ mode: "branch", branchName }`; on failure notify warning and return skip.
- [ ] Treat cancelled selection as skip with an informational notification.

### Task 3: Add Worktree Creation and Plan Sync
**Files:**
- Modify: `workspace.ts`

- [ ] Implement worktree path derivation as `.ralpix/worktrees/<branch-name>` under the original project cwd, preserving slashes in branch names as nested directories.
- [ ] Before creation, run `git worktree prune`, check whether the target directory already exists, and fall back to skip if it does.
- [ ] Create the worktree with `git worktree add <worktreePath> -b <branchName>`; if the branch already exists, retry with `git worktree add <worktreePath> <branchName>`.
- [ ] Copy the plan file into the worktree at the same relative path, creating parent directories as needed.
- [ ] Commit the copied plan inside the worktree with `git add <relative-plan-path>` and `git commit --no-verify -m "ralpix: add plan"`.

### Task 4: Wire Workspace Choice into Plan Execution
**Files:**
- Modify: `index.ts`

- [ ] In `runPlan`, resolve and validate the original plan path first, then call `chooseWorkspace` before creating the logger and execution state.
- [ ] If the workspace choice is worktree, set `ctx.cwd` to the returned worktree path and re-parse the plan from the copied worktree plan path.
- [ ] Ensure `state.planPath`, `LogWriter`, task execution, review pipeline, and plan completion move logic all use the effective plan path after any worktree remapping.
- [ ] Preserve existing behavior for branch and skip modes, including task counts and notifications.

### Task 5: Implement Worktree Cleanup Flow
**Files:**
- Modify: `workspace.ts`
- Modify: `index.ts`

- [ ] Add `maybeCleanupWorkspace(ctx, choice)` that only prompts for worktree mode.
- [ ] Offer “Remove worktree (keep branch)” and “Leave worktree for manual inspection” after plan execution reaches the normal completion path.
- [ ] Remove with `git worktree remove <worktreePath>`, retry with `--force` if normal removal fails, and notify success or manual cleanup instructions.
- [ ] Call cleanup after the final completion notification and after best-effort plan move, without hiding the progress TUI report.

### Task 6: Harden Failure Paths and Edge Cases
**Files:**
- Modify: `workspace.ts`
- Modify: `index.ts`

- [ ] If plan copy fails after worktree creation, force-remove the worktree and fall back to skip.
- [ ] If initial plan commit fails, force-remove the worktree and fall back to skip.
- [ ] Ensure any fallback restores `ctx.cwd` to the original cwd before execution continues.
- [ ] Add concise user notifications for stale directory, worktree add failure, copy failure, commit failure, and cleanup failure cases.

### Task 7: Update User Documentation
**Files:**
- Modify: `README.md`

- [ ] Update the Features list to describe workspace selection with branch, worktree, or skip choices.
- [ ] Update the “What happens when you execute a plan” list to mention worktree mode and cleanup.
- [ ] Update the task execution architecture diagram text so it no longer says branch creation only happens on `main`/`master`.
- [ ] Add a short troubleshooting note explaining where ralpix worktrees live and how to remove one manually with `git worktree remove`.

### Task 8: Validate TypeScript and Runtime Behavior
**Files:**
- Modify: `workspace.ts`
- Modify: `index.ts`
- Modify: `README.md`

- [ ] Run `npm run check` and fix lint/typecheck failures.
- [ ] Manually verify branch mode by choosing “Create a branch” in a disposable git repo.
- [ ] Manually verify worktree mode creates the expected worktree path, commits the copied plan, and runs subsequent git commands from the worktree.
- [ ] Manually verify cleanup remove and leave choices both behave as documented.
