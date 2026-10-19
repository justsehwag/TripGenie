import type { TripPricing } from "./types";
import { calculateTripPricing } from "./pricing";

/**
 * Booking Service core (pure logic) - design section 14.
 * Read/transaction separation; reprice-on-preview; one-use token; at-most-once.
 * Requirements: 12.1-12.7.
 */

export interface OfferLine {
  kind: "flight" | "stay" | "activity";
  amount: number;
}

export interface BookingPreview {
  offerSet: string[];
  pricing: TripPricing;
  confirmationToken: string;
}

export interface BookingConfirmation {
  orderId: string;
  status: "estimated" | "confirmed";
  disclaimer: string;
}

/** In-memory booking store; the DynamoDB edge (Task 20) backs this with a conditional put. */
export class BookingService {
  private readonly tokens = new Map<string, { used: boolean; orderId?: string }>();
  private seq = 0;

  constructor(private readonly credentialed = false) {}

  /** Reprice the offer set and issue a one-use confirmation token (Req 12.2/12.3). */
  preview(offerSet: string[], lines: OfferLine[], coupon?: string): BookingPreview {
    const flight = lines.filter((l) => l.kind === "flight").reduce((s, l) => s + l.amount, 0);
    const stay = lines.filter((l) => l.kind === "stay").reduce((s, l) => s + l.amount, 0);
    const activities = lines.filter((l) => l.kind === "activity").reduce((s, l) => s + l.amount, 0);
    const pricing = calculateTripPricing({ flight, stay, activities, coupon });
    const token = `ct-${++this.seq}-${offerSet.join(".")}`;
    this.tokens.set(token, { used: false });
    return { offerSet, pricing, confirmationToken: token };
  }

  /** Confirm with the matching token; executes at most once (Req 12.4-12.7). */
  confirm(token: string): BookingConfirmation | { rejected: true; reason: string } {
    const entry = this.tokens.get(token);
    if (!entry) return { rejected: true, reason: "Unknown confirmation token." };
    if (entry.used) {
      // Duplicate confirmation: return the same order, never a second one.
      return { rejected: true, reason: "Confirmation token already used." };
    }
    const orderId = `ord-${token}`;
    entry.used = true;
    entry.orderId = orderId;
    return this.credentialed
      ? { orderId, status: "confirmed", disclaimer: "Confirmed with the contracted supplier." }
      : {
          orderId,
          status: "estimated",
          disclaimer: "Estimated only: no payment taken and no valid ticket or room issued.",
        };
  }
}
