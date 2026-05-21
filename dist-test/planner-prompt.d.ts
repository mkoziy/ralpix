export declare function buildPlanCreationPrompt(prompt: string, attempt?: number): string;
export interface PlanCreationAttemptConfig {
    includeEffort: boolean;
    seedSessionConfig: boolean;
}
export declare function planCreationAttemptConfigs(): PlanCreationAttemptConfig[];
export interface PlannerLaunchConfig {
    modelPhase: "plan" | "task" | null;
    includeEffort: boolean;
}
export declare function plannerLaunchConfigs(): PlannerLaunchConfig[];
//# sourceMappingURL=planner-prompt.d.ts.map