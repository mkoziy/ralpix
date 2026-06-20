import { describe, expect, it } from "vitest";

import {
  buildReviewPrompt,
  parseReviewSessionReport,
  resolveReviewSessionReport,
} from "../task-review-subprocess.js";

describe("task-review-subprocess", () => {
  it("adds a completion contract to review prompts", () => {
    const prompt = buildReviewPrompt("# Review", "external");

    expect(prompt).toContain("RALPIX_REVIEW_RESULT");
    expect(prompt).toContain("NO ISSUES FOUND");
    expect(prompt).toContain("Do not end your response without this block.");
  });

  it("parses structured review reports", () => {
    expect(parseReviewSessionReport([
      "Need changes.",
      "<RALPIX_REVIEW_RESULT>",
      "Success: false",
      "Summary: Could not inspect git diff",
      "</RALPIX_REVIEW_RESULT>",
    ].join("\n"))).toEqual({
      success: false,
      summary: "Could not inspect git diff",
    });
  });

  it("rejects unstructured success when the subprocess crashes", () => {
    expect(resolveReviewSessionReport({
      status: "crash",
      success: false,
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "segfault",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      message: "",
    })).toEqual({
      success: false,
      summary: "Review subprocess crashed with exit code 1",
    });
  });
});
