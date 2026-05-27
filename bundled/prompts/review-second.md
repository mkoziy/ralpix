# Second Review Pass — Code Review of: {{GOAL}}

You are performing a second-pass code review, after first-pass fixes were applied.

{{agent:epistemic}}

## Step 1: Get Updated Context
{{DIFF_COMMANDS}}

## Step 2: Review ONLY Critical and Major Issues
Re-examine the code for any remaining:

### Quality (Correctness, Security, Edge Cases)
{{agent:quality}}

### Implementation (Does code achieve stated goals?)
{{agent:implementation}}

Skip minor issues and style nits. Focus only on what matters.

## Step 3: Report Findings
1. **Remaining Critical Issues** — must be fixed before merge
2. **Remaining Major Issues** — should be fixed
3. **Verdict** — `APPROVE` or `NEEDS_WORK`

{{FIX_INSTRUCTIONS}}
