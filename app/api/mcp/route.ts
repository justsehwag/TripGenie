import { NextResponse } from "next/server";
import {
  invokeTool,
  isAllowedTool,
  LIVE_TOOLS,
  categoryOf,
  type GatewayInvocation,
  type GatewayOutcome,
  type ToolHandler,
} from "@/lib/mcp-gateway";
import {
  fetchDestination,
  fetchWeather,
  fetchCurrency,
} from "@/lib/live-data";
import { resolveImage, type ImageKind } from "@/lib/imagery";
import { BookingService, type OfferLine } from "@/lib/booking";

/**
 * MCP Gateway route (thin App Router edge over lib/mcp-gateway.ts) - design section 3.
 * Single allowlisted tool surface; non-allowlisted names rejected (Req 16.1/16.2);
 * live read tools route through the Live Data Adapter (Req 16.3); read tools kept
 * separate from the transaction tool (Req 16.4); one trace span per call (Req 18.4).
 *
 * Server-side only. No secrets are read or emitted here; backend bindings come from
 * lib/config.ts (non-secret) and provider credentials resolve at the adapter layer.
 */

/** Booking is a process-level transaction edge; one-use tokens live with the service. */
const bookingService = new BookingService();

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

/**
 * The gateway's ToolHandler is synchronous; the live adapters/imagery/booking are
 * resolved before invocation and the handlers simply hand back the resolved value.
 * This preserves allowlist gating, the per-call trace span, and read/transaction
 * separation inside invokeTool while keeping the async I/O at the route boundary.
 */
async function buildHandlers(
  inv: GatewayInvocation,
): Promise<Record<string, ToolHandler>> {
  const args = inv.arguments ?? {};

  // Read tools: destination/places, weather, currency route through the Live
  // Data Adapter (Req 16.3); imagery resolves through the Imagery Service.
  const readHandlers: Record<string, ToolHandler> = {};

  if (inv.tool === "get_destination_context" || inv.tool === "search_destination_places") {
    const dest = str(args, "city") || str(args, "destination");
    const live = await fetchDestination(dest);
    readHandlers[inv.tool] = () => live;
  } else if (inv.tool === "get_weather") {
    const dest = str(args, "city") || str(args, "destination");
    const live = await fetchWeather(dest);
    readHandlers[inv.tool] = () => live;
  } else if (inv.tool === "convert_currency") {
    const from = str(args, "from") || str(args, "base");
    const to = str(args, "to") || str(args, "quote");
    const live = await fetchCurrency(from, to);
    readHandlers[inv.tool] = () => live;
  } else if (inv.tool === "resolve_imagery") {
    const kind = (str(args, "kind", "destination") as ImageKind);
    const query = str(args, "query");
    const slot = Number(args.slot) || 0;
    const rawUrl = str(args, "url");
    const candidate = rawUrl
      ? { url: rawUrl, exactProperty: Boolean(args.exactProperty) }
      : undefined;
    readHandlers[inv.tool] = () => resolveImage({ kind, query, slot }, candidate);
  }

  // Transaction tool: booking is kept strictly apart from the read handlers (Req 16.4).
  const transactionHandlers: Record<string, ToolHandler> = {};
  if (inv.tool === "book_offer_set") {
    transactionHandlers[inv.tool] = (bookArgs) => {
      const offerSet = Array.isArray(bookArgs.offerSet)
        ? bookArgs.offerSet.map((v) => String(v))
        : [];
      const lines: OfferLine[] = Array.isArray(bookArgs.lines)
        ? (bookArgs.lines as unknown[]).map((l) => {
            const line = (l ?? {}) as Record<string, unknown>;
            return {
              kind: (line.kind as OfferLine["kind"]) ?? "activity",
              amount: Number(line.amount) || 0,
            };
          })
        : [];
      const coupon = typeof bookArgs.coupon === "string" ? bookArgs.coupon : undefined;
      const token = typeof bookArgs.confirmationToken === "string"
        ? bookArgs.confirmationToken
        : undefined;
      // Reprice-on-preview, then confirm at most once with a one-use token (Req 12.2-12.7).
      const preview = bookingService.preview(offerSet, lines, coupon);
      const confirmation = bookingService.confirm(token ?? preview.confirmationToken);
      return { preview, confirmation };
    };
  }

  return { ...readHandlers, ...transactionHandlers };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = body as Partial<GatewayInvocation>;
  if (typeof parsed?.tool !== "string") {
    return NextResponse.json({ error: "Missing tool name." }, { status: 400 });
  }

  const inv: GatewayInvocation = {
    tool: parsed.tool,
    arguments:
      parsed.arguments && typeof parsed.arguments === "object"
        ? parsed.arguments
        : {},
  };

  // Reject non-allowlisted tools before any backend work (Req 16.2).
  if (!isAllowedTool(inv.tool)) {
    return NextResponse.json(
      { error: `Tool not allowlisted: ${inv.tool}` },
      { status: 403 },
    );
  }

  const handlers = await buildHandlers(inv);
  const outcome: GatewayOutcome = invokeTool(inv, handlers);

  if (!outcome.ok) {
    // Allowlisted but unhandled (no backend wired) → 404; the gateway reason is surfaced.
    const status = isAllowedTool(inv.tool) ? 404 : 403;
    return NextResponse.json({ error: outcome.reason }, { status });
  }

  return NextResponse.json(
    {
      tool: inv.tool,
      category: categoryOf(inv.tool),
      routedToLive: outcome.routedToLive || LIVE_TOOLS.has(inv.tool),
      span: outcome.span,
      result: outcome.result,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
