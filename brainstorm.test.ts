import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleApproachesPhase, handleDesignPhase, handleUnderstandPhase } from "./brainstorm.js";

import type { AgentEvent } from "./events.js";
import type { RunSession } from "./event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StubSessionOptions {
  chooseResult?: string | null;
  inputResult?: string | null;
}

function makeStubSession(opts: StubSessionOptions = {}): { session: RunSession; events: AgentEvent[] } {
  const events: AgentEvent[] = [];

  const session: RunSession = {
    async choose(_prompt, _options) {
      return opts.chooseResult ?? null;
    },
    clearStatus() { return; },
    close() { return; },
    async confirm() { return null; },
    async input(_prompt) {
      return opts.inputResult ?? null;
    },
    log(eventType: string, data: Record<string, unknown> = {}): void {
      events.push({ type: eventType, phase: "brainstorm", createdAt: new Date().toISOString(), ...data } as AgentEvent);
    },
    message() { return; },
    phase() { return; },
    snapshot() { return { events: [], summary: null, transcript: [] }; },
    status() { return; },
    usage() { return; },
  };

  return { session, events };
}

function makeCheckpoint(round = 0) {
  return {
    version: 1 as const,
    sessionId: "test-session",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active" as const,
    round,
    description: "test brainstorm",
    logSessionName: "test-log",
    state: {
      description: "test brainstorm",
      qaHistory: [],
      approachesText: null,
      selectedApproach: null,
      designSections: [],
      pendingSection: null,
      pendingFeedback: null,
    },
    lastError: null,
  };
}

function makeTmpDir(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "brainstorm-test-"));
  return {
    cwd,
    cleanup() { rmSync(cwd, { recursive: true, force: true }); },
  };
}

const QUESTION_OUTPUT = `
<ralpix_phase>understand</ralpix_phase>
<ralpix_question>
question: What is the primary goal?
- Option A
- Option B
</ralpix_question>
`.trim();

const APPROACHES_OUTPUT = `
<ralpix_phase>approaches</ralpix_phase>
<ralpix_approaches>
## Option Alpha: Simple approach
Go simple.

## Option Beta: Complex approach
Go complex.
</ralpix_approaches>
`.trim();

const DESIGN_OUTPUT = `
<ralpix_phase>design</ralpix_phase>
<ralpix_design_section>
## Auth Design
Use OAuth2.
</ralpix_design_section>
`.trim();

// ---------------------------------------------------------------------------
// handleUnderstandPhase
// ---------------------------------------------------------------------------

void test("handleUnderstandPhase emits question event with promptId and message", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: "Option A" });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleUnderstandPhase(QUESTION_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    const questionEvent = events.find((e) => e.type === "question");
    assert.ok(questionEvent != null, "question event should be emitted");
    if (questionEvent.type === "question") {
      assert.equal(questionEvent.phase, "brainstorm");
      assert.ok(questionEvent.promptId.length > 0);
      assert.ok(questionEvent.message.includes("What is the primary goal"));
      assert.ok(typeof questionEvent.createdAt === "string");
    }
  } finally {
    tmp.cleanup();
  }
});

void test("handleUnderstandPhase emits answer event after user responds", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: "Option A" });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleUnderstandPhase(QUESTION_OUTPUT, state, tmp.cwd, session, 2, checkpoint);

    const answerEvent = events.find((e) => e.type === "answer");
    assert.ok(answerEvent != null, "answer event should be emitted");
    if (answerEvent.type === "answer") {
      assert.equal(answerEvent.phase, "brainstorm");
      assert.ok(answerEvent.promptId.length > 0);
      assert.equal(answerEvent.message, "Option A");
    }
  } finally {
    tmp.cleanup();
  }
});

void test("handleUnderstandPhase question and answer share the same promptId", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: "Option B" });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleUnderstandPhase(QUESTION_OUTPUT, state, tmp.cwd, session, 3, checkpoint);

    const q = events.find((e) => e.type === "question");
    const a = events.find((e) => e.type === "answer");
    assert.ok(q != null && a != null);
    if (q.type === "question" && a.type === "answer") {
      assert.equal(q.promptId, a.promptId);
    }
  } finally {
    tmp.cleanup();
  }
});

void test("handleUnderstandPhase returns cancel when user cancels", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: null });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    const result = await handleUnderstandPhase(QUESTION_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    assert.equal(result, "cancel");
    assert.ok(events.every((e) => e.type !== "answer"), "no answer event on cancel");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// handleApproachesPhase
// ---------------------------------------------------------------------------

void test("handleApproachesPhase emits approach_selected with approach field", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: "Alpha: Simple approach" });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleApproachesPhase(APPROACHES_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    const event = events.find((e) => e.type === "approach_selected");
    assert.ok(event != null, "approach_selected event should be emitted");
    if (event.type === "approach_selected") {
      assert.equal(event.phase, "brainstorm");
      assert.ok(typeof event.approach === "string" && event.approach.length > 0);
      assert.ok(typeof event.createdAt === "string");
    }
  } finally {
    tmp.cleanup();
  }
});

void test("handleApproachesPhase returns cancel when user cancels", async () => {
  const tmp = makeTmpDir();
  try {
    const { session } = makeStubSession({ chooseResult: null });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    const result = await handleApproachesPhase(APPROACHES_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    assert.equal(result, "cancel");
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// handleDesignPhase
// ---------------------------------------------------------------------------

void test("handleDesignPhase emits section_validated with passed=true on accept", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: "✓ Looks good — continue" });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleDesignPhase(DESIGN_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    const event = events.find((e) => e.type === "section_validated");
    assert.ok(event != null, "section_validated event should be emitted");
    if (event.type === "section_validated") {
      assert.equal(event.phase, "brainstorm");
      assert.equal(event.section, "Auth Design");
      assert.equal(event.passed, true);
      assert.equal(event.detail, undefined);
      assert.ok(typeof event.createdAt === "string");
    }
  } finally {
    tmp.cleanup();
  }
});

void test("handleDesignPhase emits section_validated with passed=true and detail on skip", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({ chooseResult: "⏩ Skip to summary" });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleDesignPhase(DESIGN_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    const event = events.find((e) => e.type === "section_validated");
    assert.ok(event != null);
    if (event.type === "section_validated") {
      assert.equal(event.passed, true);
      assert.equal(event.detail, "skipped_to_summary");
    }
  } finally {
    tmp.cleanup();
  }
});

void test("handleDesignPhase emits section_validated with passed=false and feedback on revision", async () => {
  const tmp = makeTmpDir();
  try {
    const { session, events } = makeStubSession({
      chooseResult: "✎ Needs changes — provide feedback",
      inputResult: "Missing rate limiting",
    });
    const state = makeCheckpoint().state;
    const checkpoint = makeCheckpoint();

    await handleDesignPhase(DESIGN_OUTPUT, state, tmp.cwd, session, 1, checkpoint);

    const event = events.find((e) => e.type === "section_validated");
    assert.ok(event != null);
    if (event.type === "section_validated") {
      assert.equal(event.passed, false);
      assert.equal(event.detail, "Missing rate limiting");
    }
  } finally {
    tmp.cleanup();
  }
});
