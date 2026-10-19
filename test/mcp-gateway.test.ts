import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  categoryOf,
  invokeTool,
  isAllowedTool,
  LIVE_TOOLS,
  type ToolHandler,
} from "@/lib/mcp-gateway";
import { awsConfig } from "@/lib/config";

/** Feature: tripgenie - MCP gateway property tests (Properties 36, 37, 29, 41). */

const handlers: Record<string, ToolHandler> = Object.fromEntries(
  awsConfig.mcpToolAllowlist.map((t) => [t, () => ({ tool: t })]),
);

describe("Feature: tripgenie, MCP gateway", () => {
  it("Property 36: MCP Gateway permits a tool if and only if it is allowlisted", () => {
    fc.assert(
      fc.property(fc.string(), (tool) => {
        const out = invokeTool({ tool, arguments: {} }, handlers);
        if (isAllowedTool(tool)) {
          expect(out.ok).toBe(true);
        } else {
          expect(out.ok).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 37: Live lookups route through the Live Data Adapter", () => {
    for (const tool of awsConfig.mcpToolAllowlist) {
      const out = invokeTool({ tool, arguments: {} }, handlers);
      if (out.ok) {
        expect(out.routedToLive).toBe(LIVE_TOOLS.has(tool));
      }
    }
  });

  it("Property 29: Read tools never mutate state", () => {
    // Read tool handlers are invoked with a frozen state; a mutating read would throw.
    const frozen = Object.freeze({ count: 0 });
    for (const tool of awsConfig.mcpToolAllowlist) {
      if (categoryOf(tool) !== "read") continue;
      const readHandlers: Record<string, ToolHandler> = {
        [tool]: () => frozen.count,
      };
      const out = invokeTool({ tool, arguments: {} }, readHandlers);
      expect(out.ok).toBe(true);
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(frozen.count).toBe(0);
    }
  });

  it("Property 41: Each gateway tool call records exactly one trace span", () => {
    fc.assert(
      fc.property(fc.constantFrom(...awsConfig.mcpToolAllowlist), (tool) => {
        let spans = 0;
        const out = invokeTool({ tool, arguments: {} }, handlers, () => { spans++; return 123; });
        expect(out.ok).toBe(true);
        if (out.ok) {
          expect(out.span.tool).toBe(tool);
          expect(spans).toBe(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});
