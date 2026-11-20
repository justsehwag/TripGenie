/**
 * Stable system-prompt prefix, kept in a dependency-free module so client-bundled
 * code (via lib/activity-pricer.ts) never pulls in lib/config.ts or the MCP gateway.
 * Re-exported by lib/planning-turn.ts.
 */

/** Stable system-prompt prefix reused byte-identically across requests (Req 19.4). */
export const SYSTEM_PROMPT_PREFIX =
  "You are Tripsaathi AI, a bounded travel-planning concierge. Extract only structured trip context from the latest input delta. Ask one question at a time, never fabricate availability, and keep answers under 160 characters.";
