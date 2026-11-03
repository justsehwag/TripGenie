import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_ENTRIES,
  TTL_MS,
  createProviderStore,
  type CacheKind,
  type LiveStatus,
  type Stored,
} from "@/lib/providers/provider-store";

// Development clock is 2026-10-30, so fixtures start after it.
const BASE_MS = Date.parse("2026-11-01T00:00:00Z");
const MIN = 60_000;

interface Value extends Stored {
  id: number;
}

type Op =
  | { type: "set"; key: string; kind: CacheKind; status: LiveStatus; delta: number }
  | { type: "get"; key: string; delta: number };

/** Reference model: array ordered least recently used first. */
interface ModelEntry {
  key: string;
  value: Value;
  expiresAtMs: number;
}

class ReferenceCache {
  private entries: ModelEntry[] = [];
  constructor(private readonly capacity: number) {}

  get(key: string, nowMs: number): Value | null {
    const i = this.entries.findIndex((e) => e.key === key);
    if (i < 0) return null;
    const entry = this.entries[i];
    this.entries.splice(i, 1);
    if (nowMs > entry.expiresAtMs) return null; // expired entries are dropped
    this.entries.push(entry); // hit refreshes recency
    return entry.value;
  }

  set(key: string, value: Value, kind: CacheKind, completedAtMs: number): void {
    if (value.status !== "live") return; // only live results are cached
    const ttl = kind === "search" ? 45 * MIN : 15 * MIN;
    const i = this.entries.findIndex((e) => e.key === key);
    if (i >= 0) {
      this.entries.splice(i, 1);
    } else if (this.entries.length >= this.capacity) {
      this.entries.shift(); // evict the least recently used
    }
    this.entries.push({ key, value, expiresAtMs: completedAtMs + ttl });
  }

  size(): number {
    return this.entries.length;
  }
}

// Small key pool (larger than capacity 5) so hits, overwrites and evictions all happen.
const keyArb = fc.constantFrom("k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7");
const kindArb = fc.constantFrom<CacheKind>("search", "detail");
const statusArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant<LiveStatus>("live") },
  { weight: 1, arbitrary: fc.constantFrom<LiveStatus>("unconfigured", "invalid", "unavailable") },
);
// Non-negative deltas keep timestamps non-decreasing; constants hit the TTL boundaries.
const deltaArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0, max: 5 * MIN }),
  fc.constantFrom(1, 15 * MIN, 15 * MIN + 1, 30 * MIN, 45 * MIN, 45 * MIN + 1),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    type: fc.constant("set" as const),
    key: keyArb,
    kind: kindArb,
    status: statusArb,
    delta: deltaArb,
  }),
  fc.record({ type: fc.constant("get" as const), key: keyArb, delta: deltaArb }),
);

// Feature: live-travel-pricing, Property 6: Provider store matches a reference cache model
describe("Property 6: Provider store matches a reference cache model", () => {
  it("get returns exactly what the reference model returns, as the identical stored object", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        const capacity = 5;
        const store = createProviderStore(capacity);
        const model = new ReferenceCache(capacity);
        let clock = BASE_MS;
        let nextId = 0;

        for (const op of ops) {
          clock += op.delta;
          if (op.type === "set") {
            const value: Value = {
              id: nextId++,
              status: op.status,
              checkedAt: new Date(clock).toISOString(),
            };
            store.set(op.key, value, op.kind, clock);
            model.set(op.key, value, op.kind, clock);
          } else {
            const expected = model.get(op.key, clock);
            const actual = store.get<Value>(op.key, clock);
            if (expected === null) {
              expect(actual).toBeNull();
            } else {
              // Identical object, so checkedAt is the original completion time.
              expect(actual).toBe(expected);
              expect(actual?.checkedAt).toBe(expected.checkedAt);
              expect(actual?.status).toBe("live");
            }
          }
          expect(store.stats().entries).toBe(model.size());
          expect(store.stats().entries).toBeLessThanOrEqual(capacity);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("uses 45 min / 15 min TTLs and a production capacity of 200 entries", () => {
    expect(TTL_MS.search).toBe(45 * MIN);
    expect(TTL_MS.detail).toBe(15 * MIN);
    expect(MAX_ENTRIES).toBe(200);

    const store = createProviderStore();
    const values: Value[] = [];
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      const value: Value = { id: i, status: "live", checkedAt: new Date(BASE_MS + i).toISOString() };
      values.push(value);
      store.set(`k${i}`, value, "search", BASE_MS + i);
      expect(store.stats().entries).toBe(Math.min(i + 1, MAX_ENTRIES));
    }

    const now = BASE_MS + MAX_ENTRIES;
    // Inserting the 201st key evicted only the least recently used (k0).
    expect(store.get("k0", now)).toBeNull();
    expect(store.get<Value>("k1", now)).toBe(values[1]);
    expect(store.get<Value>(`k${MAX_ENTRIES}`, now)).toBe(values[MAX_ENTRIES]);
    expect(store.stats().entries).toBe(MAX_ENTRIES);
  });
});

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Outcome = { ok: true; value: number } | { ok: false; message: string };
const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.record({ ok: fc.constant(true as const), value: fc.integer() }),
  fc.record({ ok: fc.constant(false as const), message: fc.string() }),
);

// Feature: live-travel-pricing, Property 7: Concurrent identical requests share one call
describe("Property 7: Concurrent identical requests share one call", () => {
  it("n concurrent callers trigger one producer call, see the same outcome, and leave no in-flight entry", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        outcomeArb,
        fc.string({ minLength: 1, maxLength: 12 }),
        async (n, outcome, key) => {
          const store = createProviderStore();
          const d = deferred<{ value: number }>();
          let calls = 0;
          const producer = () => {
            calls += 1;
            return d.promise;
          };

          const callers = Array.from({ length: n }, () => store.dedupe(key, producer));
          expect(calls).toBe(1);
          expect(store.stats().inFlight).toBe(1);

          const payload = { value: outcome.ok ? outcome.value : 0 };
          const error = new Error(outcome.ok ? "" : outcome.message);
          if (outcome.ok) d.resolve(payload);
          else d.reject(error);

          const settled = await Promise.allSettled(callers);
          expect(calls).toBe(1);
          expect(store.stats().inFlight).toBe(0);
          for (const s of settled) {
            if (outcome.ok) {
              expect(s.status).toBe("fulfilled");
              // Identical object for every caller.
              expect((s as PromiseFulfilledResult<{ value: number }>).value).toBe(payload);
            } else {
              expect(s.status).toBe("rejected");
              expect((s as PromiseRejectedResult).reason).toBe(error);
            }
          }

          // After settlement a new call to the same key runs the producer again.
          const again = store.dedupe(key, async () => {
            calls += 1;
            return { value: 1 };
          });
          expect(store.stats().inFlight).toBe(1);
          await expect(again).resolves.toEqual({ value: 1 });
          expect(calls).toBe(2);
          expect(store.stats().inFlight).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("different keys do not share a producer call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 2, maxLength: 6 }),
        fc.integer({ min: 1, max: 5 }),
        async (keys, perKey) => {
          const store = createProviderStore();
          const calls = new Map<string, number>();
          const pending: Promise<string>[] = [];
          for (let r = 0; r < perKey; r++) {
            for (const key of keys) {
              pending.push(
                store.dedupe(key, async () => {
                  calls.set(key, (calls.get(key) ?? 0) + 1);
                  return key;
                }),
              );
            }
          }
          expect(store.stats().inFlight).toBe(keys.length);
          const results = await Promise.all(pending);
          for (const key of keys) expect(calls.get(key)).toBe(1);
          // Each caller received its own key's result.
          results.forEach((r, i) => expect(r).toBe(keys[i % keys.length]));
          expect(store.stats().inFlight).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("a producer that throws synchronously rejects every caller and clears the registry", async () => {
    const store = createProviderStore();
    const error = new Error("boom");
    let calls = 0;
    const producer = (): Promise<number> => {
      calls += 1;
      throw error;
    };
    const settled = await Promise.allSettled([
      store.dedupe("k", producer),
      store.dedupe("k", producer),
    ]);
    expect(calls).toBe(1);
    for (const s of settled) {
      expect(s.status).toBe("rejected");
      expect((s as PromiseRejectedResult).reason).toBe(error);
    }
    expect(store.stats().inFlight).toBe(0);
  });
});

/** parseSoftLimit from the module under test (DEFAULT_SOFT_LIMIT = 225). */
import { DEFAULT_SOFT_LIMIT, parseSoftLimit } from "@/lib/providers/provider-store";

// Feature: live-travel-pricing, Property 9: Soft-limit parsing
describe("Property 9: Soft-limit parsing", () => {
  it("accepts a trimmed, all-digit, safe positive integer and returns that number", () => {
    const valueArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    // Surround the digits with assorted whitespace that trim() removes.
    const padArb = fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r", "\f", "\v"), {
      maxLength: 4,
    });

    fc.assert(
      fc.property(valueArb, padArb, padArb, (n, left, right) => {
        const raw = `${left}${n}${right}`;
        expect(parseSoftLimit(raw)).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it("falls back to DEFAULT_SOFT_LIMIT for anything that is not a safe positive integer", () => {
    // Values that must all map to the default: empty, whitespace, zero, negatives,
    // decimals, exponents, signs, non-numeric text and unsafe-large integers.
    const badArb = fc.oneof(
      fc.constantFrom(
        "",
        " ",
        "   ",
        "\t\n ",
        "0",
        " 0 ",
        "00",
        "-1",
        "-42",
        "+5",
        "1.5",
        "0.0",
        ".5",
        "1e3",
        "1E3",
        "2e10",
        "0x1F",
        "abc",
        "12abc",
        "abc12",
        "12 34",
        "NaN",
        "Infinity",
        "一二三",
      ),
      // Negative integers rendered as strings.
      fc.integer({ min: -1_000_000, max: 0 }).map((n) => String(n)),
      // Decimals.
      fc
        .float({ min: Math.fround(0.1), max: Math.fround(9999), noNaN: true })
        .map((n) => String(n + 0.5)),
      // Unsafe-large all-digit strings (digits pass the regex but exceed the safe range).
      fc
        .bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), max: BigInt(Number.MAX_SAFE_INTEGER) * BigInt(1000) })
        .map((b) => b.toString()),
    );

    fc.assert(
      fc.property(badArb, (raw) => {
        expect(parseSoftLimit(raw)).toBe(DEFAULT_SOFT_LIMIT);
      }),
      { numRuns: 100 },
    );
  });

  it("covers the required explicit examples", () => {
    // Valid: trims surrounding whitespace.
    expect(parseSoftLimit(" 42 ")).toBe(42);
    expect(parseSoftLimit("225")).toBe(225);
    expect(parseSoftLimit("1")).toBe(1);

    // undefined -> default.
    expect(parseSoftLimit(undefined)).toBe(DEFAULT_SOFT_LIMIT);
    // empty and whitespace-only -> default.
    expect(parseSoftLimit("")).toBe(DEFAULT_SOFT_LIMIT);
    expect(parseSoftLimit("   ")).toBe(DEFAULT_SOFT_LIMIT);
    // zero -> default.
    expect(parseSoftLimit("0")).toBe(DEFAULT_SOFT_LIMIT);
    // negative -> default.
    expect(parseSoftLimit("-5")).toBe(DEFAULT_SOFT_LIMIT);
    // decimal -> default.
    expect(parseSoftLimit("1.5")).toBe(DEFAULT_SOFT_LIMIT);
    // exponent -> default.
    expect(parseSoftLimit("1e3")).toBe(DEFAULT_SOFT_LIMIT);
    // non-numeric text -> default.
    expect(parseSoftLimit("abc")).toBe(DEFAULT_SOFT_LIMIT);
    // unsafe-large all-digit string -> default.
    expect(parseSoftLimit("99999999999999999999")).toBe(DEFAULT_SOFT_LIMIT);
    // DEFAULT_SOFT_LIMIT is the documented 225.
    expect(DEFAULT_SOFT_LIMIT).toBe(225);
  });
});
