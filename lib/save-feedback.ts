// Pure helpers for save feedback toasts and change detection. Client-safe, no server imports.

export type SaveOutcome =
  | { kind: "saved"; scope: "account" | "device" }
  | { kind: "unchanged" }
  | { kind: "failed"; reason?: string };

export type ToastKind = "success" | "info" | "error";
export interface ToastModel {
  id: number;
  kind: ToastKind;
  message: string;
}

export const TOAST_MS = 5000;

const FALLBACK_FAILURE = "Could not save right now. Please try again.";

function failureMessage(reason?: string): string {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) return FALLBACK_FAILURE;
  const base = /[.!?]$/.test(r) ? r : `${r}.`;
  return `${base} Please try again.`;
}

export function toastForSave(prevId: number, o: SaveOutcome): ToastModel {
  const id = prevId + 1;
  switch (o.kind) {
    case "saved":
      return o.scope === "account"
        ? { id, kind: "success", message: "Trip saved. Find it under My trips." }
        : {
            id,
            kind: "success",
            message: "Saved on this device. Sign in to sync it across devices.",
          };
    case "unchanged":
      return { id, kind: "info", message: "Already saved" };
    case "failed":
    default:
      return { id, kind: "error", message: failureMessage((o as { reason?: string }).reason) };
  }
}

function stable(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function" || typeof value === "symbol") return null;
    return value;
  }
  if (seen.has(value)) throw new Error("cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => stable(v, seen));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      out[k] = stable(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

let uniqueCounter = 0;

export function saveFingerprint(i: { name: string; status: string; itinerary: unknown }): string {
  try {
    return JSON.stringify(
      stable({ name: i.name, status: i.status, itinerary: i.itinerary }, new WeakSet()),
    );
  } catch {
    uniqueCounter += 1;
    return `unfingerprintable:${Date.now()}:${uniqueCounter}`;
  }
}

export function shouldSkipSave(lastSaved: string | null, current: string): boolean {
  return lastSaved !== null && lastSaved === current;
}
