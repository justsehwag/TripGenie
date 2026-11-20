import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake verifier: token "tk.<sub>" verifies to that sub. No network, no JWKS.
vi.mock("../lib/auth/verifier", () => ({
  getVerifier: () => ({}),
  verifyIdToken: async (token: string) => {
    const m = /^tk\.(.+)$/.exec(token);
    if (!m) throw new Error("bad token");
    return { sub: m[1], email: `${m[1]}@example.com` };
  },
}));

import { GET as tripsGet, POST as tripsPost, DELETE as tripsDelete } from "../app/api/trips/route";
import { GET as profileGet, PUT as profilePut, POST as profilePost } from "../app/api/profile/route";
import { GET as prefsGet, PUT as prefsPut } from "../app/api/preferences/route";
import { resetAccountStoreForTests, setAccountStoreForTests } from "../lib/account/store";
import { buildSetCookies, cookieNames } from "../lib/auth/session-cookie";
import { MemoryAccountStore } from "./helpers/memory-account-store";

const ORIGIN = "http://localhost:3000";
const TABLE = "secret-trips-table-xyz";
const ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/secret-trips-table-xyz";

const USER_A = "user-a-sub";
const USER_B = "user-b-sub";

function sessionCookie(sub: string): string {
  const [idCookie] = buildSetCookies(
    { idToken: `tk.${sub}`, refreshToken: "rt.refresh" },
    { secure: false, maxAgeSeconds: 3600 },
  );
  return idCookie.split(";")[0];
}

interface Opts {
  sub?: string | null;
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
  query?: string;
}

function call(method: string, path: string, o: Opts = {}): Request {
  const headers: Record<string, string> = {};
  const sub = o.sub === undefined ? USER_A : o.sub;
  if (sub) headers.cookie = sessionCookie(sub);
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  let body: string | undefined;
  if (o.rawBody !== undefined) body = o.rawBody;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}${path}${o.query ?? ""}`, { method, headers, body });
}

const prefs = {
  country: "IN",
  homeCity: "Mumbai",
  travelStyle: "balanced",
  pace: "moderate",
  diet: "no_preference",
  tripLength: "short",
  travellers: 2,
  interests: ["culture", "food"],
};

const profile = {
  displayName: "Asha",
  homeCity: "Mumbai",
  travelStyle: "balanced",
  locale: "en-IN",
  party: { adults: 2, children: 0 },
};

const trip = (id = "draft-1") => ({ clientDraftId: id, name: "Goa", payload: { days: [] } });

let store: MemoryAccountStore;

beforeEach(() => {
  vi.stubEnv("TRIPGENIE_APP_ORIGIN", ORIGIN);
  vi.stubEnv("TRIPGENIE_TRIPS_TABLE", TABLE);
  vi.stubEnv("TRIPGENIE_PROFILES_TABLE", "secret-profiles-table-xyz");
  store = new MemoryAccountStore();
  setAccountStoreForTests(store);
});

afterEach(() => {
  resetAccountStoreForTests();
  vi.unstubAllEnvs();
});

describe("cookie names", () => {
  it("uses the non-secure names for an http app origin", () => {
    expect(cookieNames(false).id).toBe("tg_id");
    expect(sessionCookie(USER_A).startsWith("tg_id=")).toBe(true);
  });
});

describe("401 without a session", () => {
  it("trips, profile and preferences reject anonymous requests", async () => {
    const responses = await Promise.all([
      tripsGet(call("GET", "/api/trips", { sub: null })),
      tripsPost(call("POST", "/api/trips", { sub: null, body: trip() })),
      tripsDelete(call("DELETE", "/api/trips", { sub: null, body: { tripId: "t_x" } })),
      profileGet(call("GET", "/api/profile", { sub: null })),
      profilePut(call("PUT", "/api/profile", { sub: null, body: { expectedVersion: 0, changes: profile } })),
      profilePost(call("POST", "/api/profile", { sub: null, body: { expectedVersion: 0, changes: profile } })),
      prefsGet(call("GET", "/api/preferences", { sub: null })),
      prefsPut(call("PUT", "/api/preferences", { sub: null, body: { preferences: prefs, expectedVersion: 0 } })),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Sign in required." });
    }
    expect(store.all()).toHaveLength(0);
  });

  it("rejects a forged token", async () => {
    const req = new Request(`${ORIGIN}/api/trips`, { headers: { cookie: "tg_id=forged", origin: ORIGIN } });
    expect((await tripsGet(req)).status).toBe(401);
  });
});

describe("403 for a foreign Origin on writes", () => {
  const foreign = "https://evil.example.com";

  it("blocks trips, profile and preferences writes and stores nothing", async () => {
    const responses = await Promise.all([
      tripsPost(call("POST", "/api/trips", { origin: foreign, body: trip() })),
      tripsDelete(call("DELETE", "/api/trips", { origin: foreign, body: { tripId: "t_x" } })),
      profilePut(call("PUT", "/api/profile", { origin: foreign, body: { expectedVersion: 0, changes: profile } })),
      profilePost(call("POST", "/api/profile", { origin: foreign, body: { expectedVersion: 0, changes: profile } })),
      prefsPut(call("PUT", "/api/preferences", { origin: foreign, body: { preferences: prefs, expectedVersion: 0 } })),
    ]);
    for (const res of responses) expect(res.status).toBe(403);
    expect(store.all()).toHaveLength(0);
    expect(await store.getProfile(USER_A)).toBeNull();
    expect(await store.getPreferences(USER_A)).toBeNull();
  });

  it("does not block reads", async () => {
    expect((await tripsGet(call("GET", "/api/trips", { origin: foreign }))).status).toBe(200);
    expect((await profileGet(call("GET", "/api/profile", { origin: foreign }))).status).toBe(200);
    expect((await prefsGet(call("GET", "/api/preferences", { origin: foreign }))).status).toBe(200);
  });
});

describe("owner comes only from the verified sub", () => {
  it("ignores body and query owner/userId on trips", async () => {
    const res = await tripsPost(
      call("POST", "/api/trips", {
        body: { ...trip(), owner: "victim", userId: "victim" },
        query: "?owner=victim&userId=victim",
      }),
    );
    expect(res.status).toBe(200);
    const stored = store.all();
    expect(stored).toHaveLength(1);
    expect(stored[0].owner).toBe(USER_A);

    const list = await tripsGet(call("GET", "/api/trips", { query: "?owner=victim&userId=victim" }));
    const data = (await list.json()) as { trips: { owner: string }[] };
    expect(data.trips).toHaveLength(1);
    expect(data.trips[0].owner).toBe(USER_A);

    const asVictim = await tripsGet(call("GET", "/api/trips", { sub: "victim" }));
    expect(((await asVictim.json()) as { trips: unknown[] }).trips).toHaveLength(0);
  });

  it("ignores body and query userId on profile", async () => {
    const res = await profilePut(
      call("PUT", "/api/profile", {
        body: { expectedVersion: 0, changes: profile, userId: "victim", owner: "victim" },
        query: "?userId=victim",
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { profile: { userId: string } }).profile.userId).toBe(USER_A);
    expect(await store.getProfile(USER_A)).not.toBeNull();
    expect(await store.getProfile("victim")).toBeNull();
  });

  it("ignores body and query owner on preferences", async () => {
    const res = await prefsPut(
      call("PUT", "/api/preferences", {
        body: { preferences: prefs, expectedVersion: 0, userId: "victim", owner: "victim" },
        query: "?userId=victim",
      }),
    );
    expect(res.status).toBe(200);
    expect(await store.getPreferences(USER_A)).not.toBeNull();
    expect(await store.getPreferences("victim")).toBeNull();
  });
});

describe("trip deletion is owner scoped", () => {
  it("another user's trip ID deletes nothing and still reports success", async () => {
    const saved = await tripsPost(call("POST", "/api/trips", { sub: USER_B, body: trip("b-draft") }));
    const { id } = (await saved.json()) as { id: string };
    expect(store.all(USER_B)).toHaveLength(1);

    const res = await tripsDelete(call("DELETE", "/api/trips", { sub: USER_A, body: { tripId: id } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true });
    expect(store.all(USER_B)).toHaveLength(1);

    const viaQuery = await tripsDelete(call("DELETE", "/api/trips", { sub: USER_A, query: `?tripId=${id}` }));
    expect(viaQuery.status).toBe(200);
    expect(store.all(USER_B)).toHaveLength(1);

    const own = await tripsDelete(call("DELETE", "/api/trips", { sub: USER_B, body: { tripId: id } }));
    expect(own.status).toBe(200);
    expect(store.all(USER_B)).toHaveLength(0);
  });
});

describe("size, validation and version errors", () => {
  it("413 for a trip payload over 350 KB", async () => {
    const big = { clientDraftId: "big", name: "Big", payload: { blob: "x".repeat(355 * 1024) } };
    const res = await tripsPost(call("POST", "/api/trips", { body: big }));
    expect(res.status).toBe(413);
    expect(store.all()).toHaveLength(0);
  });

  it("413 for a trip body over the request limit", async () => {
    const huge = { clientDraftId: "huge", name: "Huge", payload: { blob: "x".repeat(400 * 1024) } };
    const res = await tripsPost(call("POST", "/api/trips", { body: huge }));
    expect(res.status).toBe(413);
  });

  it("413 for a preferences body over 16 KB", async () => {
    const res = await prefsPut(
      call("PUT", "/api/preferences", {
        body: { preferences: { ...prefs, pad: "x".repeat(20 * 1024) }, expectedVersion: 0 },
      }),
    );
    expect(res.status).toBe(413);
    expect(await store.getPreferences(USER_A)).toBeNull();
  });

  it("400 for invalid preferences", async () => {
    const bodies: unknown[] = [
      { preferences: { ...prefs, pace: "warp" }, expectedVersion: 0 },
      { preferences: { ...prefs, extra: 1 }, expectedVersion: 0 },
      { preferences: { ...prefs, interests: [] }, expectedVersion: 0 },
      { preferences: prefs, expectedVersion: -1 },
      { preferences: "nope", expectedVersion: 0 },
    ];
    for (const body of bodies) {
      const res = await prefsPut(call("PUT", "/api/preferences", { body }));
      expect(res.status).toBe(400);
    }
    expect(await store.getPreferences(USER_A)).toBeNull();
  });

  it("400 for unparsable JSON and invalid trips", async () => {
    expect((await tripsPost(call("POST", "/api/trips", { rawBody: "{not json" }))).status).toBe(400);
    expect((await tripsPost(call("POST", "/api/trips", { body: { name: "x" } }))).status).toBe(400);
  });

  it("409 with currentVersion for a stale preferences version", async () => {
    const first = await prefsPut(call("PUT", "/api/preferences", { body: { preferences: prefs, expectedVersion: 0 } }));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { version: number }).version).toBe(1);

    const stale = await prefsPut(call("PUT", "/api/preferences", { body: { preferences: prefs, expectedVersion: 0 } }));
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentVersion: number }).currentVersion).toBe(1);
  });

  it("409 with currentVersion for a stale profile version", async () => {
    const first = await profilePut(call("PUT", "/api/profile", { body: { expectedVersion: 0, changes: profile } }));
    expect(first.status).toBe(200);

    const stale = await profilePut(
      call("PUT", "/api/profile", { body: { expectedVersion: 0, changes: { displayName: "Other" } } }),
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { currentVersion: number }).currentVersion).toBe(1);

    const ok = await profilePut(
      call("PUT", "/api/profile", { body: { expectedVersion: 1, changes: { displayName: "Other" } } }),
    );
    expect(ok.status).toBe(200);
  });
});

describe("503 when account storage is not configured", () => {
  const expectAll503 = async () => {
    const responses = await Promise.all([
      tripsGet(call("GET", "/api/trips")),
      tripsPost(call("POST", "/api/trips", { body: trip() })),
      tripsDelete(call("DELETE", "/api/trips", { body: { tripId: "t_x" } })),
      profileGet(call("GET", "/api/profile")),
      profilePut(call("PUT", "/api/profile", { body: { expectedVersion: 0, changes: profile } })),
      prefsGet(call("GET", "/api/preferences")),
      prefsPut(call("PUT", "/api/preferences", { body: { preferences: prefs, expectedVersion: 0 } })),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "Account storage is not available." });
      expect(text).not.toContain(TABLE);
      expect(text).not.toContain("arn:");
    }
  };

  it("when the store override is null", async () => {
    setAccountStoreForTests(null);
    await expectAll503();
  });

  it("when the table env vars are unset", async () => {
    resetAccountStoreForTests();
    vi.stubEnv("TRIPGENIE_TRIPS_TABLE", "");
    vi.stubEnv("TRIPGENIE_PROFILES_TABLE", "");
    await expectAll503();
  });
});

describe("error responses do not leak table names or ARNs", () => {
  it("returns a generic 500 when the store throws", async () => {
    const leak = new Error(`AccessDenied on ${ARN} (table ${TABLE})`);
    const broken = new MemoryAccountStore();
    for (const m of ["listTrips", "upsertTrip", "putTripIfAbsent", "listTripKeys", "deleteTrips", "getProfile", "getPreferences"] as const) {
      (broken as unknown as Record<string, unknown>)[m] = async () => {
        throw leak;
      };
    }
    setAccountStoreForTests(broken);

    const responses = await Promise.all([
      tripsGet(call("GET", "/api/trips")),
      tripsPost(call("POST", "/api/trips", { body: trip() })),
      tripsDelete(call("DELETE", "/api/trips", { body: { tripId: "t_x" } })),
      profileGet(call("GET", "/api/profile")),
      prefsGet(call("GET", "/api/preferences")),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain(TABLE);
      expect(text).not.toContain("arn:aws");
      expect(text).not.toContain("AccessDenied");
    }
  });

  it("keeps 4xx bodies free of table names", async () => {
    const res = await prefsPut(call("PUT", "/api/preferences", { body: { preferences: {}, expectedVersion: 0 } }));
    const text = await res.text();
    expect(text).not.toContain(TABLE);
    expect(text).not.toContain("arn:");
  });
});
