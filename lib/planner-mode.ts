/**
 * Planner entry mode (Quick form vs Chat with AI).
 * Pure, total and framework-free: nothing here throws.
 */

export type PlannerMode = "quick" | "chat";

/** Req 14.2: tripgenie. prefix. */
export const PLANNER_MODE_KEY = "tripgenie.planner-mode";

export const DEFAULT_PLANNER_MODE: PlannerMode = "chat";

/** Total. Returns the mode for the two exact strings "quick" and "chat", else null. */
export function parsePlannerMode(raw: unknown): PlannerMode | null {
  return raw === "quick" || raw === "chat" ? raw : null;
}

/**
 * Total. A hand-off (?q=, ?dest=, ?trip=) always starts in chat (C5).
 * Otherwise a valid stored value wins; anything else gives DEFAULT_PLANNER_MODE.
 */
export function resolveInitialMode(stored: unknown, hasHandoff: boolean): PlannerMode {
  if (hasHandoff) return "chat";
  return parsePlannerMode(stored) ?? DEFAULT_PLANNER_MODE;
}

/** Never throws. Returns null when storage is missing, throws or holds junk. */
export function readStoredMode(storage: Pick<Storage, "getItem"> | undefined): PlannerMode | null {
  try {
    if (!storage) return null;
    return parsePlannerMode(storage.getItem(PLANNER_MODE_KEY));
  } catch {
    return null;
  }
}

/** Never throws. Returns false when the write failed. */
export function writeStoredMode(storage: Pick<Storage, "setItem"> | undefined, mode: PlannerMode): boolean {
  try {
    if (!storage) return false;
    const valid = parsePlannerMode(mode);
    if (!valid) return false;
    storage.setItem(PLANNER_MODE_KEY, valid);
    return true;
  } catch {
    return false;
  }
}
