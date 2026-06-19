import assert from "node:assert/strict";
import test from "node:test";

import { buildTaskPrompt, parseTaskSessionReport, resolveTaskSessionReport } from "./executor.js";
import { buildReviewPrompt, parseReviewSessionReport } from "./reviewer.js";

void test("buildTaskPrompt requires a structured task result block", () => {
  const prompt = buildTaskPrompt("# Task");

  assert.match(prompt, /RALPIX_TASK_RESULT/);
  assert.match(prompt, /success: true|false/i);
  assert.match(prompt, /do not end your response without this block/i);
});

void test("parseTaskSessionReport extracts success and summary", () => {
  assert.deepEqual(
    parseTaskSessionReport([
      "Work complete.",
      "<RALPIX_TASK_RESULT>",
      "Success: true",
      "Summary: Updated README and config docs",
      "</RALPIX_TASK_RESULT>",
    ].join("\n")),
    {
      success: true,
      summary: "Updated README and config docs",
    },
  );
});

void test("resolveTaskSessionReport rejects structured success when the child exits non-zero", () => {
  assert.deepEqual(
    resolveTaskSessionReport(
      {
        exitCode: 1,
        output: "",
        error: "",
        lastAssistantText: [
          "<RALPIX_TASK_RESULT>",
          "Success: true",
          "Summary: Tests passed",
          "</RALPIX_TASK_RESULT>",
        ].join("\n"),
      },
      {
        success: true,
        summary: "Tests passed",
      },
    ),
    {
      success: false,
      summary: "Task session exited with code 1 despite reporting success",
    },
  );
});

void test("buildReviewPrompt requires a structured review result block", () => {
  const prompt = buildReviewPrompt("# Review", "external");

  assert.match(prompt, /RALPIX_REVIEW_RESULT/);
  assert.match(prompt, /NO ISSUES FOUND/);
});

void test("parseReviewSessionReport extracts failure and summary", () => {
  assert.deepEqual(
    parseReviewSessionReport([
      "Need changes.",
      "<RALPIX_REVIEW_RESULT>",
      "Success: false",
      "Summary: Could not inspect git diff",
      "</RALPIX_REVIEW_RESULT>",
    ].join("\n")),
    {
      success: false,
      summary: "Could not inspect git diff",
    },
  );
});
