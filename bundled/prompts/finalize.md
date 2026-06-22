# Finalize: {{GOAL}}

All tasks are complete and all review passes have accepted the changes.

{{agent:epistemic}}

## Your Task

Perform final cleanup before the implementation is considered done. Make **no functional changes**.

### Step 1: Remove debug artifacts
- Delete any `console.log`, debug print statements, or logging added for development only
- Remove temporary comments, scratch notes, and TODO items left during implementation
- Remove commented-out code blocks that were experiments or development leftovers

### Step 2: Verify the build and tests pass
- Run the project's build command to confirm everything compiles without errors
- Run the test suite to confirm all tests pass
- If a build or test failure is unrelated to cleanup, note it in your summary but do not fix it here

### Step 3: Commit cleanup changes (if any were made)
- Stage and commit any cleanup changes with a short, descriptive message

## Constraints
- Do **not** add new features, refactor logic, or change behaviour
- Do **not** fix bugs you discover unless they are direct artifacts of debug code you removed
- If nothing needs cleanup, report that explicitly
