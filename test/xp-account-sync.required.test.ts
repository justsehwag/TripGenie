import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

// Fake verifier: token "tk.<sub>" verifies to that sub. No network, no JWKS.
vi.mock("../lib/auth/verifier", () => ({
  getVerifier: () => ({}),
  verifyIdToken: async (token: string) => {
    const m = /^tk\.(.+)$/.exec(token);
    if (!m) throw new Error("bad token");
    return { sub: m[1], email: `${m[1]}@example.com` };
  },
}));

import { GET as xpGet, POST as xpPost } from "../app/api/xp/route";
import { resetAccountStoreForTests, setAccountStoreForTests } from "../lib/account/store";
import { buildSetCookies } from "../lib/auth/session-cookie";
import { VersionConflictError } from "../lib/dynamo-store";
import { awardMany, emptyXp, XP_POINTS, type XpEvent } from "../lib/gamification";
import { MemoryAccountStore } from "./helpers/memory-account-store";

const ORIGIN = "http://localhost:3000";
const EVENTS = Object.keys(XP_POINTS) as XpEvent[];
const NUM_RUNS = 100;

class SpyStore extends MemoryAccountStore {
  getCalls = 0;
  putCalls = 0;
  /** Number of upcoming putXp calls that fail with VersionConflictError. */
  failPuts = 0;

  async getXp(userId: string) {
    this.getCalls++;
    return super.getXp(userId);
  }

  async putXp(userId: string, data: unknown, expectedVersion: number) {
    this.putCalls++;
    if (this.failPuts > 0) {
      this.failPuts--;
      throw new VersionConflictError(expectedVersion + 1);
    }
    return super.putXp(userId, data, expectedVersion);
  }
}

function sessionCookie(sub: string): string {
  const [idCookie] = buildSetCookies(
    { idToken: `tk.${sub}`, refreshToken: "rt.refresh" },
    { secure: false, maxAgeSeconds: 3600 },
  );
  return idCookie.split(";")[0];
}

function post(sub: string | null, body: unknown): Request {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (sub) headers.cookie = sessionCookie(sub);
  return new Request(`${ORIGIN}/api/xp`, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(sub: string | null): Request {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (sub) headers.cookie = sessionCookie(sub);
  return new Request(`${ORIGIN}/api/xp`, { method: "GET", headers });
}

let store: SpyStore;
let counter = 0;
/** Unique user per call so the per-user rate limiter never interferes. */
const newSub = () => `xp-user-${++counter}`;

beforeEach(() => {
  vi.stubEnv("TRIPGENIE_APP_ORIGIN", ORIGIN);
  vi.stubEnv("TRIPGENIE_TRIPS_TABLE", "xp-test-trips-table");
  vi.stubEnv("TRIPGENIE_PROFILES_TABLE", "xp-test-profiles-table");
  store = new SpyStore();
  setAccountStoreForTests(store);
});

afterEach(() => {
  resetAccountStoreForTests();
  vi.unstubAllEnvs();
});

describe("xp award: engine equivalence (Property 1)", () => {
  it("example: two events sum their points", async () => {
    const sub = newSub();
    await xpPost(post(sub, { event: "route_set", idempotencyKey: "k1" }));
    const res = await xpPost(post(sub, { event: "dates_set", idempotencyKey: "k2" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 20, awarded: ["route_set", "dates_set"] });
  });

  it("server total and awarded equal awardMany over unique-key events", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...EVENTS), { minLength: 1, maxLength: 12 }), async (events) => {
        const sub = newSub();
        let last: { total: number; awarded: XpEvent[] } | null = null;
        for (let i = 0; i < events.length; i++) {
          const res = await xpPost(post(sub, { event: events[i], idempotencyKey: `key-${i}` }));
          expect(res.status).toBe(200);
          last = await res.json();
        }
        const expected = awardMany(emptyXp(), events);
        expect(last).toEqual({ total: expected.total, awarded: expected.awarded });
        const got = await (await xpGet(get(sub))).json();
        expect(got).toEqual({ total: expected.total, awarded: expected.awarded });
        const distinctSum = [...new Set(events)].reduce((s, e) => s + XP_POINTS[e], 0);
        expect(got.total).toBe(distinctSum);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("xp award: duplicate idempotency keys (Property 2)", () => {
  it("example: replaying a key returns current state without a write", async () => {
    const sub = newSub();
    await xpPost(post(sub, { event: "route_set", idempotencyKey: "same" }));
    const puts = store.putCalls;
    const res = await xpPost(post(sub, { event: "trip_confirmed", idempotencyKey: "same" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 10, awarded: ["route_set"] });
    expect(store.putCalls).toBe(puts);
  });

  it("replaying any sequence with the same keys changes nothing and never calls putXp", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...EVENTS), { minLength: 1, maxLength: 6 }), async (events) => {
        const sub = newSub();
        const send = async () => {
          for (let i = 0; i < events.length; i++) {
            const res = await xpPost(post(sub, { event: events[i], idempotencyKey: `key-${i}` }));
            expect(res.status).toBe(200);
          }
        };
        await send();
        const before = await store.getXp(sub);
        const putsBefore = store.putCalls;
        await send();
        expect(store.putCalls).toBe(putsBefore);
        expect(await store.getXp(sub)).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("xp award: rejects invalid input (Property 3)", () => {
  const badEvent = fc
    .oneof(
      fc.string({ maxLength: 30 }),
      fc.constantFrom("constructor", "__proto__", "toString", "hasOwnProperty", ""),
      fc.constant(undefined as unknown as string),
      fc.integer() as unknown as fc.Arbitrary<string>,
    )
    .filter((e) => !(typeof e === "string" && (EVENTS as string[]).includes(e)));

  const badKey = fc.oneof(
    fc.constant(undefined),
    fc.constant(""),
    fc.constant(null),
    fc.integer(),
    fc.integer({ min: 129, max: 400 }).map((n) => "a".repeat(n)),
    fc.constantFrom("has space", "tab\there", "new\nline", "emoji\u{1F600}", "semi;colon", "<script>"),
  );

  it("unknown events yield 400 and nothing is stored", async () => {
    await fc.assert(
      fc.asyncProperty(badEvent, async (event) => {
        const sub = newSub();
        const res = await xpPost(post(sub, { event, idempotencyKey: "good-key" }));
        expect(res.status).toBe(400);
        expect(store.putCalls).toBe(0);
        expect(await store.getXp(sub)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("missing, empty, oversized or unsafe keys yield 400 and nothing is stored", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...EVENTS), badKey, async (event, idempotencyKey) => {
        const sub = newSub();
        const res = await xpPost(post(sub, { event, idempotencyKey }));
        expect(res.status).toBe(400);
        expect(store.putCalls).toBe(0);
        expect(await store.getXp(sub)).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("example: 128-char key accepted, 129-char key rejected", async () => {
    const sub = newSub();
    expect((await xpPost(post(sub, { event: "route_set", idempotencyKey: "a".repeat(128) }))).status).toBe(200);
    expect((await xpPost(post(sub, { event: "dates_set", idempotencyKey: "a".repeat(129) }))).status).toBe(400);
  });
});

describe("xp award: client-sent totals are ignored (Property 4)", () => {
  it("extra total/awarded/userId/processedKeys fields do not affect state or owner", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...EVENTS),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.array(fc.constantFrom(...EVENTS), { maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== "__proto__"),
        async (event, total, awarded, otherUser) => {
          const sub = newSub();
          const victim = `victim-${sub}`;
          const res = await xpPost(
            post(sub, {
              event,
              idempotencyKey: "k-1",
              total,
              awarded,
              userId: victim,
              processedKeys: ["k-1", "k-2"],
              owner: otherUser,
            }),
          );
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ total: XP_POINTS[event], awarded: [event] });
          expect(await store.getXp(victim)).toBeNull();
          const stored = await store.getXp(sub);
          expect((stored?.data as { total: number }).total).toBe(XP_POINTS[event]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("xp award: guests are never stored (Property 5)", () => {
  it("POST and GET without a session return 401 and never touch the store", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...EVENTS), fc.string({ minLength: 1, maxLength: 20 }), async (event, key) => {
        const res = await xpPost(post(null, { event, idempotencyKey: key }));
        expect(res.status).toBe(401);
        expect((await xpGet(get(null))).status).toBe(401);
        expect(store.getCalls).toBe(0);
        expect(store.putCalls).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("xp award: version conflicts (Property 7)", () => {
  it("one conflict is retried once and the award is applied once", async () => {
    const sub = newSub();
    store.failPuts = 1;
    const res = await xpPost(post(sub, { event: "itinerary_generated", idempotencyKey: "k-retry" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 20, awarded: ["itinerary_generated"] });
    expect(store.putCalls).toBe(2);
    expect((await store.getXp(sub))?.version).toBe(1);
  });

  it("two conflicts return 409 and leave state unchanged", async () => {
    const sub = newSub();
    await xpPost(post(sub, { event: "route_set", idempotencyKey: "k-base" }));
    const before = await store.getXp(sub);
    store.failPuts = 2;
    const res = await xpPost(post(sub, { event: "trip_confirmed", idempotencyKey: "k-conflict" }));
    expect(res.status).toBe(409);
    expect(await store.getXp(sub)).toEqual(before);
  });

  it("holds for any k of failing puts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.constantFrom(...EVENTS), async (k, event) => {
        const sub = newSub();
        store.failPuts = k;
        const res = await xpPost(post(sub, { event, idempotencyKey: "k-any" }));
        store.failPuts = 0;
        const stored = await store.getXp(sub);
        if (k <= 1) {
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ total: XP_POINTS[event], awarded: [event] });
        } else {
          expect(res.status).toBe(409);
          expect(stored).toBeNull();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
