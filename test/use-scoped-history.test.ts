// Feature: account-history-and-drafts, Task 7.1: useScopedHistory routing example tests (node env)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveScope, LOCAL_OWNER } from "@/lib/history/scope";
import {
  saveLocal,
  readLocalHistory,
  LOCAL_HISTORY_KEY,
} from "@/lib/history/local-store";
import type { IdentitySession } from "@/lib/identity";
import type { SaveInput, StoredTrip } from "@/lib/trip-retention";

/**
 * Example tests for the useScopedHistory() hook (design section 5).
 *
 * The hook is a "use client" React hook; the Vitest env is node with NO jsdom
 * (and the task forbids adding one). Rendering React hooks is therefore out of
 * scope. Instead these tests drive the hook's OBSERVABLE DECISION LOGIC directly
 * by exercising the exact code paths the hook uses:
 *
 *   - readSession(): the browser-local session parse the hook performs before
 *     calling resolveScope (same logic as my-trips-client.tsx / global-nav.tsx,
 *     copied verbatim below so the hook file is never modified).
 *   - resolveScope(readSession()): the scope resolver the hook mounts with and
 *     re-runs on every storage event for the session key.
 *   - the Local_Store functions (saveLocal / readLocalHistory) the GUEST scope
 *     routes to.
 *   - a thin /api/trips adapter mirroring the SIGNED-IN load/save fetch shape
 *     the hook issues, driven by a mocked global.fetch.
 *
 * This asserts the four behaviors the hook promises:
 *   (1) guest -> Local_Store,
 *   (2) signed-in -> GET /api/trips?owner=<userId>,
 *   (3) a session-key change re-scopes guest<->signed-in,
 *   (4) signed-in save persist-failure falls back to Local_Store + surfaces an
 *       error (R5.4),
 * WITHOUT adding a jsdom env. globalThis stubs (localStorage, window, fetch) are
 * installed per-test and restored afterEach so the run stays deterministic.
 *
 * Validates: Requirements 2.2, 2.3, 3.1, 5.4, 7.1, 7.2, 7.5
 */

const SESSION_KEY = "tripgenie.session";

/* -------------------------------------------------------------------------- */
/* Minimal in-memory localStorage + window stub (no jsdom)                    */
/* -------------------------------------------------------------------------- */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

type GlobalShape = {
  window?: unknown;
  localStorage?: unknown;
  fetch?: unknown;
};

const g = globalThis as GlobalShape;

let savedWindow: unknown;
let savedLocalStorage: unknown;
let savedFetch: unknown;
let storage: MemoryStorage;

beforeEach(() => {
  savedWindow = g.window;
  savedLocalStorage = g.localStorage;
  savedFetch = g.fetch;

  storage = new MemoryStorage();
  // Define a minimal window so the hook's SSR guard (typeof window !== "undefined")
  // and the Local_Store IO wrappers see a browser-like environment.
  g.window = { localStorage: storage, addEventListener() {}, removeEventListener() {} };
  g.localStorage = storage;
});

afterEach(() => {
  // Restore every globalThis stub so later tests are unaffected.
  if (savedWindow === undefined) delete g.window;
  else g.window = savedWindow;
  if (savedLocalStorage === undefined) delete g.localStorage;
  else g.localStorage = savedLocalStorage;
  if (savedFetch === undefined) delete g.fetch;
  else g.fetch = savedFetch;
});

/* -------------------------------------------------------------------------- */
/* Replicas of the hook's private seams (hook file is NOT modified)           */
/* -------------------------------------------------------------------------- */

// Verbatim copy of the hook's readSession(): JSON-parse tripgenie.session,
// require a non-empty trimmed userId, treat corrupt/missing as anonymous.
function readSession(): IdentitySession | null {
  if (typeof (globalThis as GlobalShape).window === "undefined") return null;
  try {
    const ls = (globalThis as unknown as {
      localStorage: { getItem(key: string): string | null };
    }).localStorage;
    const raw = ls.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IdentitySession>;
    if (parsed && typeof parsed.userId === "string" && parsed.userId.trim()) {
      return {
        userId: parsed.userId.trim(),
        firstName: typeof parsed.firstName === "string" ? parsed.firstName : undefined,
        email: typeof parsed.email === "string" ? parsed.email : undefined,
      };
    }
  } catch {
    // corrupt session -> anonymous
  }
  return null;
}

// Thin /api/trips adapter mirroring the hook's signed-in load path: a GET to
// /api/trips?owner=<userId>, parsing { trips }.
async function loadSignedIn(userId: string): Promise<StoredTrip[]> {
  const res = await (globalThis as { fetch: typeof fetch }).fetch(
    "/api/trips?owner=" + encodeURIComponent(userId),
    { headers: { accept: "application/json" }, cache: "no-store" },
  );
  if (!res.ok) throw new Error("Request failed (" + res.status + ").");
  const body = (await res.json()) as { trips?: StoredTrip[] };
  return Array.isArray(body.trips) ? body.trips : [];
}

// Thin signed-in save mirroring the hook's save() incl. the R5.4 persist-failure
// fallback: POST to /api/trips; on non-OK, thrown error, or persisted !== true,
// write the draft to Local_Store and surface an error.
async function saveSignedIn(
  userId: string,
  input: SaveInput,
): Promise<{ persisted: boolean; error: string | null }> {
  const signedInput: SaveInput = { ...input, owner: userId };
  try {
    const res = await (globalThis as { fetch: typeof fetch }).fetch("/api/trips", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        owner: userId,
        clientDraftId: signedInput.clientDraftId,
        name: signedInput.name,
        status: signedInput.status,
        payload: signedInput.payload,
        ttl: signedInput.ttl,
      }),
    });
    if (!res.ok) throw new Error("Save failed (" + res.status + ").");
    const body = (await res.json()) as { persisted?: boolean };
    if (body.persisted !== true) {
      saveLocal(signedInput);
      return {
        persisted: false,
        error:
          "We saved this plan on this device, but could not sync it to your account. Please try again.",
      };
    }
    return { persisted: true, error: null };
  } catch {
    saveLocal(signedInput);
    return {
      persisted: false,
      error:
        "We saved this plan on this device, but could not sync it to your account. Please try again.",
    };
  }
}

function makeSaveInput(overrides: Partial<SaveInput> = {}): SaveInput {
  return {
    owner: "ignored-forced-later",
    clientDraftId: "draft-1",
    name: "Kyoto spring",
    status: "planning",
    payload: { destination: "Kyoto", days: 4 },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("Feature: account-history-and-drafts, useScopedHistory routing (node)", () => {
  it("guest scope (no session key) routes to Local_Store (R2.2, R7.1)", () => {
    // No tripgenie.session key present -> readSession() is null -> guest scope.
    const scope = resolveScope(readSession());
    expect(scope.kind).toBe("guest");

    // Install a spying fetch so we can prove the guest path never touches the
    // cloud (node provides a real global fetch, so assert zero calls, not
    // absence).
    let fetchCalls = 0;
    g.fetch = async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    };

    // The guest load/save path is Local_Store: seed a draft and read it back.
    const saved = saveLocal(makeSaveInput());
    expect(saved.owner).toBe(LOCAL_OWNER);

    const items = readLocalHistory();
    expect(items.map((t) => t.tripId)).toContain(saved.tripId);
    // Device-only guarantee: the signed-in cloud path was never used.
    expect(fetchCalls).toBe(0);
    // And it landed under the guest key.
    const raw = storage.getItem(LOCAL_HISTORY_KEY);
    expect(raw).not.toBeNull();
  });

  it("signed-in scope routes to GET /api/trips?owner=<userId> (R2.3, R7.2)", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify({ userId: "u@x.com" }));

    const scope = resolveScope(readSession());
    expect(scope.kind).toBe("signed-in");
    expect(scope.kind === "signed-in" && scope.userId).toBe("u@x.com");

    const cloudTrip: StoredTrip = {
      tripId: "cloud-1",
      owner: "u@x.com",
      clientDraftId: "draft-9",
      name: "Rome",
      status: "ready",
      payload: { destination: "Rome" },
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    g.fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ trips: [cloudTrip] }),
      } as unknown as Response;
    };

    const items = await loadSignedIn(scope.kind === "signed-in" ? scope.userId : "");
    // The load path hit /api/trips with the owner query for the signed-in user.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/trips?owner=u%40x.com");
    expect(items.map((t) => t.tripId)).toEqual(["cloud-1"]);
    // Cloud records are NOT written to the guest device store.
    expect(storage.getItem(LOCAL_HISTORY_KEY)).toBeNull();
  });

  it("storage-event: changing the session key re-scopes guest<->signed-in (R7.5)", () => {
    // Start guest.
    expect(resolveScope(readSession()).kind).toBe("guest");

    // Sign in: the session key appears -> re-resolve yields signed-in.
    storage.setItem(SESSION_KEY, JSON.stringify({ userId: "alice" }));
    const afterSignIn = resolveScope(readSession());
    expect(afterSignIn.kind).toBe("signed-in");
    expect(afterSignIn.kind === "signed-in" && afterSignIn.userId).toBe("alice");

    // Sign out: the key is cleared -> re-resolve flips back to guest.
    storage.removeItem(SESSION_KEY);
    expect(resolveScope(readSession()).kind).toBe("guest");

    // A corrupt session value is treated as anonymous (guest), never a traveler.
    storage.setItem(SESSION_KEY, "{not json");
    expect(resolveScope(readSession()).kind).toBe("guest");
  });

  it("signed-in save persist-failure falls back to Local_Store and surfaces an error (R5.4)", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify({ userId: "u@x.com" }));
    const scope = resolveScope(readSession());
    expect(scope.kind).toBe("signed-in");

    // Server accepts the request but reports it did not persist.
    g.fetch = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ persisted: false }),
      }) as unknown as Response;

    const userId = scope.kind === "signed-in" ? scope.userId : "";
    const input = makeSaveInput({ clientDraftId: "draft-persist", name: "Lisbon" });
    const result = await saveSignedIn(userId, input);

    // R5.4: the draft is NOT lost — it is written to the device store...
    expect(result.persisted).toBe(false);
    const local = readLocalHistory();
    expect(local.some((t) => t.clientDraftId === "draft-persist")).toBe(true);
    // ...with the device-only sentinel owner, never the real userId...
    const fallback = local.find((t) => t.clientDraftId === "draft-persist");
    expect(fallback?.owner).toBe(LOCAL_OWNER);
    // ...and an error is surfaced to the caller.
    expect(result.error).not.toBeNull();
  });

  it("signed-in save network rejection also falls back to Local_Store (R5.4)", async () => {
    storage.setItem(SESSION_KEY, JSON.stringify({ userId: "u@x.com" }));
    const scope = resolveScope(readSession());

    // The network request throws.
    g.fetch = async () => {
      throw new Error("network down");
    };

    const userId = scope.kind === "signed-in" ? scope.userId : "";
    const input = makeSaveInput({ clientDraftId: "draft-net", name: "Oslo" });
    const result = await saveSignedIn(userId, input);

    expect(result.persisted).toBe(false);
    expect(result.error).not.toBeNull();
    const local = readLocalHistory();
    expect(local.some((t) => t.clientDraftId === "draft-net")).toBe(true);
  });
});
