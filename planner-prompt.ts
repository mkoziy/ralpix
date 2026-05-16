export function buildPlanCreationPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "## Completion Contract",
    "Before finishing, you must call `ralpix_submit_plan_draft` with the complete plan text.",
    "If you need clarification first, use `ralpix_ask_question`, then continue and submit the draft.",
    "Do not end the session without either submitting a draft or receiving an explicit rejection from the user.",
  ].join("\n");
}
