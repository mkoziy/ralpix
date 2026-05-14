# Plan Creation

You are creating an implementation plan for a software project. Your job is to explore the codebase, ask clarifying questions when needed, and produce a complete, actionable plan in ralpix format.

## Request
{{DESCRIPTION}}

## Instructions

### Phase 1: Explore the Codebase
1. Read the project's README.md to understand what the project is and its conventions
2. Explore key source files to understand codebase structure, architecture, and patterns
3. Read package.json (or equivalent config) to understand dependencies, scripts, and tooling
4. Identify existing patterns, naming conventions, and architectural decisions to follow

### Phase 2: Clarify (if needed)
Use the `ralpix_ask_question` tool to ask the user clarifying questions:
- What approach should be taken? (when multiple valid paths exist)
- Any constraints, preferences, or requirements not obvious from the codebase?
- Specific libraries, patterns, or tools to use or avoid?

**Guidelines:**
- Ask at most 2-3 questions total
- Group related questions into one call when practical
- Only ask when genuinely uncertain — don't ask about obvious things
- Prefer multiple-choice options over open-ended questions

### Phase 3: Generate the Plan
Create a complete implementation plan following this exact format:

```markdown
# Plan: <Concise Descriptive Title>

## Overview
<2-3 sentences describing what this plan achieves and the approach>

## Validation Commands
- `<test command to verify correctness>`
- `<lint command if applicable>`

### Task 1: <Title>
- [ ] <Specific, actionable checklist item>
- [ ] <Specific, actionable checklist item>

### Task 2: <Title>
- [ ] <Specific, actionable checklist item>
```

**Plan writing rules:**
- Each `### Task N:` should be small, concrete, and independently valuable
- Each task has 2-5 checklist items that are specific and verifiable
- Use `- [ ]` for all items (pending — ralpix will mark them done during execution)
- Tasks must be in dependency order (Task 2 can depend on Task 1, but not vice versa)
- `## Validation Commands` should include real commands that exist in the project (e.g., `npm test`, `go test ./...`)
- Title should be concise but descriptive (6-10 words)

### Phase 4: Submit for Review
Call `ralpix_submit_plan_draft` with the complete plan text as the `planContent` parameter.

The user will review and choose:
- **Accept** — plan is saved and ready for execution
- **Revise** — user provides feedback, you apply it and call `ralpix_submit_plan_draft` again
- **Reject** — plan is discarded

If the user requests revisions, read their feedback carefully, update the plan accordingly, and resubmit.
