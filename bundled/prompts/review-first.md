# First Review Pass — Code Review of: {{GOAL}}

You are performing a comprehensive code review. Progress log is at: `{{PROGRESS_FILE}}`

## Step 1: Get Branch Context
Run these commands to understand what changed:
```bash
git log main..HEAD --oneline
git diff main...HEAD --stat
git diff main...HEAD
```

If `main` doesn't exist, try `master` or `origin/main`.

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

## Step 4: Fix Issues
For each critical and major issue, fix it using the available tools.
After each fix, verify it compiles and works.
Commit with: `ralpix: review - fix <brief description>`
