import { awsConfig } from "./config";

/**
 * AgentCore MCP Gateway (single allowlisted tool surface) - design section 3.
 * Allowlist gating; live-lookup routing; read/transaction separation; one span/call.
 * Requirements: 16.1-16.4, 12.1, 18.4.
 */

export type ToolCategory = "read" | "transaction";

export interface ToolDescriptor {
  name: string;
  category: ToolCategory;
  /** True for read tools that route through the Live Data Adapter (Req 16.3). */
  live?: boolean;
}

export interface TraceSpan { tool: string; startedAt: number };

export interface GatewayInvocation { tool: string; arguments: Record<string, unknown> };

export type GatewayOutcome =
  | { ok: true; result: unknown; span: TraceSpan; routedToLive: boolean }
  | { ok: false; rejected: true; reason: string };

/** The live-routed read tools (destination/places, weather, currency). */
export const LIVE_TOOLS = new Set<string>([
  "get_destination_context",
  "search_destination_places",
  "get_weather",
  "convert_currency",
]);

const TRANSACTION_TOOLS = new Set<string>(["book_offer_set"]);

/** Classify an allowlisted tool into read vs transaction (Req 16.4/12.1). */
export function categoryOf(tool: string): ToolCategory {
  return TRANSACTION_TOOLS.has(tool) ? "transaction" : "read";
}

/** Whether a tool name is on the configured allowlist (Req 16.1/16.2). */
export function isAllowedTool(tool: string): boolean {
  return awsConfig.mcpToolAllowlist.includes(tool);
}

export type ToolHandler = (args: Record<string, unknown>) => unknown;

/**
 * Invoke a tool through the gateway. Non-allowlisted names are rejected; every
 * permitted call opens exactly one trace span. Live read tools report routedToLive.
 */
export function invokeTool(
  inv: GatewayInvocation,
  handlers: Record<string, ToolHandler>,
  now = () => Date.now(),
): GatewayOutcome {
  if (!isAllowedTool(inv.tool)) {
    return { ok: false, rejected: true, reason: `Tool not allowlisted: ${inv.tool}` };
  }
  const handler = handlers[inv.tool];
  if (!handler) {
    return { ok: false, rejected: true, reason: `No handler for ${inv.tool}` };
  }
  const span: TraceSpan = { tool: inv.tool, startedAt: now() };
  const result = handler(inv.arguments);
  return { ok: true, result, span, routedToLive: LIVE_TOOLS.has(inv.tool) };
}
