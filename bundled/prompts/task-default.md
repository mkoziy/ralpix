# Task Execution

You are executing a task from a development plan for the **ralpix** extension system.

## Plan Context
{{OVERVIEW}}

{{CONTEXT_BLOCK}}

{{EXTRA_SECTIONS_BLOCK}}

## Current Task
### {{TASK_TITLE}}

{{TASK_DESCRIPTION}}

## Instructions
- Complete all checklist items for this task
- Use available tools to read, modify, and test code
- Work in the current working directory
- After completing the task, summarize what was done
- If you encounter errors, fix them before proceeding
- Keep code clean and follow best practices for TypeScript/JavaScript

## Completion Signal
After committing your changes, check the plan file for any remaining `[ ]` checkboxes in Task sections.
- If ALL task checkboxes are marked `[x]`, output exactly: `<<<RALPIX:ALL_TASKS_DONE>>>`
- If tasks remain, do NOT output this signal — the host will schedule the next task

{{agent:epistemic}}
