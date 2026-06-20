import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveModel } from "./config.js";
import { runPiSubprocessPrompt } from "./pi-subprocess.js";
import { expandPrompt, loadPrompt } from "./prompt.js";

import type { RunSession } from "./event-bus.js";
import type { EventUsage } from "./events.js";
import type { PiCommand, RunPiSubprocessConfig, SubprocessResult } from "./pi-subprocess.js";
import type { RalpixConfig } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const MAX_BRAINSTORM_ROUNDS = 15;
const START_NEW_BRAINSTORM = "Start new brainstorm";

type BrainstormPhaseTag = "understand" | "approaches" | "design" | "complete";

interface BrainstormQuestion {
  question: string;
  options: string[];
}

interface BrainstormDesignSection {
  title: string;
  content: string;
}

interface BrainstormParsedResponse {
  phase: BrainstormPhaseTag;
  question?: BrainstormQuestion;
  approaches?: string;
  approachOptions?: string[];
  designSection?: BrainstormDesignSection;
  summary?: string;
}

interface BrainstormCheckpoint {
  version: 1;
  sessionName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  currentRound: number;
  qaHistory: Array<{ question: string; answer: string }>;
  approachesText: string;
  selectedApproach: string;
  validatedSections: BrainstormDesignSection[];
  feedbackHistory: Array<{ section: string; feedback: string }>;
}

export interface BrainstormResult {
  sessionName: string;
  summary: string;
  selectedApproach: string;
  validatedSections: BrainstormDesignSection[];
  context: string;
}

export interface BrainstormDependencies {
  now?: () => Date;
  loadPrompt?: (name: string, cwd: string) => string;
  runPrompt?: (
    ctx: ExtensionCommandContext,
    pi: PiCommand,
    prompt: string,
    config: RunPiSubprocessConfig,
    session: RunSession,
  ) => Promise<SubprocessResult>;
}

export async function runBrainstorm(
  ctx: ExtensionCommandContext,
  pi: PiCommand,
  description: string,
  config: RalpixConfig,
  session: RunSession,
  dependencies: BrainstormDependencies = {},
): Promise<BrainstormResult> {
  const now = dependencies.now ?? (() => new Date());
  const checkpointDir = brainstormCheckpointDir(ctx.cwd);
  mkdirSync(checkpointDir, { recursive: true });

  const checkpoint = await restoreOrCreateCheckpoint(
    checkpointDir,
    description.trim(),
    session,
    now,
  );

  session.log("phase_start", checkpoint.currentRound > 0 ? { label: "resume" } : undefined);

  const promptLoader = dependencies.loadPrompt ?? loadPrompt;
  const runPrompt = dependencies.runPrompt ?? runPiSubprocessPrompt;
  const model = resolveModel(config, "brainstorm");

  try {
    for (;;) {
      if (checkpoint.currentRound >= MAX_BRAINSTORM_ROUNDS) {
        throw new Error(`brainstorm exceeded ${String(MAX_BRAINSTORM_ROUNDS)} rounds`);
      }

      checkpoint.currentRound += 1;
      checkpoint.updatedAt = now().toISOString();
      persistCheckpoint(checkpointDir, checkpoint);

      const prompt = buildBrainstormPrompt(promptLoader("brainstorm", ctx.cwd), checkpoint);
      const usageConfig: RunPiSubprocessConfig = {
        ...model,
        piAgentDir: config.piAgentDir,
        timeoutMs: config.brainstormTimeoutMs,
      };

      session.log("round_start", {
        round: checkpoint.currentRound,
        label: `brainstorm ${checkpoint.currentRound}`,
      });

      const result = await runPrompt(ctx, pi, prompt, usageConfig, session);
      const usage = usageFromResult(result);

      if (result.status !== "success") {
        session.log("round_end", { round: checkpoint.currentRound, usage });
        persistCheckpoint(checkpointDir, checkpoint);
        throw new Error(result.message ?? `brainstorm subprocess ${result.status}`);
      }

      const parsed = parseBrainstormResponse(result.message ?? result.stdout);
      if (parsed === null) {
        session.log("round_end", { round: checkpoint.currentRound, usage });
        persistCheckpoint(checkpointDir, checkpoint);
        throw new Error("brainstorm subprocess returned an unparseable response");
      }

      const completed = await applyRoundOutcome(session, checkpoint, parsed, usage);
      session.log("round_end", { round: checkpoint.currentRound, usage });
      checkpoint.updatedAt = now().toISOString();

      if (completed !== null) {
        deleteCheckpoint(checkpointDir, checkpoint.sessionName);
        session.log("phase_end", { label: "complete" });
        return completed;
      }

      persistCheckpoint(checkpointDir, checkpoint);
    }
  } catch (error) {
    persistCheckpoint(checkpointDir, checkpoint);
    throw error;
  }
}

function brainstormCheckpointDir(cwd: string): string {
  return join(cwd, ".ralpix", "progress", "brainstorm");
}

async function restoreOrCreateCheckpoint(
  checkpointDir: string,
  description: string,
  session: RunSession,
  now: () => Date,
): Promise<BrainstormCheckpoint> {
  const checkpoints = listCheckpoints(checkpointDir);

  if (checkpoints.length > 0) {
    const options = [START_NEW_BRAINSTORM, ...checkpoints.map((entry) => checkpointLabel(entry))];
    const choice = await session.choose("Resume brainstorm?", options, {
      title: "Brainstorm Sessions",
    });
    if (choice !== null && choice !== START_NEW_BRAINSTORM) {
      const restored = checkpoints.find((entry) => checkpointLabel(entry) === choice);
      if (restored !== undefined) {
        session.milestone("resume", `Resumed brainstorm session ${restored.sessionName}`);
        return restored;
      }
    }
  }

  const createdAt = now().toISOString();
  return {
    version: 1,
    sessionName: createSessionName(description, now()),
    description,
    createdAt,
    updatedAt: createdAt,
    currentRound: 0,
    qaHistory: [],
    approachesText: "",
    selectedApproach: "",
    validatedSections: [],
    feedbackHistory: [],
  };
}

function listCheckpoints(checkpointDir: string): BrainstormCheckpoint[] {
  if (!existsSync(checkpointDir)) return [];
  return readdirSync(checkpointDir)
    .filter((name) => name.endsWith(".checkpoint.json"))
    .map((name) => join(checkpointDir, name))
    .map(readCheckpointFile)
    .filter((entry): entry is BrainstormCheckpoint => entry !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function readCheckpointFile(filePath: string): BrainstormCheckpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<BrainstormCheckpoint>;
    if (
      parsed.version !== 1 ||
      typeof parsed.sessionName !== "string" ||
      typeof parsed.description !== "string" ||
      typeof parsed.currentRound !== "number"
    ) {
      return null;
    }

    return {
      version: 1,
      sessionName: parsed.sessionName,
      description: parsed.description,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      currentRound: parsed.currentRound,
      qaHistory: Array.isArray(parsed.qaHistory) ? parsed.qaHistory.filter(isQuestionAnswer) : [],
      approachesText: typeof parsed.approachesText === "string" ? parsed.approachesText : "",
      selectedApproach: typeof parsed.selectedApproach === "string" ? parsed.selectedApproach : "",
      validatedSections: Array.isArray(parsed.validatedSections)
        ? parsed.validatedSections.filter(isDesignSection)
        : [],
      feedbackHistory: Array.isArray(parsed.feedbackHistory)
        ? parsed.feedbackHistory.filter(isFeedbackEntry)
        : [],
    };
  } catch {
    return null;
  }
}

function isQuestionAnswer(value: unknown): value is { question: string; answer: string } {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { question?: unknown }).question === "string" &&
    typeof (value as { answer?: unknown }).answer === "string";
}

function isDesignSection(value: unknown): value is BrainstormDesignSection {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { content?: unknown }).content === "string";
}

function isFeedbackEntry(value: unknown): value is { section: string; feedback: string } {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { section?: unknown }).section === "string" &&
    typeof (value as { feedback?: unknown }).feedback === "string";
}

function checkpointLabel(checkpoint: BrainstormCheckpoint): string {
  return `${checkpoint.sessionName} — ${checkpoint.description}`;
}

function checkpointFilePath(checkpointDir: string, sessionName: string): string {
  return join(checkpointDir, `${sessionName}.checkpoint.json`);
}

function persistCheckpoint(checkpointDir: string, checkpoint: BrainstormCheckpoint): void {
  mkdirSync(checkpointDir, { recursive: true });
  writeFileSync(
    checkpointFilePath(checkpointDir, checkpoint.sessionName),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf8",
  );
}

function deleteCheckpoint(checkpointDir: string, sessionName: string): void {
  rmSync(checkpointFilePath(checkpointDir, sessionName), { force: true });
}

function createSessionName(description: string, now: Date): string {
  const stamp = now.toISOString().replaceAll(/[:-]/g, "").replace("T", "-").slice(0, 15);
  const slug = description
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? `${stamp}-${slug}` : `${stamp}-brainstorm`;
}

function buildBrainstormPrompt(template: string, checkpoint: BrainstormCheckpoint): string {
  return expandPrompt(template, {
    DESCRIPTION: checkpoint.description,
    QA_HISTORY: renderQaHistory(checkpoint.qaHistory),
    APPROACHES: checkpoint.approachesText,
    SELECTED_APPROACH: checkpoint.selectedApproach.length > 0
      ? `Selected approach:\n${checkpoint.selectedApproach}`
      : "",
    DESIGN_SECTIONS: renderDesignSections(checkpoint.validatedSections),
    USER_FEEDBACK: renderFeedback(checkpoint.feedbackHistory),
  });
}

function renderQaHistory(qaHistory: Array<{ question: string; answer: string }>): string {
  if (qaHistory.length === 0) return "";
  return qaHistory.map((entry, index) => `Q${String(index + 1)}: ${entry.question}\nA${String(index + 1)}: ${entry.answer}`,
  ).join("\n\n");
}

function renderDesignSections(sections: BrainstormDesignSection[]): string {
  if (sections.length === 0) return "";
  return sections.map((section) => `${section.title}\n${section.content}`).join("\n\n");
}

function renderFeedback(entries: Array<{ section: string; feedback: string }>): string {
  if (entries.length === 0) return "";
  return entries.map((entry) => `${entry.section}: ${entry.feedback}`).join("\n");
}

async function applyRoundOutcome(
  session: RunSession,
  checkpoint: BrainstormCheckpoint,
  parsed: BrainstormParsedResponse,
  usage: EventUsage,
): Promise<BrainstormResult | null> {
  switch (parsed.phase) {
    case "understand": {
      return handleUnderstandRound(session, checkpoint, parsed, usage);
    }
    case "approaches": {
      return handleApproachesRound(session, checkpoint, parsed);
    }
    case "design": {
      return handleDesignRound(session, checkpoint, parsed);
    }
    case "complete": {
      return handleCompleteRound(checkpoint, parsed);
    }
  }
}

async function handleUnderstandRound(
  session: RunSession,
  checkpoint: BrainstormCheckpoint,
  parsed: BrainstormParsedResponse,
  usage: EventUsage,
): Promise<null> {
  const question = parsed.question;
  if (question === undefined) {
    throw new Error("brainstorm understand round missing question");
  }

  const promptId = `brainstorm-q${String(checkpoint.qaHistory.length + 1)}`;
  session.log("question", {
    promptId,
    message: question.question,
    next: "answer",
  });

  const answer = await chooseOrInputAnswer(session, question.question, question.options);
  checkpoint.qaHistory.push({
    question: question.question,
    answer,
  });

  session.log("answer", {
    promptId,
    message: answer,
    usage,
  });
  return null;
}

async function chooseOrInputAnswer(
  session: RunSession,
  prompt: string,
  options: string[],
): Promise<string> {
  if (options.length > 0) {
    const selected = await session.choose(prompt, [...options, "Other"], { title: "Answer" });
    if (selected !== null && selected !== "Other") return selected;
  }

  const typed = await session.input(prompt, { title: "Answer" });
  if (typed !== null && typed.length > 0) return typed;
  return options[0] ?? "No answer provided";
}

async function handleApproachesRound(
  session: RunSession,
  checkpoint: BrainstormCheckpoint,
  parsed: BrainstormParsedResponse,
): Promise<null> {
  if (parsed.approaches === undefined || parsed.approachOptions === undefined || parsed.approachOptions.length === 0) {
    throw new Error("brainstorm approaches round missing options");
  }

  checkpoint.approachesText = parsed.approaches;
  const selected = await chooseApproach(session, parsed.approachOptions);
  checkpoint.selectedApproach = selected;
  session.log("approach_selected", { approach: selected });
  return null;
}

async function chooseApproach(session: RunSession, options: string[]): Promise<string> {
  const selected = await session.choose("Choose an approach", [...options, "Other"], {
    title: "Approaches",
  });
  if (selected !== null && selected !== "Other") return selected;
  const typed = await session.input("Selected approach", { title: "Approach" });
  if (typed !== null && typed.length > 0) return typed;
  return options[0] ?? "Approach A";
}

async function handleDesignRound(
  session: RunSession,
  checkpoint: BrainstormCheckpoint,
  parsed: BrainstormParsedResponse,
): Promise<null> {
  const section = parsed.designSection;
  if (section === undefined) {
    throw new Error("brainstorm design round missing design section");
  }

  const accepted = await session.confirm(`Validate ${section.title}?`, {
    body: section.content,
    historyLabel: section.title,
  });

  if (accepted) {
    checkpoint.validatedSections.push(section);
    session.log("section_validated", {
      section: section.title,
      passed: true,
    });
    return null;
  }

  const feedback = await session.input(`Feedback for ${section.title}`, {
    title: "Section Feedback",
    placeholder: "What should change?",
  });

  if (feedback !== null && feedback.length > 0) {
    checkpoint.feedbackHistory.push({
      section: section.title,
      feedback,
    });
  }

  session.log("section_validated", {
    section: section.title,
    passed: false,
    ...(feedback !== null && feedback.length > 0 ? { detail: feedback } : {}),
  });
  return null;
}

function handleCompleteRound(
  checkpoint: BrainstormCheckpoint,
  parsed: BrainstormParsedResponse,
): BrainstormResult {
  if (parsed.summary === undefined) {
    throw new Error("brainstorm complete round missing summary");
  }

  return {
    sessionName: checkpoint.sessionName,
    summary: parsed.summary,
    selectedApproach: checkpoint.selectedApproach,
    validatedSections: [...checkpoint.validatedSections],
    context: renderCompletedContext(checkpoint, parsed.summary),
  };
}

function renderCompletedContext(checkpoint: BrainstormCheckpoint, summary: string): string {
  const parts = [
    `Description: ${checkpoint.description}`,
    checkpoint.selectedApproach.length > 0 ? `Selected approach: ${checkpoint.selectedApproach}` : "",
    checkpoint.validatedSections.length > 0
      ? checkpoint.validatedSections.map((section) => `${section.title}\n${section.content}`).join("\n\n")
      : "",
    summary,
  ].filter((value) => value.length > 0);
  return parts.join("\n\n");
}

function parseBrainstormResponse(output: string): BrainstormParsedResponse | null {
  const phase = extractTag(output, "RALPIX_PHASE")?.trim().toLowerCase();
  if (phase !== "understand" && phase !== "approaches" && phase !== "design" && phase !== "complete") {
    return null;
  }

  if (phase === "understand") {
    const block = extractTag(output, "RALPIX_QUESTION");
    if (block === null) return null;
    return {
      phase,
      question: parseQuestionBlock(block),
    };
  }

  if (phase === "approaches") {
    const block = extractTag(output, "RALPIX_APPROACHES");
    if (block === null) return null;
    return {
      phase,
      approaches: block.trim(),
      approachOptions: extractApproachTitles(block),
    };
  }

  if (phase === "design") {
    const block = extractTag(output, "RALPIX_DESIGN_SECTION");
    if (block === null) return null;
    const section = parseDesignSection(block);
    return section === null ? null : { phase, designSection: section };
  }

  const summary = extractTag(output, "RALPIX_SUMMARY");
  return summary === null ? null : { phase, summary: summary.trim() };
}

function extractTag(text: string, tag: string): string | null {
  const match = new RegExp(String.raw`<${tag}>([\s\S]*?)<\/${tag}>`, "i").exec(text);
  return match?.[1]?.trim() ?? null;
}

function parseQuestionBlock(block: string): BrainstormQuestion {
  const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const questionLine = lines.find((line) => line.startsWith("Question:"));
  const question = questionLine?.replace(/^Question:\s*/u, "").trim() ?? block.trim();
  const optionStart = lines.findIndex((line) => line.startsWith("Options:"));
  const options = optionStart === -1
    ? []
    : lines.slice(optionStart + 1)
      .filter((line) => line.startsWith("-"))
      .map((line) => line.replace(/^-+\s*/u, "").trim())
      .filter((line) => line.length > 0);
  return { question, options };
}

function extractApproachTitles(block: string): string[] {
  return block
    .split("\n")
    .map((line) => (/^##\s+[^:]+:\s*(.+?)(?:\s+\(|$)/u).exec(line.trim())?.[1]?.trim() ?? null)
    .filter((line): line is string => line !== null && line.length > 0);
}

function parseDesignSection(block: string): BrainstormDesignSection | null {
  const trimmed = block.trim();
  const lines = trimmed.split("\n");
  const title = lines[0]?.trim();
  if (title === undefined) return null;
  if (!title.startsWith("##")) return null;
  const normalizedTitle = title.replace(/^##\s*/u, "").trim();
  const content = lines.slice(1).join("\n").trim();
  return {
    title: normalizedTitle,
    content,
  };
}

function usageFromResult(result: SubprocessResult): EventUsage {
  return {
    step: { ...result.usage },
    total: {
      input: result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
      output: result.usage.output,
      cost: result.usage.cost,
    },
  };
}
