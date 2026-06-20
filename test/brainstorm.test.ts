import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBrainstorm } from "../brainstorm.js";
import { agentEventSchema } from "../event-bus.js";

import { stubRunSession } from "./stubs.js";

import type { RalpixConfig } from "../types.js";

const CONFIG: RalpixConfig = {
  defaultModel: "gpt-5.5",
  defaultProvider: "openai-codex",
  defaultEffort: "medium",
  piAgentDir: null,
  commitEnabled: true,
  commitMessageTemplate: "ralpix: {{taskTitle}}",
  reviewEnabled: true,
  reviewFirstModel: "gpt-5.5",
  reviewSecondModel: "gpt-5.5",
  reviewFirstEffort: "medium",
  reviewSecondEffort: "medium",
  maxRetries: 2,
  reviewMaxRetries: 1,
  reviewTimeoutMs: 1000,
  brainstormTimeoutMs: 1000,
  reviewMaxIterations: 3,
  externalReviewEnabled: false,
  externalReviewModel: null,
  externalReviewEffort: null,
  externalReviewMaxIterations: 1,
  externalReviewPatience: 1,
  planModel: "gpt-5.5",
  planEffort: "medium",
  brainstormEnabled: true,
  brainstormModel: "gpt-5.5",
  brainstormEffort: "medium",
  plansDir: "docs/plans",
  epistemicEnabled: false,
  trainingCutoff: null,
  highRiskLibraries: null,
};

function makeCtx(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      input: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      custom: vi.fn(),
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
    sessionManager: {
      appendModelChange: vi.fn(),
      appendThinkingLevelChange: vi.fn(),
      getEntries: vi.fn().mockReturnValue([]),
    },
    newSession: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function usage(cost: number) {
  return {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 0,
    cost,
  };
}

describe("runBrainstorm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the documented brainstorm event flow and clears the checkpoint on completion", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-brainstorm-"));
    const session = stubRunSession();
    session.choose
      .mockResolvedValueOnce("API-only")
      .mockResolvedValueOnce("Thin slice");
    session.confirm.mockResolvedValueOnce(true);

    const runPrompt = vi.fn()
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.001),
        message: [
          "<RALPIX_PHASE>understand</RALPIX_PHASE>",
          "<RALPIX_QUESTION>",
          "Question: Which surface matters first?",
          "Options:",
          "- API-only",
          "- Web app",
          "</RALPIX_QUESTION>",
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.002),
        message: [
          "<RALPIX_PHASE>approaches</RALPIX_PHASE>",
          "<RALPIX_APPROACHES>",
          "## Option A: Thin slice (recommended)",
          "- how it works: isolate one adapter",
          "- pros: fast",
          "- cons: limited",
          "",
          "## Option B: Big bang",
          "- how it works: rewrite everything",
          "</RALPIX_APPROACHES>",
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.003),
        message: [
          "<RALPIX_PHASE>design</RALPIX_PHASE>",
          "<RALPIX_DESIGN_SECTION>",
          "## Architecture",
          "Keep phase logic behind RunSession and route subprocess work through a dedicated helper.",
          "</RALPIX_DESIGN_SECTION>",
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.004),
        message: [
          "<RALPIX_PHASE>complete</RALPIX_PHASE>",
          "<RALPIX_SUMMARY>",
          "Validated an API-first brainstorm with a thin-slice adapter strategy.",
          "</RALPIX_SUMMARY>",
        ].join("\n"),
      });

    const result = await runBrainstorm(
      makeCtx(cwd),
      {},
      "Design the brainstorm rewrite",
      CONFIG,
      session,
      {
        loadPrompt: () => "{{DESCRIPTION}}\n{{QA_HISTORY}}\n{{APPROACHES}}\n{{SELECTED_APPROACH}}\n{{DESIGN_SECTIONS}}\n{{USER_FEEDBACK}}",
        runPrompt,
      },
    );

    expect(result.selectedApproach).toBe("Thin slice");
    expect(result.summary).toContain("Validated an API-first brainstorm");
    expect(result.validatedSections).toEqual([{
      title: "Architecture",
      content: "Keep phase logic behind RunSession and route subprocess work through a dedicated helper.",
    }]);

    const eventNames = session.log.mock.calls.map(([type]) => type);
    expect(eventNames).toEqual([
      "phase_start",
      "round_start",
      "question",
      "answer",
      "round_end",
      "round_start",
      "approach_selected",
      "round_end",
      "round_start",
      "section_validated",
      "round_end",
      "round_start",
      "round_end",
      "phase_end",
    ]);

    for (const [type, data] of session.log.mock.calls) {
      const parsed = agentEventSchema.safeParse({
        type,
        phase: "brainstorm",
        createdAt: "2026-06-20T00:00:00.000Z",
        ...data,
      });
      expect(parsed.success).toBe(true);
    }

    const answerCall = session.log.mock.calls.find(([type]) => type === "answer");
    expect(answerCall?.[1]).toMatchObject({
      promptId: "brainstorm-q1",
      message: "API-only",
      usage: {
        step: usage(0.001),
        total: { input: 12, output: 4, cost: 0.001 },
      },
    });

    expect(existsSync(join(cwd, ".ralpix", "progress", "brainstorm", `${result.sessionName}.checkpoint.json`))).toBe(false);
  });

  it("restores the latest checkpoint, emits a resume marker, and keeps failed validation feedback", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-brainstorm-resume-"));
    const progressDir = join(cwd, ".ralpix", "progress", "brainstorm");
    const sessionName = "20260620-120000-existing";
    vi.stubEnv("TZ", "UTC");

    const checkpointPath = join(progressDir, `${sessionName}.checkpoint.json`);
    vi.mocked(vi.fn());

    const checkpoint = {
      version: 1,
      sessionName,
      description: "Resume brainstorm",
      createdAt: "2026-06-20T12:00:00.000Z",
      updatedAt: "2026-06-20T12:05:00.000Z",
      currentRound: 2,
      qaHistory: [{ question: "Need auth?", answer: "Yes" }],
      approachesText: "## Option A: Event bus",
      selectedApproach: "Event bus",
      validatedSections: [],
      feedbackHistory: [],
    };

    const dir = join(cwd, ".ralpix", "progress", "brainstorm");
    await import("node:fs").then(({ mkdirSync, writeFileSync }) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    });

    const session = stubRunSession();
    session.choose.mockResolvedValueOnce(`${sessionName} — Resume brainstorm`);
    session.confirm.mockResolvedValueOnce(false);
    session.input.mockResolvedValueOnce("Need a retry-safe checkpoint format.");

    const runPrompt = vi.fn()
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.002),
        message: [
          "<RALPIX_PHASE>design</RALPIX_PHASE>",
          "<RALPIX_DESIGN_SECTION>",
          "## Persistence",
          "Persist one checkpoint file per brainstorm session and rewrite it after each confirmed round.",
          "</RALPIX_DESIGN_SECTION>",
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.003),
        message: [
          "<RALPIX_PHASE>complete</RALPIX_PHASE>",
          "<RALPIX_SUMMARY>",
          "Resumed the brainstorm and captured persistence feedback before completion.",
          "</RALPIX_SUMMARY>",
        ].join("\n"),
      });

    const result = await runBrainstorm(
      makeCtx(cwd),
      {},
      "Ignored because checkpoint resumes",
      CONFIG,
      session,
      {
        loadPrompt: () => "{{DESCRIPTION}}\n{{QA_HISTORY}}\n{{APPROACHES}}\n{{SELECTED_APPROACH}}\n{{DESIGN_SECTIONS}}\n{{USER_FEEDBACK}}",
        runPrompt,
      },
    );

    expect(result.sessionName).toBe(sessionName);
    expect(session.milestone).toHaveBeenCalledWith("resume", `Resumed brainstorm session ${sessionName}`);
    expect(session.log).toHaveBeenNthCalledWith(1, "phase_start", { label: "resume" });
    expect(session.log).toHaveBeenCalledWith("section_validated", {
      section: "Persistence",
      passed: false,
      detail: "Need a retry-safe checkpoint format.",
    });
    expect(runPrompt.mock.calls[1]?.[2]).toContain("Persistence: Need a retry-safe checkpoint format.");
    expect(existsSync(checkpointPath)).toBe(false);
  });

  it("keeps an unfinished checkpoint when the subprocess fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ralpix-brainstorm-failure-"));
    const session = stubRunSession();
    session.choose.mockResolvedValueOnce("Web app");

    const runPrompt = vi.fn()
      .mockResolvedValueOnce({
        status: "success",
        success: true,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.001),
        message: [
          "<RALPIX_PHASE>understand</RALPIX_PHASE>",
          "<RALPIX_QUESTION>",
          "Question: Which surface matters first?",
          "Options:",
          "- Web app",
          "- CLI",
          "</RALPIX_QUESTION>",
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        status: "failure",
        success: false,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        usage: usage(0.002),
        message: "subprocess failed",
      });

    await expect(runBrainstorm(
      makeCtx(cwd),
      {},
      "Failure case",
      CONFIG,
      session,
      {
        loadPrompt: () => "{{DESCRIPTION}}\n{{QA_HISTORY}}\n{{APPROACHES}}\n{{SELECTED_APPROACH}}\n{{DESIGN_SECTIONS}}\n{{USER_FEEDBACK}}",
        runPrompt,
      },
    )).rejects.toThrow("subprocess failed");

    const checkpointDir = join(cwd, ".ralpix", "progress", "brainstorm");
    const checkpointFiles = await import("node:fs").then(({ readdirSync }) => readdirSync(checkpointDir).filter((name) => name.endsWith(".checkpoint.json")));

    expect(checkpointFiles).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(checkpointDir, checkpointFiles[0] ?? ""), "utf8")) as {
      currentRound: number;
      qaHistory: Array<{ answer: string }>;
    };
    expect(saved.currentRound).toBe(2);
    expect(saved.qaHistory).toEqual([{ question: "Which surface matters first?", answer: "Web app" }]);
  });
});
