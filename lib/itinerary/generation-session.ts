/**
 * Client-side marker of the generation running in this browser session.
 *
 * Module-level state: it survives client-side navigation (for example from
 * /trip to /itinerary) and is empty after a reload, so the Planner can tell
 * "continue this session's generation" from "settle pending days as withheld".
 * Client-safe: no imports.
 */
let activeTripKey: string | null = null;

export function beginGeneration(tripKey: string): void {
  activeTripKey = typeof tripKey === "string" ? tripKey : null;
}

export function isGenerationActive(tripKey: string): boolean {
  return activeTripKey !== null && activeTripKey === tripKey;
}

export function endGeneration(): void {
  activeTripKey = null;
}
