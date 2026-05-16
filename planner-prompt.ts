export function buildPlanCreationPrompt(prompt: string, attempt = 1): string {
  const lines = [
    prompt,
    "",
    "## Completion Contract",
    "Before finishing, you must call `ralpix_submit_plan_draft` with the complete plan text.",
    "If you need clarification first, use `ralpix_ask_question`, then continue and submit the draft.",
    "Do not end the session without either submitting a draft or receiving an explicit rejection from the user.",
  ];

  if (attempt > 1) {
    lines.push(
      "",
      "## Retry Notice",
      "The previous attempt ended without submitting a draft.",
      "This time, you must either submit a draft with `ralpix_submit_plan_draft` or receive an explicit rejection from the user.",
    );
  }

  return lines.join("\n");
}

export interface PlanCreationAttemptConfig {
  includeEffort: boolean;
  seedSessionConfig: boolean;
}

export function planCreationAttemptConfigs(): PlanCreationAttemptConfig[] {
  return [
    { includeEffort: true, seedSessionConfig: true },
    { includeEffort: false, seedSessionConfig: true },
    { includeEffort: false, seedSessionConfig: false },
  ];
}

export interface PlannerLaunchConfig {
  includeModel: boolean;
  includeEffort: boolean;
}

export function plannerLaunchConfigs(): PlannerLaunchConfig[] {
  return [
    { includeModel: true, includeEffort: true },
    { includeModel: true, includeEffort: false },
    { includeModel: false, includeEffort: false },
  ];
}
