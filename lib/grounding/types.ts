import type { TripContext } from "@/lib/types";

export type GroundingStatus = "ok" | "partial" | "empty" | "disabled" | "unavailable";

export interface GroundingSnippet {
  /** <= 120 chars after bundle build. */
  title: string;
  /** <= 240 chars after bundle build. */
  snippet: string;
  /** Absolute https URL (output of safeHttpsUrl). */
  url: string;
  /** new URL(url).hostname */
  host: string;
}

export interface GroundingBundle {
  status: GroundingStatus;
  /** [] unless status is "ok" or "partial". */
  snippets: GroundingSnippet[];
  /** Snippets removed by the sanitizer. */
  droppedCount: number;
}

export interface GroundingInput {
  destination?: string;
  durationDays?: number;
  /** interests.slice(0, 3).join(", ") */
  vibe?: string;
  budgetLevel?: string;
}

export const EMPTY_BUNDLE = (status: GroundingStatus): GroundingBundle => ({
  status,
  snippets: [],
  droppedCount: 0,
});

export function groundingInputFromContext(ctx: TripContext): GroundingInput {
  const interests = Array.isArray(ctx?.interests) ? ctx.interests : [];
  return {
    destination: ctx?.destination,
    durationDays: ctx?.durationDays,
    vibe: interests.slice(0, 3).join(", "),
    budgetLevel: ctx?.budgetLevel,
  };
}
