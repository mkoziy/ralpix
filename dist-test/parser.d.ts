/**
 * Plan parser — reads ralpix-format markdown plans.
 *
 * Format:
 *   # Plan: Title
 *   ## Overview
 *   ...
 *   ## Success Criteria
 *   - [ ] item
 *   ### Task N: Title
 *   - [ ] / - [x] checklist items
 */
import type { Plan, PlanTask } from "./types.js";
export declare function parsePlan(filePath: string): Plan;
/** Find the next pending (not completed, not failed) task */
export declare function findNextPendingTask(plan: Plan): PlanTask | null;
/** Update checkboxes in the plan file to reflect task status */
export declare function updatePlanTaskStatus(planPath: string, _taskId: string, taskTitle: string, status: "in-progress" | "completed" | "failed"): void;
//# sourceMappingURL=parser.d.ts.map