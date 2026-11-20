/**
 * Server-side XP service. Validates award requests, applies the unchanged
 * engine in lib/gamification.ts, de-duplicates by idempotency key and writes
 * with a version check. Clients only ever supply { event, idempotencyKey }.
 */
import { award, emptyXp, XP_POINTS, type XpEvent, type XpState } from "../gamification";
import { VersionConflictError } from "../dynamo-store";
import type { AccountStore } from "./dynamo-account-store";

export const MAX_KEY_LEN = 128;
export const KEY_RING_SIZE = 200;

/** Safe charset for idempotency keys (no whitespace or control characters). */
const KEY_PATTERN = /^[A-Za-z0-9._:@\/=+~-]+$/;

export interface XpRecord extends XpState {
  processedKeys: string[];
}

export type ValidatedAward = { event: XpEvent; idempotencyKey: string };
export type XpResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 409; error: string };

export interface AwardOutcome {
  total: number;
  awarded: XpEvent[];
  state: XpState;
}

/** Thrown by awardXp when the record still conflicts after one retry (HTTP 409). */
export class XpConflictError extends Error {
  readonly status = 409 as const;
  constructor(message = "XP update conflict. Please retry.") {
    super(message);
    this.name = "XpConflictError";
  }
}

function isXpEvent(v: unknown): v is XpEvent {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(XP_POINTS, v);
}

/** Reads only `event` and `idempotencyKey`; every other field is ignored. */
export function validateAward(body: unknown): XpResult<ValidatedAward> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Invalid request." };
  }
  const { event, idempotencyKey } = body as Record<string, unknown>;
  if (!isXpEvent(event)) return { ok: false, status: 400, error: "Unknown XP event." };
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > MAX_KEY_LEN ||
    !KEY_PATTERN.test(idempotencyKey)
  ) {
    return { ok: false, status: 400, error: "Invalid idempotency key." };
  }
  return { ok: true, value: { event, idempotencyKey } };
}

/** Pure: applies one award. Duplicate key or already-awarded event leaves total/awarded unchanged. */
export function applyAward(rec: XpRecord, a: ValidatedAward): XpRecord {
  if (rec.processedKeys.includes(a.idempotencyKey)) return rec;
  const next = award(rec, a.event);
  const processedKeys = [...rec.processedKeys, a.idempotencyKey].slice(-KEY_RING_SIZE);
  return { total: next.total, awarded: next.awarded, processedKeys };
}

/** Stored `data` -> XpRecord. Malformed or missing data yields an empty record. */
export function parseXpRecord(data: unknown): XpRecord {
  const empty: XpRecord = { ...emptyXp(), processedKeys: [] };
  if (!data || typeof data !== "object" || Array.isArray(data)) return empty;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.awarded)) return empty;
  const awarded: XpEvent[] = [];
  for (const e of d.awarded) if (isXpEvent(e) && !awarded.includes(e)) awarded.push(e);
  const total = awarded.reduce((sum, e) => sum + XP_POINTS[e], 0);
  const keys = Array.isArray(d.processedKeys)
    ? d.processedKeys.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= MAX_KEY_LEN)
    : [];
  return { total, awarded, processedKeys: keys.slice(-KEY_RING_SIZE) };
}

function toState(rec: XpRecord): XpState {
  return { total: rec.total, awarded: [...rec.awarded] };
}

export async function readXp(store: AccountStore, userId: string): Promise<XpState> {
  const row = await store.getXp(userId);
  return toState(parseXpRecord(row?.data));
}

/**
 * Load, apply, putXp with expectedVersion. On VersionConflictError reload,
 * reapply and retry once; a second conflict throws XpConflictError (409).
 * A duplicate key returns the current state without writing.
 */
export async function awardXp(store: AccountStore, userId: string, a: ValidatedAward): Promise<AwardOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await store.getXp(userId);
    const current = parseXpRecord(row?.data);
    const next = applyAward(current, a);
    if (next === current) return outcome(current);
    try {
      await store.putXp(userId, next, row?.version ?? 0);
      return outcome(next);
    } catch (err) {
      if (err instanceof VersionConflictError) continue;
      throw err;
    }
  }
  throw new XpConflictError();
}

function outcome(rec: XpRecord): AwardOutcome {
  const state = toState(rec);
  return { total: state.total, awarded: state.awarded, state };
}
