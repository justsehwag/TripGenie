/**
 * Shared types (and the PAGE_IDS constant) for the site-wide assistant. No
 * imports with side effects, so this file is safe on client and server.
 */
import type { ChatTurn } from "../assistant/types";

/** Single source of truth for page ids (plain constant, safe on client and server). */
export const PAGE_IDS = [
  "discover",
  "flights",
  "stays",
  "cars",
  "trips",
  "account",
  "itinerary",
  "deals",
  "general",
] as const;

export type PageId = (typeof PAGE_IDS)[number];

/** Handlers a page registers for the actions the assistant may propose. */
export interface PageActionHandlers {
  [toolName: string]: (params: unknown) => { undo?: () => void } | void;
}

/** One registered slice of page context in the Context_Registry. */
export interface PageContextSlot {
  page: PageId;
  slot: string;
  summary: string;
  data?: unknown;
  actions?: PageActionHandlers;
}

/** A validated, server-built action the traveller must Apply explicitly. */
export interface ActionProposal {
  id: string;
  page: PageId;
  tool: string;
  /** Validated, server-built. */
  params: Record<string, unknown>;
  /** Server-built from params, never model text. */
  summary: string;
  fields: Array<{ label: string; before?: string; after: string }>;
}

export interface SiteAssistantRequest {
  message: string;
  page: PageId;
  /** Reuses ChatTurn from lib/assistant/types.ts, at most 10 turns. */
  history: ChatTurn[];
  /** Pre-sanitized client-side, re-sanitized server-side. */
  context: { summary: string; data: unknown };
}

export interface SiteAssistantResponse {
  reply: string;
  /** 0..5 */
  proposals: ActionProposal[];
  status: "ok" | "partial" | "unavailable";
}

/** Sanitizer output: at most 6144 bytes UTF-8 and 20 items per array. */
export interface WireContext {
  page: PageId;
  summary: string;
  data: unknown;
}
