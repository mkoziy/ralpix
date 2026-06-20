import { runPiSubprocessPrompt } from "./pi-subprocess.js";

import type { RunSession } from "./event-bus.js";
import type { PiCommand, RunPiSubprocessConfig, SubprocessResult } from "./pi-subprocess.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ReviewPromptPhase = "first" | "second" | "external" | "eval";

export interface ReviewSessionReport {
  success: boolean;
  summary: string;
}

export interface TaskReviewSubprocessResult extends SubprocessResult {
  report: ReviewSessionReport;
}

const REVIEW_RESULT_RE = /<ralpix_review_result>\s*([\S\s]*?)\s*<\/ralpix_review_result>/i;
const REVIEW_SUCCESS_RE = /^\s*success:\s*(true|false)\s*$/im;
const REVIEW_SUMMARY_RE = /^\s*summary:\s*(.+)$/im;

export function buildReviewPrompt(promptContent: string, phase: ReviewPromptPhase): string {
  const lines = [
    promptContent,
    "",
    "## Completion Contract",
    "End your final response with this exact block and nothing after it:",
    "<RALPIX_REVIEW_RESULT>",
    "Success: true|false",
    "Summary: <one-line concise summary>",
    "</RALPIX_REVIEW_RESULT>",
  ];

  if (phase === "external") {
    lines.push(
      "Use `Success: true` and put the exact review findings in `Summary`.",
      "If the review is clean, set `Summary` to exactly `NO ISSUES FOUND`.",
      "Use `Success: false` only if you cannot complete the review.",
    );
  } else if (phase === "eval") {
    lines.push(
      "Use `Success: true` with a concise summary of what you evaluated and fixed.",
      "Include `EXTERNAL_REVIEW_DONE` in `Summary` when all findings are resolved.",
      "Use `Success: false` only if you cannot complete the evaluation.",
    );
  } else {
    lines.push(
      "Use `Success: true` with a concise summary when the review pass completes.",
      "Use `Success: false` with the blocker or failure reason when you cannot complete the review.",
    );
  }

  lines.push("Do not end your response without this block.");
  return lines.join("\n");
}

export function parseReviewSessionReport(text: string): ReviewSessionReport | null {
  const match = REVIEW_RESULT_RE.exec(text);
  if (match?.[1] === undefined) return null;

  const body = match[1];
  const successMatch = REVIEW_SUCCESS_RE.exec(body);
  const summaryMatch = REVIEW_SUMMARY_RE.exec(body);
  if (successMatch?.[1] === undefined || summaryMatch?.[1] === undefined) {
    return null;
  }

  const summary = summaryMatch[1].trim();
  if (summary.length === 0) return null;

  return {
    success: successMatch[1].toLowerCase() === "true",
    summary,
  };
}

export function resolveReviewSessionReport(result: SubprocessResult): ReviewSessionReport {
  const parsed = parseReviewSessionReport(result.message ?? "");
  if (parsed !== null) {
    if (result.status === "crash" && parsed.success) {
      return {
        success: false,
        summary: `Review session crashed despite reporting success: ${parsed.summary}`,
      };
    }
    return parsed;
  }

  if (result.status === "crash") {
    return {
      success: false,
      summary: fallbackSummary(
        result.message,
        `Review subprocess crashed with exit code ${String(result.exitCode)}`,
      ),
    };
  }

  if (result.status === "failure") {
    return {
      success: false,
      summary: fallbackSummary(result.message, "Review subprocess reported failure"),
    };
  }

  return {
    success: false,
    summary: "Review session did not report a structured result",
  };
}

function fallbackSummary(value: string | undefined, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return fallback;
}

export async function runTaskReviewSubprocess(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  promptContent: string,
  config: RunPiSubprocessConfig,
  session: RunSession,
  phase: ReviewPromptPhase,
): Promise<TaskReviewSubprocessResult> {
  const result = await runPiSubprocessPrompt(
    ctx,
    pi,
    buildReviewPrompt(promptContent, phase),
    config,
    session,
  );

  return {
    ...result,
    report: resolveReviewSessionReport(result),
  };
}
