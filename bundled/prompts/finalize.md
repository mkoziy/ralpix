# Finalize: {{GOAL}}

All tasks are complete and reviews have passed.

{{agent:epistemic}}

## Final Actions

1. Run final verification commands to ensure everything works
2. Check that ALL checklist items in the plan are marked complete
3. If `movePlanOnCompletion` is enabled, move the plan to a `completed/` subdirectory
4. Write a brief summary of what was accomplished

## Summary Template
```markdown
## Plan: {{PLAN_TITLE}} — Complete ✓

### What was done
- [List key accomplishments]

### Commits
{{COMMIT_LIST}}

### Review Results
- First pass: {{REVIEW_FIRST_RESULT}}
- Second pass: {{REVIEW_SECOND_RESULT}}
```
