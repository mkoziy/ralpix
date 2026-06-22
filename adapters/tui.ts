import {
  createSummaryTui,
  fmtTotal,
} from "../tui.js";

import type { AgentEvent, AgentEventEmitter } from "../events.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface SummaryState {
  phase: AgentEvent["phase"];
  state: string;
  now: string;
  next?: string;
  totalUsageText?: string;
}

function detailSuffix(detail?: string): string {
  return detail === undefined ? "" : `: ${detail}`;
}

function modelLabelSuffix(modelLabel?: string): string {
  return modelLabel === undefined ? "" : ` (${modelLabel})`;
}

function committedSuffix(committed?: boolean): string {
  return committed === true ? " (committed)" : "";
}

function stageDetailSuffix(detail?: string): string {
  return detail === undefined ? "" : ` — ${detail}`;
}

function levelForStageStatus(status: "complete" | "failed" | "skipped"): "error" | "info" | "success" {
  if (status === "complete") return "success";
  if (status === "skipped") return "info";
  return "error";
}

function levelForMilestone(kind: string): "error" | "info" | "success" | "warning" {
  if (kind === "ERR") return "error";
  if (kind === "WARN") return "warning";
  if (kind === "OK" || kind === "finalize-end") return "success";
  return "info";
}

export function createTuiEmitter(ctx: ExtensionCommandContext): AgentEventEmitter {
  const widgetKey = "ralpix-summary";
  const tui = createSummaryTui(ctx, widgetKey);

  let currentSummary: SummaryState | null = null;

  function notify(message: string, level: "info" | "success" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  function setStatus(summary: SummaryState | null): void {
    currentSummary = summary;
    tui.setSummary(summary);
    if (ctx.hasUI) {
      if (summary == null) {
        ctx.ui.setStatus("ralpix", undefined);
      } else {
        const text = summary.now.length > 0
          ? `ralpix: ${summary.phase} | ${summary.state} | ${summary.now}`
          : `ralpix: ${summary.phase} | ${summary.state}`;
        ctx.ui.setStatus("ralpix", text);
      }
    }
  }

  function updateSummaryField(patch: Partial<SummaryState>): void {
    if (currentSummary == null) return;
    setStatus({ ...currentSummary, ...patch });
  }

  return {
    // eslint-disable-next-line sonarjs/cognitive-complexity
    emit(event: AgentEvent): void {
      const phase = event.phase;

      switch (event.type) {
        case "phase_start": {
          setStatus({ phase, state: "running", now: event.label ?? phase });
          notify(`[${phase}] started`);
          break;
        }
        case "phase_end": {
          setStatus(null);
          notify(`[${phase}] complete`, "success");
          break;
        }
        case "question": {
          setStatus({
            phase,
            state: "waiting",
            now: event.message,
            ...(event.next === undefined ? {} : { next: event.next }),
          });
          notify(`Q: ${event.message}`);
          break;
        }
        case "answer": {
          notify(`A: ${event.message}`);
          if (event.usage !== undefined) {
            updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          }
          break;
        }
        case "approach_selected": {
          notify(`Approach: ${event.approach}`);
          break;
        }
        case "section_validated": {
          const icon = event.passed ? "✓" : "✗";
          notify(
            `${icon} ${event.section}${detailSuffix(event.detail)}`,
            event.passed ? "success" : "warning",
          );
          break;
        }
        case "round_start": {
          const label = event.label ?? `Round ${String(event.round)}`;
          setStatus({ phase, state: "running", now: label });
          notify(label);
          break;
        }
        case "round_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          break;
        }
        case "draft_generated": {
          notify("Plan draft generated");
          break;
        }
        case "review_result": {
          notify(`Review (${event.source}): ${event.action}`);
          break;
        }
        case "critic_start": {
          setStatus({ phase, state: "reviewing", now: "Critic reviewing…" });
          break;
        }
        case "critic_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total), now: "Critic done" });
          break;
        }
        case "ai_review_start": {
          setStatus({ phase, state: "reviewing", now: "AI reviewing…" });
          break;
        }
        case "ai_review_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total), now: "AI review done" });
          break;
        }
        case "human_review": {
          notify(`Human review: ${event.action}`);
          break;
        }
        case "task_start": {
          setStatus({
            phase,
            state: "running",
            now: `Task ${String(event.taskNumber)}: ${event.taskTitle}`,
            next: `${String(event.itemCount)} items`,
          });
          notify(`Task ${String(event.taskNumber)}: ${event.taskTitle}`);
          break;
        }
        case "attempt_start": {
          updateSummaryField({
            state: "running",
            now: `Attempt ${String(event.attempt)}${modelLabelSuffix(event.modelLabel)}`,
          });
          break;
        }
        case "attempt_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          if (!event.success) notify(`Attempt ${String(event.attempt)} failed`, "warning");
          break;
        }
        case "task_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          const taskLabel = `Task ${String(event.taskNumber)}: ${event.taskTitle}`;
          if (event.success) {
            notify(`✓ ${taskLabel}${committedSuffix(event.committed)}`, "success");
          } else {
            notify(`✗ ${taskLabel}${detailSuffix(event.detail)}`, "error");
          }
          break;
        }
        case "stage_start": {
          setStatus({
            phase,
            state: "reviewing",
            now: `Stage: ${event.stage}${stageDetailSuffix(event.detail)}`,
          });
          notify(`Stage ${event.stage} started`);
          break;
        }
        case "stage_update": {
          updateSummaryField({ now: event.detail });
          break;
        }
        case "stage_finish": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total), now: `Stage ${event.stage}: ${event.status}` });
          const level = levelForStageStatus(event.status);
          notify(`Stage ${event.stage}: ${event.status}`, level);
          break;
        }
        case "iteration_start": {
          updateSummaryField({ now: `${event.stage} iteration ${String(event.iteration)}` });
          break;
        }
        case "iteration_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          break;
        }
        case "eval_iteration_start": {
          updateSummaryField({ now: `Eval iteration ${String(event.iteration)}` });
          break;
        }
        case "eval_iteration_end": {
          updateSummaryField({ totalUsageText: fmtTotal(event.usage.total) });
          break;
        }
        case "status_changed": {
          setStatus({
            phase,
            state: event.state,
            now: event.now,
            ...(event.next === undefined ? {} : { next: event.next }),
          });
          break;
        }
        case "milestone": {
          if (event.kind === "finalize-skip") break;
          const level = levelForMilestone(event.kind);
          notify(event.message, level);
          break;
        }
        case "usage_checkpoint": {
          updateSummaryField({ totalUsageText: event.totalUsageText });
          break;
        }
      }
    },
  };
}
