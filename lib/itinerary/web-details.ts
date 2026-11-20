/**
 * Sanitiser for untrusted `webDetails` on a Stop (wire and stored data).
 * Pure and total. Client-safe: imports no server-only module.
 */
import type { WebDetail, WebDetails } from "@/lib/types";
import { isValidWebFields } from "@/lib/web-price-sources";

const MAX_TEXT = 240;

function readDetail(raw: unknown): WebDetail | undefined {
  try {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    const { text, sourceUrl, sourceHost, checkedAt } = r;
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT) {
      return undefined;
    }
    if (!isValidWebFields({ sourceUrl, sourceHost, checkedAt })) return undefined;
    return {
      text,
      sourceUrl: sourceUrl as string,
      sourceHost: sourceHost as string,
      checkedAt: checkedAt as string,
    };
  } catch {
    return undefined;
  }
}

/**
 * Returns a normalised copy, or undefined when the value is not an object or
 * `checked` is not a boolean. An invalid tip, booking or bestTime is dropped on
 * its own; an invalid priceKind is dropped. Unknown keys are not copied.
 */
export function sanitizeWebDetails(raw: unknown): WebDetails | undefined {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (typeof r.checked !== "boolean") return undefined;
    const out: WebDetails = { checked: r.checked };
    const tip = readDetail(r.tip);
    if (tip) out.tip = tip;
    const booking = readDetail(r.booking);
    if (booking) out.booking = booking;
    const bestTime = readDetail(r.bestTime);
    if (bestTime) out.bestTime = bestTime;
    if (r.priceKind === "entry" || r.priceKind === "typical") {
      out.priceKind = r.priceKind;
    }
    if (r.unavailable === true) out.unavailable = true;
    return out;
  } catch {
    return undefined;
  }
}
