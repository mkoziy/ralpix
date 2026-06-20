/**
 * Interactive brainstorm — collaborative design dialogue before plan creation.
 *
 * Explores the problem space through questions, proposes approaches,
 * validates design sections incrementally, and produces a structured
 * context string that feeds into plan creation.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveModel, resolvePiAgentDir } from "./config.js";
import { createEventBus, formatOptions, formatTotalUsageText, type RunSession } from "./event-bus.js";
import { LogWriter, progressDirForCwd, usageToData } from "./logger.js";
import { createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { appendPlanCreationDebug } from "./planner-debug.js";
import { expandPrompt, loadPrompt } from "./prompt.js";
import { createTokenLedger } from "./tui.js";

import type { ModelConfig, RalpixConfig } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QAEntry {
  question: string;
  options: string[];
  answer: string;
}

interface DesignSection {
  title: string;
  content: string;
  raw: string;
}

interface BrainstormState {
  description: string;
  qaHistory: QAEntry[];
  approachesText: string | null;
  selectedApproach: string | null;
  designSections: DesignSection[];
  pendingSection: DesignSection | null;
  pendingFeedback: string | null;
}

type BrainstormCheckpointStatus = "active" | "complete";

interface BrainstormCheckpoint {
  version: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: BrainstormCheckpointStatus;
  round: number;
  description: string;
  logSessionName: string;
  state: BrainstormState;
  lastError: string | null;
}

function isTimeoutExitCode(exitCode: number): boolean {
  return exitCode === 143 || exitCode === 137 || exitCode === 9;
}

function formatDateTimeStamp(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function slugifyBrainstormDescription(text: string): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "brainstorm";
}

function brainstormSessionDir(cwd: string): string {
  return join(progressDirForCwd(cwd), "brainstorm");
}

function brainstormCheckpointPath(cwd: string, sessionId: string): string {
  return join(brainstormSessionDir(cwd), `${sessionId}.json`);
}

function ensureBrainstormSessionDir(cwd: string): void {
  const dir = brainstormSessionDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function cloneBrainstormState(state: BrainstormState): BrainstormState {
  return structuredClone(state);
}

function createBrainstormSessionId(description: string): string {
  return `${formatDateTimeStamp(new Date())}-${slugifyBrainstormDescription(description)}`;
}

function createCheckpoint(description: string): BrainstormCheckpoint {
  const sessionId = createBrainstormSessionId(description);
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    status: "active",
    round: 0,
    description,
    logSessionName: `brainstorm-${sessionId}`,
    state: {
      description,
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

function saveCheckpoint(cwd: string, checkpoint: BrainstormCheckpoint): void {
  ensureBrainstormSessionDir(cwd);
  checkpoint.updatedAt = new Date().toISOString();
  writeFileSync(
    brainstormCheckpointPath(cwd, checkpoint.sessionId),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf-8",
  );
}

function loadCheckpoint(path: string): BrainstormCheckpoint | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<BrainstormCheckpoint>;
    if (
      raw.version !== 1 ||
      typeof raw.sessionId !== "string" ||
      typeof raw.createdAt !== "string" ||
      typeof raw.updatedAt !== "string" ||
      (raw.status !== "active" && raw.status !== "complete") ||
      typeof raw.round !== "number" ||
      typeof raw.description !== "string" ||
      typeof raw.logSessionName !== "string" ||
      raw.state == null
    ) {
      return null;
    }
    return raw as BrainstormCheckpoint;
  } catch {
    return null;
  }
}

function listActiveCheckpoints(cwd: string): BrainstormCheckpoint[] {
  const dir = brainstormSessionDir(cwd);
  if (!existsSync(dir)) return [];

  const checkpoints: BrainstormCheckpoint[] = [];
  try {
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith(".json")) continue;
      const checkpoint = loadCheckpoint(join(dir, fileName));
      if (checkpoint != null && checkpoint.status !== "complete") {
        checkpoints.push(checkpoint);
      }
    }
  } catch {
    return [];
  }

  return checkpoints.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function describeCheckpointPhase(state: BrainstormState): string {
  if (state.pendingSection != null) return `design: ${state.pendingSection.title}`;
  if (state.pendingFeedback != null && state.pendingFeedback.length > 0) return "revising design";
  if (state.selectedApproach != null) return "design";
  if (state.approachesText != null) return "approach selection";
  if (state.qaHistory.length > 0) return "understanding";
  return "starting";
}

function summarizeCheckpointState(state: BrainstormState): string {
  const parts: string[] = [];
  if (state.qaHistory.length > 0) parts.push(`${String(state.qaHistory.length)} Q&A`);
  if (state.selectedApproach != null) parts.push("approach selected");
  if (state.designSections.length > 0) parts.push(`${String(state.designSections.length)} sections accepted`);
  if (parts.length === 0) return "no confirmed progress yet";
  return parts.join(", ");
}

function formatRelativeUpdatedAt(iso: string): string {
  const updated = Date.parse(iso);
  if (Number.isNaN(updated)) return iso;

  const diffMs = Date.now() - updated;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMinutes < 1) return "updated just now";
  if (diffMinutes < 60) return `updated ${String(diffMinutes)}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `updated ${String(diffHours)}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `updated ${String(diffDays)}d ago`;
}

function checkpointChoiceLabel(checkpoint: BrainstormCheckpoint): string {
  return `${checkpoint.description} — ${describeCheckpointPhase(checkpoint.state)} — ${formatRelativeUpdatedAt(checkpoint.updatedAt)}`;
}

async function chooseCheckpoint(
  session: RunSession,
  description: string,
  checkpoints: BrainstormCheckpoint[],
): Promise<BrainstormCheckpoint | "new" | null> {
  if (checkpoints.length === 0) return "new";

  const options = [
    ...checkpoints.map((checkpoint) => `${checkpointChoiceLabel(checkpoint)}\n${summarizeCheckpointState(checkpoint.state)}`),
    `Start new brainstorm for "${description}"`,
  ];
  const selected = await session.choose("Resume an unfinished brainstorm or start a new one?", options);
  if (selected == null) return null;

  if (selected === options.at(-1)) return "new";

  const index = options.indexOf(selected);
  return index >= 0 ? checkpoints[index] ?? null : null;
}

function hydrateSessionFromState(session: RunSession, checkpoint: BrainstormCheckpoint): void {
  for (const qa of checkpoint.state.qaHistory) {
    session.message("question", qa.question);
    session.message("answer", qa.answer);
  }
  if (checkpoint.state.selectedApproach != null) {
    session.message("result", `Approach selected: ${checkpoint.state.selectedApproach}`);
  }
  for (const section of checkpoint.state.designSections) {
    session.message("result", `Design section accepted: ${section.title}`);
  }
  session.status("running", `Resumed session from round ${String(Math.max(1, checkpoint.round))}`);
}

function persistCheckpoint(
  cwd: string,
  checkpoint: BrainstormCheckpoint,
  state: BrainstormState,
  round: number,
  lastError: string | null = null,
): void {
  checkpoint.state = cloneBrainstormState(state);
  checkpoint.round = round;
  checkpoint.lastError = lastError;
  saveCheckpoint(cwd, checkpoint);
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function extractPhase(text: string): string | null {
  const match = (/<ralpix_phase>([\w-]+)<\/ralpix_phase>/i).exec(text);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractQuestion(text: string): { question: string; options: string[] } | null {
  const match = (/<ralpix_question>\s*([\S\s]*?)\s*<\/ralpix_question>/i).exec(text);
  if (match?.[1] == null) return null;
  const body = match[1];

  const qm = (/^\s*question:\s*(.+)$/im).exec(body);
  const question = qm?.[1]?.trim();
  if (question == null || question.length === 0) return null;

  const options = [...body.matchAll(/^\s*-\s+(.+)$/gim)]
    .map((m) => m[1]?.trim())
    .filter((x): x is string => x != null && x.length > 0);

  return { question, options };
}

function extractApproaches(text: string): string | null {
  const match = (/<ralpix_approaches>\s*([\S\s]*?)\s*<\/ralpix_approaches>/i).exec(text);
  return match?.[1]?.trim() ?? null;
}

function extractApproachNames(raw: string): string[] {
  const names: string[] = [];
  for (const match of raw.matchAll(/^##\s+option\s+[a-z]+:\s*(.+?)(?:\s*\(recommended\))?$/gim)) {
    const name = match[1]?.trim();
    if (name != null && name.length > 0) names.push(name);
  }
  if (names.length === 0) {
    for (const match of raw.matchAll(/\*\*option\s+[a-z]+:\s*(.+?)(?:\s*\(recommended\))?\*\*/gi)) {
      const name = match[1]?.trim();
      if (name != null && name.length > 0) names.push(name);
    }
  }
  return names;
}

function extractDesignSection(text: string): { title: string; content: string; raw: string } | null {
  const match = (/<ralpix_design_section>\s*([\S\s]*?)\s*<\/ralpix_design_section>/i).exec(text);
  if (match?.[1] == null) return null;
  const raw = match[1].trim();
  const lines = raw.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const title = firstLine.replace(/^#+\s*/, "").trim();
  const content = lines.slice(1).join("\n").trim();
  return { title, content: content.length > 0 ? content : title, raw };
}

function extractSummary(text: string): string | null {
  const match = (/<ralpix_summary>\s*([\S\s]*?)\s*<\/ralpix_summary>/i).exec(text);
  return match?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function formatQAHistory(entries: QAEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["## Questions & Answers", ""];
  for (const entry of entries) {
    lines.push(`- Q: ${entry.question}`);
    lines.push(`  A: ${entry.answer}`);
  }
  return lines.join("\n");
}

function formatApproaches(raw: string | null, selected: string | null): string {
  if (raw == null || raw.length === 0) return "";
  const lines = ["## Proposed Approaches", "", raw];
  if (selected != null && selected.length > 0) {
    lines.push("", `**User selected:** ${selected}`);
  }
  return lines.join("\n");
}

function formatDesignSections(sections: DesignSection[]): string {
  if (sections.length === 0) return "";
  const lines = ["## Validated Design Sections", ""];
  for (const section of sections) {
    lines.push(`### ${section.title}`);
    lines.push(section.content);
    lines.push("");
  }
  return lines.join("\n");
}

function formatPendingFeedback(section: DesignSection | null, feedback: string | null): string {
  if (section == null || feedback == null || feedback.length === 0) return "";
  return [
    "## Current Section Being Revised",
    "",
    `### ${section.title}`,
    section.raw,
    "",
    `**User feedback:** ${feedback}`,
  ].join("\n");
}

function buildBrainstormPrompt(template: string, state: BrainstormState): string {
  return expandPrompt(template, {
    DESCRIPTION: state.description,
    QA_HISTORY: formatQAHistory(state.qaHistory),
    APPROACHES: formatApproaches(state.approachesText, null),
    SELECTED_APPROACH: state.selectedApproach == null ? "" : `## Selected Approach\n\n**${state.selectedApproach}**`,
    DESIGN_SECTIONS: formatDesignSections(state.designSections),
    USER_FEEDBACK: formatPendingFeedback(state.pendingSection, state.pendingFeedback),
  });
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatBrainstormResult(state: BrainstormState, summary: string): string {
  const lines: string[] = [];
  lines.push("## Brainstorm Context");
  lines.push("");
  lines.push("The following design was developed through an interactive brainstorm session:");
  lines.push("");

  if (state.selectedApproach != null && state.selectedApproach.length > 0) {
    lines.push(`**Selected Approach:** ${state.selectedApproach}`);
    lines.push("");
  }

  if (state.qaHistory.length > 0) {
    lines.push("**Key Constraints & Decisions:**");
    for (const qa of state.qaHistory) {
      lines.push(`- ${qa.question} → ${qa.answer}`);
    }
    lines.push("");
  }

  if (state.designSections.length > 0) {
    lines.push("**Design Sections:**");
    for (const section of state.designSections) {
      lines.push(`### ${section.title}`);
      lines.push(section.content);
      lines.push("");
    }
  }

  lines.push("**Summary:**");
  lines.push(summary);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// UI interactions
// ---------------------------------------------------------------------------

async function askBrainstormQuestion(
  session: RunSession,
  question: string,
  options: string[],
): Promise<string | null> {
  if (options.length >= 2) {
    const customLabel = "Other (type your own answer)";
    const selected = await session.choose(question, [...options, customLabel]);
    if (selected == null) return null;
    if (selected === customLabel) {
      const custom = await session.input(question, { placeholder: "Type your custom answer" });
      return custom?.trim() ?? null;
    }
    return selected.trim();
  }
  const answer = await session.input(question, { placeholder: "Your answer" });
  return answer?.trim() ?? null;
}

async function selectApproach(
  session: RunSession,
  raw: string,
): Promise<string | null> {
  const names = extractApproachNames(raw);
  session.message("info", `Proposed approaches\n${raw}`);

  if (names.length >= 2) {
    return (await session.choose("Which approach do you prefer?", names)) ?? null;
  }

  const custom = await session.input(
    "Which approach do you prefer?",
    { placeholder: "Type the approach name or describe your own" },
  );
  return custom?.trim() ?? null;
}

async function validateDesignSection(
  session: RunSession,
  section: { title: string; raw: string },
): Promise<string | null> {
  session.message("info", `Design section: ${section.title}\n${section.raw}`);

  const choice = await session.choose("Validate this section?", [
    "✓ Looks good — continue",
    "✎ Needs changes — provide feedback",
    "⏩ Skip to summary",
  ]);

  if (choice == null) return null;
  if (choice.includes("Looks good")) return "good";
  if (choice.includes("Skip")) return "skip";

  const feedback = await session.input(
    `Feedback on "${section.title}"`,
    { placeholder: "What needs to change?" },
  );
  return feedback?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

async function handleUnderstandPhase(
  output: string,
  state: BrainstormState,
  cwd: string,
  session: RunSession,
  logger: LogWriter,
  round: number,
  checkpoint: BrainstormCheckpoint,
): Promise<"continue" | "cancel"> {
  const question = extractQuestion(output);
  if (question == null) return "continue";

  logger.write("question", {
    round,
    question: question.question,
    options: question.options,
  });

  session.clearStatus();
  session.status("waiting", `Waiting for answer to: ${question.question}`);
  if (question.options.length > 0) {
    session.message("info", `Options\n${formatOptions(question.options)}`);
  }
  const answer = await askBrainstormQuestion(session, question.question, question.options);
  if (answer == null) return "cancel";
  state.qaHistory.push({
    question: question.question,
    options: question.options,
    answer,
  });
  logger.write("answer", {
    round,
    question: question.question,
    answer,
  });
  persistCheckpoint(cwd, checkpoint, state, round);
  session.message("result", `Recorded answer for: ${question.question}`);
  return "continue";
}

async function handleApproachesPhase(
  output: string,
  state: BrainstormState,
  cwd: string,
  session: RunSession,
  logger: LogWriter,
  round: number,
  checkpoint: BrainstormCheckpoint,
): Promise<"continue" | "cancel"> {
  const approachesRaw = extractApproaches(output);
  if (approachesRaw == null || approachesRaw.length === 0) return "continue";

  state.approachesText = approachesRaw;
  session.clearStatus();
  session.status("waiting", "Waiting for approach selection...");

  const selected = await selectApproach(session, approachesRaw);
  if (selected == null) return "cancel";
  state.selectedApproach = selected;
  logger.write("approach_selected", {
    round,
    approach: selected,
    approaches: approachesRaw,
  });
  persistCheckpoint(cwd, checkpoint, state, round);
  session.message("result", `Approach selected: ${selected}`);
  return "continue";
}

async function handleDesignPhase(
  output: string,
  state: BrainstormState,
  cwd: string,
  session: RunSession,
  logger: LogWriter,
  round: number,
  checkpoint: BrainstormCheckpoint,
): Promise<"continue" | "cancel" | "done"> {
  const section = extractDesignSection(output);
  if (section == null) return "continue";

  state.pendingSection = {
    title: section.title,
    content: section.content,
    raw: section.raw,
  };

  session.clearStatus();
  session.status("waiting", `Waiting for validation: ${section.title}`);

  const validation = await validateDesignSection(session, section);
  if (validation == null) return "cancel";

  if (validation === "good") {
    state.designSections.push({
      title: section.title,
      content: section.content,
      raw: section.raw,
    });
    state.pendingSection = null;
    state.pendingFeedback = null;
    logger.write("section_validated", {
      round,
      sectionTitle: section.title,
      outcome: "accepted",
    });
    persistCheckpoint(cwd, checkpoint, state, round);
    session.message("success", `Design section accepted: ${section.title}`);
    return "continue";
  }

  if (validation === "skip") {
    state.pendingSection = null;
    state.pendingFeedback = "The user is satisfied with the design coverage so far. Please move to the summary phase.";
    logger.write("section_validated", {
      round,
      sectionTitle: section.title,
      outcome: "skipped_to_summary",
    });
    persistCheckpoint(cwd, checkpoint, state, round);
    session.message("info", "Skipped remaining design sections");
    return "continue";
  }

  state.pendingFeedback = validation;
  logger.write("section_validated", {
    round,
    sectionTitle: section.title,
    outcome: "feedback_requested",
    feedback: validation,
  });
  persistCheckpoint(cwd, checkpoint, state, round);
  session.message("warning", `Revision requested for section: ${section.title}`);
  return "continue";
}

function handleCompletePhase(
  output: string,
  state: BrainstormState,
): string | null {
  const summary = extractSummary(output);
  if (summary == null || summary.length === 0) return null;
  return formatBrainstormResult(state, summary);
}

// ---------------------------------------------------------------------------
// Round runner
// ---------------------------------------------------------------------------

function formatPhaseName(phase: string | null): string {
  switch (phase) {
    case "understand": { return "understanding";
    }
    case "approaches": { return "exploring approaches";
    }
    case "design": { return "designing";
    }
    case "complete": { return "complete";
    }
    case null: { return "thinking";
    }
    default: { return "thinking";
    }
  }
}

async function runBrainstormSubprocess(
  round: number,
  state: BrainstormState,
  template: string,
  modelCfg: ModelConfig,
  piAgentDir: string | null,
  config: RalpixConfig,
  ctx: ExtensionCommandContext,
  session: RunSession,
  ledger: ReturnType<typeof createTokenLedger>,
  logger: LogWriter,
  checkpoint: BrainstormCheckpoint,
): Promise<{ output: string } | null> {
  const prompt = buildBrainstormPrompt(template, state);
  appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: subprocess start`);

  const roundLedger = createTokenLedger();

  session.status("thinking", `Round ${round}: AI thinking...`);

  const progressHooks = createPiProgressHooks(
    (detail) => {
      session.status("thinking", `Round ${round}: ${detail}`);
    },
    (provider, model, usage) => {
      ledger.add(provider, model, usage);
      roundLedger.add(provider, model, usage);
      session.usage(formatTotalUsageText(ledger.snapshot()));
    },
  );

  const result = await runPiSubprocessPrompt(
    ctx.cwd,
    prompt,
    modelCfg,
    true,
    config.brainstormTimeoutMs ?? 10 * 60 * 1000,
    progressHooks,
    piAgentDir,
    config,
  );

  const detailedStepUsage = roundLedger.detailedSnapshot();
  const totalUsage = ledger.detailedSnapshot();
  const breakdown = roundLedger.breakdown();

  logger.write("usage", {
    round,
    usage: usageToData(detailedStepUsage, totalUsage, breakdown),
  });

  if (result.exitCode !== 0) {
    const errMsg = isTimeoutExitCode(result.exitCode)
      ? `brainstorm timed out after ${String(Math.round((config.brainstormTimeoutMs ?? 10 * 60 * 1000) / 1000))}s`
      : `subprocess failed exit=${String(result.exitCode)}`;
    session.message("error", `Brainstorm error: ${errMsg}`);
    appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: ${errMsg}`);
    persistCheckpoint(ctx.cwd, checkpoint, state, round, errMsg);
    session.status("failed", `Round ${round}: ${errMsg}`);
    session.message("result", `Round ${round}: ${errMsg}\n${ledger.usageLines().join("\n")}`);
    return null;
  }

  const output = result.lastAssistantText.trim();
  appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: output len=${String(output.length)}`);

  const phase = extractPhase(output);
  const phaseDisplay = formatPhaseName(phase);

  session.status("thinking", `Round ${round}: ${phaseDisplay}`);
  session.message("result", `Round ${round}: ${phaseDisplay}\n${ledger.usageLines().join("\n")}`);

  return { output };
}

async function runBrainstormRound(
  round: number,
  state: BrainstormState,
  template: string,
  modelCfg: ModelConfig,
  piAgentDir: string | null,
  config: RalpixConfig,
  ctx: ExtensionCommandContext,
  session: RunSession,
  ledger: ReturnType<typeof createTokenLedger>,
  logger: LogWriter,
  checkpoint: BrainstormCheckpoint,
): Promise<{ action: "continue" } | { action: "return"; value: string | null }> {
  logger.write("round_start", {
    round,
    qaCount: state.qaHistory.length,
    designSectionCount: state.designSections.length,
    selectedApproach: state.selectedApproach,
  });

  const subprocessResult = await runBrainstormSubprocess(
    round, state, template, modelCfg, piAgentDir, config, ctx, session, ledger, logger, checkpoint,
  );
  if (subprocessResult == null) {
    return { action: "return", value: null };
  }

  const { output } = subprocessResult;
  const phase = extractPhase(output);

  if (phase === "understand" || phase === null) {
    const status = await handleUnderstandPhase(output, state, ctx.cwd, session, logger, round, checkpoint);
    return status === "cancel" ? { action: "return", value: null } : { action: "continue" };
  }

  if (phase === "approaches") {
    const status = await handleApproachesPhase(output, state, ctx.cwd, session, logger, round, checkpoint);
    return status === "cancel" ? { action: "return", value: null } : { action: "continue" };
  }

  if (phase === "design") {
    const status = await handleDesignPhase(output, state, ctx.cwd, session, logger, round, checkpoint);
    return status === "cancel" ? { action: "return", value: null } : { action: "continue" };
  }

  if (phase === "complete") {
    const summary = handleCompletePhase(output, state);
    return { action: "return", value: summary };
  }

  appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: unparseable output`);
  session.message("warning", "Brainstorm produced unexpected output. Trying again...");
  state.pendingFeedback = "Please use the correct output format for your current phase.";
  persistCheckpoint(ctx.cwd, checkpoint, state, checkpoint.round, "unexpected output format");
  return { action: "continue" };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runBrainstorm(
  description: string,
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI,
  config: RalpixConfig,
): Promise<string | null> {
  const trimmed = description.trim();
  if (trimmed.length < 5) {
    ctx.ui.notify("Brainstorm description too short (min 5 characters)", "error");
    return null;
  }

  const template = loadPrompt("brainstorm", ctx.cwd);
  const modelCfg = resolveModel(config, "brainstorm");
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);
  const ledger = createTokenLedger();
  const session = createEventBus(ctx, "brainstorm", []);
  const activeCheckpoints = listActiveCheckpoints(ctx.cwd);
  const selected = await chooseCheckpoint(session, trimmed, activeCheckpoints);
  if (selected == null) {
    session.message("info", "Brainstorm cancelled");
    session.close();
    return null;
  }

  const checkpoint = selected === "new" ? createCheckpoint(trimmed) : selected;
  const state = cloneBrainstormState(checkpoint.state);
  const startRound = Math.max(1, checkpoint.round + (selected === "new" ? 1 : 0));
  const logger = new LogWriter(ctx.cwd, "brainstorm", checkpoint.logSessionName);

  if (selected === "new") {
    session.message("info", `Brainstorming: "${trimmed}"...`);
    appendPlanCreationDebug(ctx.cwd, `runBrainstorm: start description=${JSON.stringify(trimmed)}`);
    persistCheckpoint(ctx.cwd, checkpoint, state, 0);
    logger.write("start", { description: trimmed, sessionId: checkpoint.sessionId });
  } else {
    session.message("info", `Resuming brainstorm: "${state.description}"`);
    appendPlanCreationDebug(ctx.cwd, `runBrainstorm: resume session=${checkpoint.sessionId}`);
    logger.write("resume", {
      description: state.description,
      sessionId: checkpoint.sessionId,
      round: checkpoint.round,
    });
    hydrateSessionFromState(session, checkpoint);
  }

  const MAX_ROUNDS = 15;

  for (let round = startRound; round <= MAX_ROUNDS; round++) {
    const outcome = await runBrainstormRound(
      round,
      state,
      template,
      modelCfg,
      piAgentDir,
      config,
      ctx,
      session,
      ledger,
      logger,
      checkpoint,
    );

    if (outcome.action === "return") {
      if (outcome.value == null) {
        persistCheckpoint(ctx.cwd, checkpoint, state, checkpoint.round, checkpoint.lastError);
        logger.write("end", {
          status: "cancelled",
          rounds: round,
          sessionId: checkpoint.sessionId,
          selectedApproach: state.selectedApproach,
          designSectionCount: state.designSections.length,
        });
      } else {
        checkpoint.status = "complete";
        persistCheckpoint(ctx.cwd, checkpoint, state, round, null);
        session.status("complete", "Brainstorm complete!");
        session.message("success", "Brainstorm complete!");
        logger.write("end", {
          status: "complete",
          rounds: round,
          sessionId: checkpoint.sessionId,
          selectedApproach: state.selectedApproach,
          designSectionCount: state.designSections.length,
        });
      }
      session.close();
      return outcome.value;
    }
  }

  session.close();
  session.message("warning", "Brainstorm exhausted available rounds");
  persistCheckpoint(ctx.cwd, checkpoint, state, checkpoint.round, "max rounds exhausted");
  logger.write("end", {
    status: "cancelled",
    reason: "max_rounds_exhausted",
    rounds: MAX_ROUNDS,
    sessionId: checkpoint.sessionId,
    selectedApproach: state.selectedApproach,
    designSectionCount: state.designSections.length,
  });
  return null;
}
