import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPiToolText,
  summarizeAssistantProgress,
  summarizePiToolCall,
} from "./pi-subprocess.js";

void test("summarizePiToolCall includes the command for exec_command", () => {
  assert.equal(
    summarizePiToolCall("exec_command", { cmd: "npm run check" }),
    "exec_command npm run check",
  );
});

void test("summarizePiToolCall falls back to a compact key/value preview", () => {
  assert.equal(
    summarizePiToolCall("open", { ref_id: "turn0search0", lineno: 120 }),
    "open ref_id=turn0search0 lineno=120",
  );
});

void test("extractPiToolText and summarizePiToolCall support string tool args", () => {
  assert.equal(
    extractPiToolText("grep -n \"playlist\" api/src/index.ts"),
    "grep -n \"playlist\" api/src/index.ts",
  );
  assert.equal(
    summarizePiToolCall("bash", "grep -n \"playlist\" api/src/index.ts"),
    "bash grep -n \"playlist\" api/src/index.ts",
  );
});

void test("summarizeAssistantProgress strips the ralpix completion block", () => {
  assert.equal(
    summarizeAssistantProgress([
      "Audited config merge behavior and README examples.",
      "",
      "<RALPIX_TASK_RESULT>",
      "Success: true",
      "Summary: done",
      "</RALPIX_TASK_RESULT>",
    ].join("\n")),
    "Audited config merge behavior and README examples.",
  );
});

void test("summarizeAssistantProgress returns null when only the result block remains", () => {
  assert.equal(
    summarizeAssistantProgress([
      "<RALPIX_REVIEW_RESULT>",
      "Success: true",
      "Summary: NO ISSUES FOUND",
      "</RALPIX_REVIEW_RESULT>",
    ].join("\n")),
    null,
  );
});
