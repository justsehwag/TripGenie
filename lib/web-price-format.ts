/**
 * Pure, total display helpers for web-grounded prices. Client-safe: no
 * server-only imports. Never throws for any input.
 */
import { formatInr } from "./itinerary-inr";
import type { RouteFareRange } from "./types";

/** Returns the normalised absolute https: URL, or null for anything else. */
export function safeHttpsHref(url: unknown): string | null {
  try {
    if (typeof url !== "string") return null;
    const s = url.trim();
    if (!s) return null;
    const u = new URL(s);
    if (u.protocol !== "https:" || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** "12 Mar 2025, 2:30 pm" in Asia/Kolkata; empty string for an invalid date. */
export function formatCheckedAt(iso: unknown): string {
  try {
    if (typeof iso !== "string" || !iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    });
  } catch {
    return "";
  }
}

/** "Typical bus fare INR 120–350" (en dash). */
export function routeFareText(rf: RouteFareRange): string {
  try {
    const mode = rf && rf.mode === "train" ? "train" : "bus";
    const min = formatInr(rf ? (rf.minInr as number) : 0);
    const max = formatInr(rf ? (rf.maxInr as number) : 0).replace(/^INR\s*/, "");
    return "Typical " + mode + " fare " + min + "\u2013" + max;
  } catch {
    return "";
  }
}

/** cost 0 -> "Free (per <host>)", otherwise formatInr(cost). */
export function webAmountText(cost: number, host: string): string {
  try {
    if (cost === 0) {
      const h = typeof host === "string" ? host : "";
      return "Free (per " + h + ")";
    }
    return formatInr(cost);
  } catch {
    return "";
  }
}
