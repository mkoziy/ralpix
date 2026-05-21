import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPrompt, parseTaskSessionReport } from "./executor.js";
import { buildReviewPrompt, parseReviewSessionReport } from "./reviewer.js";
void test("buildTaskPrompt requires a structured task result block", () => {
    const prompt = buildTaskPrompt("# Task");
    assert.match(prompt, /RALPIX_TASK_RESULT/);
    assert.match(prompt, /success: true|false/i);
    assert.match(prompt, /do not end your response without this block/i);
});
void test("parseTaskSessionReport extracts success and summary", () => {
    assert.deepEqual(parseTaskSessionReport([
        "Work complete.",
        "<RALPIX_TASK_RESULT>",
        "Success: true",
        "Summary: Updated README and config docs",
        "</RALPIX_TASK_RESULT>",
    ].join("\n")), {
        success: true,
        summary: "Updated README and config docs",
    });
});
void test("buildReviewPrompt requires a structured review result block", () => {
    const prompt = buildReviewPrompt("# Review", "external");
    assert.match(prompt, /RALPIX_REVIEW_RESULT/);
    assert.match(prompt, /NO ISSUES FOUND/);
});
void test("parseReviewSessionReport extracts failure and summary", () => {
    assert.deepEqual(parseReviewSessionReport([
        "Need changes.",
        "<RALPIX_REVIEW_RESULT>",
        "Success: false",
        "Summary: Could not inspect git diff",
        "</RALPIX_REVIEW_RESULT>",
    ].join("\n")), {
        success: false,
        summary: "Could not inspect git diff",
    });
});
//# sourceMappingURL=task-review-subprocess.test.js.map