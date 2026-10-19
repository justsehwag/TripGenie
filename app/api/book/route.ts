import { NextRequest, NextResponse } from "next/server";
import { BookingService, type OfferLine } from "@/lib/booking";
import { confirmOnce, type IdempotencyStore } from "@/lib/booking-store";

/**
 * Booking edge route - design section 14 (Booking Service), Requirement 12.
 * Thin App Router handler over the pure booking core (`lib/booking.ts`) and the
 * at-most-once idempotency port (`lib/booking-store.ts`). Read/transaction
 * separation is preserved: `preview` reprices and issues a one-use token;
 * `confirm` executes the order at most once via `confirmOnce`.
 */

/**
 * In-memory dev/demo IdempotencyStore. This stands in for the DynamoDB
 * conditional-put edge (Task 20) until contracted credentials exist. It is NOT
 * durable and NOT a real conditional-put client - do not treat it as one.
 * A module-level accessor keeps a single instance alive for the process so
 * duplicate confirmations within a run dedupe as designed (Req 12.6).
 */
class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, string>();
  async putIfAbsent(key: string, orderId: string): Promise<boolean> {
    if (this.map.has(key)) return false;
    this.map.set(key, orderId);
    return true;
  }
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
}

// Process-scoped singletons. No contracted supplier credentials are wired here,
// so confirmations are necessarily estimated (Req 12.7). Do not fabricate AWS
// or supplier credentials to flip this on.
let idempotencyStore: IdempotencyStore | null = null;
let bookingService: BookingService | null = null;

function getIdempotencyStore(): IdempotencyStore {
  return (idempotencyStore ??= new InMemoryIdempotencyStore());
}

function getBookingService(): BookingService {
  // `false`: no contracted credentials/settlement, so confirmations are estimated.
  return (bookingService ??= new BookingService(false));
}

interface PreviewRequest {
  action: "preview";
  offerSet: string[];
  lines: OfferLine[];
  coupon?: string;
}

interface ConfirmRequest {
  action: "confirm";
  token: string;
}

type BookRequest = PreviewRequest | ConfirmRequest;

const OFFER_KINDS = new Set<OfferLine["kind"]>(["flight", "stay", "activity"]);

function isOfferLine(value: unknown): value is OfferLine {
  if (typeof value !== "object" || value === null) return false;
  const line = value as Record<string, unknown>;
  return (
    typeof line.kind === "string" &&
    OFFER_KINDS.has(line.kind as OfferLine["kind"]) &&
    typeof line.amount === "number" &&
    Number.isFinite(line.amount)
  );
}

function parseRequest(body: unknown): BookRequest | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "A booking request body is required." };
  }
  const data = body as Record<string, unknown>;

  if (data.action === "preview") {
    if (
      !Array.isArray(data.offerSet) ||
      data.offerSet.length === 0 ||
      !data.offerSet.every((o) => typeof o === "string" && o.length > 0)
    ) {
      return { error: "Select at least one offer to preview." };
    }
    if (!Array.isArray(data.lines) || data.lines.length === 0 || !data.lines.every(isOfferLine)) {
      return { error: "Provide the priced offer lines to preview." };
    }
    if (data.coupon !== undefined && typeof data.coupon !== "string") {
      return { error: "The coupon must be a text value." };
    }
    return {
      action: "preview",
      offerSet: data.offerSet as string[],
      lines: data.lines as OfferLine[],
      coupon: data.coupon as string | undefined,
    };
  }

  if (data.action === "confirm") {
    if (typeof data.token !== "string" || data.token.length === 0) {
      return { error: "A confirmation token is required to confirm." };
    }
    return { action: "confirm", token: data.token };
  }

  return { error: "Specify a 'preview' or 'confirm' action." };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const parsed = parseRequest(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const service = getBookingService();

    if (parsed.action === "preview") {
      // Reprice via the Pricing Engine and issue the one-use token (Req 12.2/12.3).
      const preview = service.preview(parsed.offerSet, parsed.lines, parsed.coupon);
      return NextResponse.json(preview, { status: 200 });
    }

    // Confirm requires the matching token (Req 12.4). The booking core rejects
    // unknown or already-used tokens (Req 12.5).
    const outcome = service.confirm(parsed.token);
    if ("rejected" in outcome) {
      return NextResponse.json({ error: outcome.reason }, { status: 409 });
    }

    // At-most-once across duplicate confirmation requests for one order, keyed
    // on the one-use token (Req 12.6). First caller wins the conditional put;
    // duplicates return the same order id with deduped=true.
    const store = getIdempotencyStore();
    const idempotent = await confirmOnce(store, parsed.token, () => outcome.orderId);

    // Without contracted credentials, the confirmation is estimated: no payment
    // taken and no valid ticket or room issued (Req 12.7). The disclaimer from
    // the booking core carries that surface-visible notice.
    return NextResponse.json(
      {
        orderId: idempotent.orderId,
        status: outcome.status,
        disclaimer: outcome.disclaimer,
        deduped: idempotent.deduped,
      },
      { status: idempotent.deduped ? 200 : 201 },
    );
  } catch {
    // Never leak internals to the caller.
    return NextResponse.json({ error: "The booking request could not be completed." }, { status: 500 });
  }
}
