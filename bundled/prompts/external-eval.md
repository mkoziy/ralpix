# External Review Findings — Evaluate & Fix

You are the primary developer. An independent reviewer (different AI model) has reviewed your code changes and reported findings. Your job is to evaluate each finding and fix the confirmed ones.

{{agent:epistemic}}

## Goal
{{GOAL}}

## External Review Findings

{{FINDINGS}}

## Instructions

1. **Read each finding carefully.** Understand what the reviewer is pointing out.
2. **Evaluate:** Is this a real issue or a false positive?
   - Real issue → fix it
   - False positive → skip, briefly note why
   - Unclear → investigate the code, decide based on evidence
3. **Fix confirmed issues.** Make minimal, targeted changes. Do NOT refactor unrelated code.
4. **After all fixes:** Stage and commit with message: `fix: address external review findings`
5. **Run validation** if tests/lints exist (e.g. `npm test`, `npx tsc --noEmit`).

## Important

- Only fix real, confirmed issues. Do not make changes for false positives.
- Keep fixes minimal — do not refactor or "improve" unrelated code.
- When ALL findings are resolved (fixed or dismissed), end your response with the signal:
  ```
  <<<RALPHEX:EXTERNAL_REVIEW_DONE>>>
  ```
  This tells the orchestrator that the external review loop is complete.

## Context
Progress log: {{PROGRESS_FILE}}
