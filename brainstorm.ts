/**
 * Interactive brainstorm — collaborative design dialogue before plan creation.
 *
 * Explores the problem space through questions, proposes approaches,
 * validates design sections incrementally, and produces a structured
 * context string that feeds into plan creation.
 */

import { resolveModel, resolvePiAgentDir } from "./config.js";
import { createPiProgressHooks, runPiSubprocessPrompt } from "./pi-subprocess.js";
import { appendPlanCreationDebug } from "./planner-debug.js";
import { expandPrompt, loadPrompt } from "./prompt.js";
import { createProgressTui, createTokenLedger, type ProgressTuiRuntime } from "./tui.js";

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

function isTimeoutExitCode(exitCode: number): boolean {
  return exitCode === 143 || exitCode === 137 || exitCode === 9;
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
  ctx: ExtensionCommandContext,
  question: string,
  options: string[],
): Promise<string | null> {
  if (options.length >= 2) {
    const customLabel = "Other (type your own answer)";
    const selected = await ctx.ui.select(question, [...options, customLabel]);
    if (selected == null) return null;
    if (selected === customLabel) {
      const custom = await ctx.ui.input(question, "Type your custom answer");
      return custom?.trim() ?? null;
    }
    return selected.trim();
  }
  const answer = await ctx.ui.input(question, "Your answer");
  return answer?.trim() ?? null;
}

async function selectApproach(
  ctx: ExtensionCommandContext,
  raw: string,
): Promise<string | null> {
  const names = extractApproachNames(raw);
  ctx.ui.notify(`Proposed approaches:\n\n${raw}`, "info");

  if (names.length >= 2) {
    return (await ctx.ui.select("Which approach do you prefer?", names)) ?? null;
  }

  const custom = await ctx.ui.input("Which approach do you prefer?", "Type the approach name or describe your own");
  return custom?.trim() ?? null;
}

async function validateDesignSection(
  ctx: ExtensionCommandContext,
  section: { title: string; raw: string },
): Promise<string | null> {
  ctx.ui.notify(`Design section: ${section.title}\n\n${section.raw}`, "info");

  const choice = await ctx.ui.select("Validate this section?", [
    "✓ Looks good — continue",
    "✎ Needs changes — provide feedback",
    "⏩ Skip to summary",
  ]);

  if (choice == null) return null;
  if (choice.includes("Looks good")) return "good";
  if (choice.includes("Skip")) return "skip";

  const feedback = await ctx.ui.input(
    `Feedback on "${section.title}"`,
    "What needs to change?",
  );
  return feedback?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

async function handleUnderstandPhase(
  output: string,
  state: BrainstormState,
  ctx: ExtensionCommandContext,
  tui: ProgressTuiRuntime,
): Promise<"continue" | "cancel"> {
  const question = extractQuestion(output);
  if (question == null) return "continue";

  tui.setCurrent("Waiting for user answer...");
  tui.refresh();

  ctx.ui.notify(`Brainstorm: ${question.question}`, "info");
  const answer = await askBrainstormQuestion(ctx, question.question, question.options);
  if (answer == null) return "cancel";
  state.qaHistory.push({
    question: question.question,
    options: question.options,
    answer,
  });
  tui.pushStep({ title: `Q: ${question.question} → A: ${answer}` });
  tui.refresh();
  return "continue";
}

async function handleApproachesPhase(
  output: string,
  state: BrainstormState,
  ctx: ExtensionCommandContext,
  tui: ProgressTuiRuntime,
): Promise<"continue" | "cancel"> {
  const approachesRaw = extractApproaches(output);
  if (approachesRaw == null || approachesRaw.length === 0) return "continue";

  state.approachesText = approachesRaw;
  tui.setCurrent("Waiting for approach selection...");
  tui.refresh();

  const selected = await selectApproach(ctx, approachesRaw);
  if (selected == null) return "cancel";
  state.selectedApproach = selected;
  tui.pushStep({ title: `Approach selected: ${selected}` });
  tui.refresh();
  return "continue";
}

async function handleDesignPhase(
  output: string,
  state: BrainstormState,
  ctx: ExtensionCommandContext,
  tui: ProgressTuiRuntime,
): Promise<"continue" | "cancel" | "done"> {
  const section = extractDesignSection(output);
  if (section == null) return "continue";

  state.pendingSection = {
    title: section.title,
    content: section.content,
    raw: section.raw,
  };

  tui.setCurrent("Waiting for section validation...");
  tui.refresh();

  const validation = await validateDesignSection(ctx, section);
  if (validation == null) return "cancel";

  if (validation === "good") {
    state.designSections.push({
      title: section.title,
      content: section.content,
      raw: section.raw,
    });
    state.pendingSection = null;
    state.pendingFeedback = null;
    tui.pushStep({ title: `Design section ✓ ${section.title}` });
    tui.refresh();
    return "continue";
  }

  if (validation === "skip") {
    state.pendingSection = null;
    state.pendingFeedback = "The user is satisfied with the design coverage so far. Please move to the summary phase.";
    tui.pushStep({ title: "Skipped remaining design sections" });
    tui.refresh();
    return "continue";
  }

  state.pendingFeedback = validation;
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
  tui: ProgressTuiRuntime,
  ledger: ReturnType<typeof createTokenLedger>,
): Promise<{ output: string } | null> {
  const prompt = buildBrainstormPrompt(template, state);
  appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: subprocess start`);

  const usageBefore = ledger.snapshot();

  tui.setPhase("thinking");
  tui.setCurrent(`Round ${round}: AI thinking...`);
  tui.refresh();

  const progressHooks = createPiProgressHooks(
    (detail) => {
      tui.setCurrent(`Round ${round}: ${detail}`);
      tui.refresh();
    },
    (provider, model, usage) => {
      ledger.add(provider, model, usage);
      tui.setTotalUsage(ledger.snapshot());
      tui.refresh();
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

  const stepUsage = ledger.diffSince(usageBefore);

  if (result.exitCode !== 0) {
    const errMsg = isTimeoutExitCode(result.exitCode)
      ? `brainstorm timed out after ${String(Math.round((config.brainstormTimeoutMs ?? 10 * 60 * 1000) / 1000))}s`
      : `subprocess failed exit=${String(result.exitCode)}`;
    ctx.ui.notify(`Brainstorm error: ${errMsg}`, "error");
    appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: ${errMsg}`);
    tui.pushStep({
      title: `Round ${round}: ${errMsg}`,
      usageSummary: stepUsage,
      usageLines: ledger.usageLines(),
    });
    tui.refresh();
    return null;
  }

  const output = result.lastAssistantText.trim();
  appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: output len=${String(output.length)}`);

  const phase = extractPhase(output);
  const phaseDisplay = formatPhaseName(phase);

  tui.setPhase(phaseDisplay);
  tui.pushStep({
    title: `Round ${round}: ${phaseDisplay}`,
    usageSummary: stepUsage,
    usageLines: ledger.usageLines(),
  });
  tui.setTotalUsage(ledger.snapshot());
  tui.refresh();

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
  tui: ProgressTuiRuntime,
  ledger: ReturnType<typeof createTokenLedger>,
): Promise<{ action: "continue" } | { action: "return"; value: string | null }> {
  const subprocessResult = await runBrainstormSubprocess(
    round, state, template, modelCfg, piAgentDir, config, ctx, tui, ledger,
  );
  if (subprocessResult == null) {
    return { action: "return", value: null };
  }

  const { output } = subprocessResult;
  const phase = extractPhase(output);

  if (phase === "understand" || phase === null) {
    const status = await handleUnderstandPhase(output, state, ctx, tui);
    return status === "cancel" ? { action: "return", value: null } : { action: "continue" };
  }

  if (phase === "approaches") {
    const status = await handleApproachesPhase(output, state, ctx, tui);
    return status === "cancel" ? { action: "return", value: null } : { action: "continue" };
  }

  if (phase === "design") {
    const status = await handleDesignPhase(output, state, ctx, tui);
    return status === "cancel" ? { action: "return", value: null } : { action: "continue" };
  }

  if (phase === "complete") {
    const summary = handleCompletePhase(output, state);
    return { action: "return", value: summary };
  }

  appendPlanCreationDebug(ctx.cwd, `brainstorm round ${round}: unparseable output`);
  ctx.ui.notify("Brainstorm produced unexpected output. Trying again...", "warning");
  state.pendingFeedback = "Please use the correct output format for your current phase.";
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

  ctx.ui.notify(`Brainstorming: "${trimmed}"...`, "info");
  appendPlanCreationDebug(ctx.cwd, `runBrainstorm: start description=${JSON.stringify(trimmed)}`);

  const template = loadPrompt("brainstorm", ctx.cwd);

  const state: BrainstormState = {
    description: trimmed,
    qaHistory: [],
    approachesText: null,
    selectedApproach: null,
    designSections: [],
    pendingSection: null,
    pendingFeedback: null,
  };

  const modelCfg = resolveModel(config, "brainstorm");
  const piAgentDir = resolvePiAgentDir(ctx.cwd, config);
  const ledger = createTokenLedger();
  const tui = createProgressTui(ctx, "brainstorm-progress", `brainstorm: ${trimmed}`);

  const MAX_ROUNDS = 15;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const outcome = await runBrainstormRound(
      round,
      state,
      template,
      modelCfg,
      piAgentDir,
      config,
      ctx,
      tui,
      ledger,
    );

    if (outcome.action === "return") {
      if (outcome.value != null) {
        tui.setPhase("complete");
        tui.setCurrent("Brainstorm complete!");
        tui.refresh();
        ctx.ui.notify("Brainstorm complete!", "success");
      }
      tui.close();
      return outcome.value;
    }
  }

  tui.setPhase("idle");
  tui.setCurrent("");
  tui.close();
  ctx.ui.notify("Brainstorm exhausted available rounds", "warning");
  return null;
}
