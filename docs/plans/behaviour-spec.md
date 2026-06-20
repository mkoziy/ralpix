# Behaviour Spec

This file is the rewrite acceptance reference. It is currently being filled in module by module as the rewrite lands.

## Brainstorm

### Event contract

- Brainstorm emits `phase_start` when a session begins and `phase_end` when it completes.
- Each model turn emits `round_start` before the subprocess runs and `round_end` after it finishes, with usage inlined on `round_end`.
- Clarifying prompts emit `question` followed by `answer`. The `answer` event carries the round usage snapshot that produced the prompt.
- Choosing an approach emits `approach_selected`.
- Validating a design section emits `section_validated` with `passed: true` on acceptance and `passed: false` plus `detail` when the user rejects a section with feedback.

### Checkpoint and resume

- Unfinished brainstorm sessions persist a checkpoint file under `.ralpix/progress/brainstorm/<session-name>.checkpoint.json`.
- The checkpoint stores the description, round counter, Q&A history, proposed approaches, selected approach, validated design sections, and rejected-section feedback.
- On the next brainstorm start, ralpix offers unfinished checkpoints plus `Start new brainstorm`.
- Resuming a checkpoint emits a resume-equivalent start marker through `phase_start { label: "resume" }` and records a `milestone` with kind `resume`.
- Completed brainstorm sessions delete their checkpoint file so they do not appear in the resume picker.
- If the brainstorm subprocess fails or the run is interrupted, the latest checkpoint remains on disk and can be resumed later.

## Executor

### Event contract

- Execution emits `task_start` once per task, `attempt_start` for each attempt, `attempt_end` after every subprocess run, and `task_end` once the task succeeds or fails permanently.
- `attempt_end` carries the attempt usage as `step` and the cumulative task usage as `total`.
- `task_end` carries the cumulative task usage and includes `committed: true|false` when `commitEnabled` is on.

### Retry loop and failure handling

- Tasks retry up to `maxRetries + 1` total attempts.
- A normal agent-reported failure consumes one attempt and retries while attempts remain.
- A host-observed material validation failure aborts the retry loop immediately. Material failures are tool execution errors from shell-like tools when the command is a validation/build command such as `test`, `check`, `lint`, `typecheck`, `build`, `pytest`, `vitest`, `jest`, `tsc`, `eslint`, `cargo`, `go`, or `make`.
- A task is only successful when the agent emits the structured `<RALPIX_TASK_RESULT>` block with `Success: true` and the host did not observe a contradictory non-zero exit or material tool failure.

### allDone guard

- The host watches for the exact case-insensitive signal `<<<RALPIX:ALL_TASKS_DONE>>>` in task subprocess output.
- If the signal appears while task checkboxes still remain in any task section, the host ignores the signal, records a guard milestone, and continues normal task scheduling.
- The signal only prevents host-side premature termination; it does not replace plan-file verification.
