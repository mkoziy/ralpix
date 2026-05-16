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
If clarification is needed, ask using this exact output block and nothing else:

```text
<RALPIX_QUESTION>
Question: <single concise question>
Options:
- <option 1>
- <option 2>
- <option 3>
</RALPIX_QUESTION>
```

Guidelines:
- What approach should be taken? (when multiple valid paths exist)
- Any constraints, preferences, or requirements not obvious from the codebase?
- Specific libraries, patterns, or tools to use or avoid?

- Ask at most 2-3 questions total
- Ask one question at a time
- Only ask when genuinely uncertain — don't ask about obvious things
- Prefer multiple-choice options over open-ended questions

### Phase 3: Generate the Plan
Create a complete implementation plan following this exact format:

```markdown
# Plan: <Concise Descriptive Title>

## Overview
<2-3 sentences describing what this plan achieves and the approach>

## Success Criteria
- [ ] `<observable outcome proving the feature works>`
- [ ] `<relevant verification command passes>`

### Task 1: <Title>
- [ ] <Specific, actionable checklist item>
- [ ] <Specific, actionable checklist item>

### Task 2: <Title>
- [ ] <Specific, actionable checklist item>
```

**Plan writing rules:**
- The plan title must stay tightly aligned to the user's request. Do not invent a different feature, subsystem, or theme.
- Reuse the user's wording for the core feature when possible so the title and overview are obviously about the requested work.
- Each `### Task N:` should be small, concrete, and independently valuable
- Each task has 2-5 checklist items that are specific and verifiable
- Use `- [ ]` for all items (pending — ralpix will mark them done during execution)
- Tasks must be in dependency order (Task 2 can depend on Task 1, but not vice versa)
- `## Success Criteria` should be concrete and testable, and should mention real verification commands when applicable (e.g., `npm test`, `go test ./...`)
- Title should be concise but descriptive (6-10 words)
- Do not wrap the plan in fenced code blocks

### Phase 4: Final Output
When you have enough context, output only the full plan markdown (no extra prose).
