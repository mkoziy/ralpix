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
