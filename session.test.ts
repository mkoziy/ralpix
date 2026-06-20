import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryUiAdapters, createUiStateStore } from "./event-bus.js";

void test("UI state store preserves transcript order across prompt lifecycle", () => {
  const adapters = createMemoryUiAdapters();
  const store = createUiStateStore("plan", adapters.transcriptSink, adapters.summaryRenderer);

  store.applyEvent({
    type: "question_asked",
    phase: "plan",
    promptId: "prompt-1",
    message: "Pick the auth boundary",
    createdAt: "2026-06-19T10:00:00.000Z",
    next: "Select an option",
  });
  store.applyEvent({
    type: "answer_recorded",
    phase: "plan",
    promptId: "prompt-1",
    message: "Reuse the existing session cookie",
    createdAt: "2026-06-19T10:00:01.000Z",
  });
  store.applyEvent({
    type: "milestone",
    phase: "plan",
    kind: "RESULT",
    message: "Draft generated",
    createdAt: "2026-06-19T10:00:02.000Z",
  });

  assert.deepEqual(
    adapters.transcript.map((entry) => [entry.kind, entry.message]),
    [
      ["Q", "Pick the auth boundary"],
      ["A", "Reuse the existing session cookie"],
      ["RESULT", "Draft generated"],
    ],
  );
});

void test("usage checkpoints update summary without depending on TUI rendering", () => {
  const adapters = createMemoryUiAdapters();
  const store = createUiStateStore("review", adapters.transcriptSink, adapters.summaryRenderer);

  store.applyEvent({
    type: "state_changed",
    phase: "review",
    state: "reviewing",
    now: "External audit",
    next: "Wait for findings",
    createdAt: "2026-06-19T10:10:00.000Z",
  });
  store.applyEvent({
    type: "usage_checkpoint",
    phase: "review",
    totalUsageText: "in 2.1k  out 480  $0.032",
    createdAt: "2026-06-19T10:10:05.000Z",
  });

  assert.deepEqual(adapters.getSummary(), {
    phase: "review",
    state: "reviewing",
    now: "External audit",
    next: "Wait for findings",
    totalUsageText: "in 2.1k  out 480  $0.032",
  });
});
