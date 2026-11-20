// Server-side orchestration of one planner call and at most one repair call.
// Never throws. A rejected or failed plan falls back to the deterministic
// schedule, so a day is never withheld because of the planner.
//
// Requirements: 9.1 to 9.7, 9.11.

import type { BedrockModelDeps } from "@/lib/bedrock-model";
import { MIN_STEP_MS, PLANNER_REPAIR_TIMEOUT_MS } from "@/lib/itinerary/constants";
import {
  buildPlannerPrompt,
  buildRepairPrompt,
  plannerTimeoutMs,
  repairTimeoutMs,
  runPlannerCall,
  type PlannerInput,
} from "@/lib/itinerary/planner";
import { applyPlan, checkPlan, type PlanContext } from "@/lib/itinerary/plan-check";
import type { PolishApplied } from "@/lib/itinerary/polish-check";

export type PlannerState = "accepted" | "rejected" | "fallback";

export interface PlannerRun {
  state: PlannerState;
  repaired: 0 | 1;
  applied: PolishApplied | null;
}

export interface PlanRunDeps {
  invokeModel?: BedrockModelDeps["invokeModel"];
  now: () => number;
  deadline: number;
}

const FALLBACK: PlannerRun = { state: "fallback", repaired: 0, applied: null };

export async function runPlanner(
  ctx: PlanContext,
  input: PlannerInput,
  deps: PlanRunDeps,
): Promise<PlannerRun> {
  try {
    const invokeModel = deps.invokeModel;
    if (typeof invokeModel !== "function") return FALLBACK;

    const firstMs = plannerTimeoutMs(deps.deadline, deps.now());
    if (!(firstMs >= MIN_STEP_MS)) return FALLBACK;

    const first = await runPlannerCall({ invokeModel }, buildPlannerPrompt(input, { timeoutMs: firstMs }));
    if (!first.ok) return FALLBACK;

    const verdict = checkPlan(ctx, first.raw);
    if (verdict.ok) return { state: "accepted", repaired: 0, applied: applyPlan(ctx, verdict) };

    // Repair only when the full repair timeout fits before the enrichment reserve.
    const repairMs = repairTimeoutMs(deps.deadline, deps.now());
    if (!(repairMs >= PLANNER_REPAIR_TIMEOUT_MS)) {
      return { state: "rejected", repaired: 0, applied: null };
    }

    const prompt = buildRepairPrompt(
      input,
      { reason: verdict.reason, days: verdict.days, placeIds: verdict.placeIds },
      { timeoutMs: repairMs },
    );
    const second = await runPlannerCall({ invokeModel }, prompt);
    if (!second.ok) return { state: "rejected", repaired: 1, applied: null };

    const recheck = checkPlan(ctx, second.raw);
    if (recheck.ok) return { state: "accepted", repaired: 1, applied: applyPlan(ctx, recheck) };
    return { state: "rejected", repaired: 1, applied: null };
  } catch {
    return FALLBACK;
  }
}
