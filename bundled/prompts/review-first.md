# First Review Pass — Code Review of: {{GOAL}}

You are performing a comprehensive code review. Progress log is at: `{{PROGRESS_FILE}}`

{{agent:epistemic}}

## Step 1: Get Context
{{DIFF_COMMANDS}}

## Step 2: Review the Code
Review ALL changes in the diff with fresh eyes. Focus on the following areas:

### Quality (Correctness, Security, Edge Cases)
{{agent:quality}}

### Implementation (Does code achieve stated goals?)
{{agent:implementation}}

### Testing (Coverage and quality)
{{agent:testing}}

### Simplification (Detect over-engineering)
{{agent:simplification}}

### Documentation (Do docs need updates?)
{{agent:documentation}}

## Step 3: Report Findings
After reviewing, produce a structured report:
1. **Critical Issues** (must fix) — list with file locations
2. **Major Issues** (should fix) — list with file locations
3. **Minor Issues** (nice to fix) — list with file locations
4. **Summary** — overall assessment

{{FIX_INSTRUCTIONS}}
