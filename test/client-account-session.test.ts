import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CACHED_PROFILE_KEY,
  CACHED_TRIPS_KEY,
  GUEST_HISTORY_KEY,
  MIGRATION_FLAG_KEY,
  PREFERENCES_KEY,
  SESSION_KEY,
  fetchSession,
  handleUnauthorized,
  runMigrationV2,
  signOut,
} from "@/lib/client/account-session";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const g = globalThis as unknown as { localStorage?: unknown };
let original: unknown;
let store: MemoryStorage;

beforeEach(() => {
  original = g.localStorage;
  store = new MemoryStorage();
  g.localStorage = store;
});
afterEach(() => {
  g.localStorage = original;
  vi.unstubAllGlobals();
});

function seed() {
  store.setItem(SESSION_KEY, JSON.stringify({ email: "a@b.com" }));
  store.setItem(CACHED_TRIPS_KEY, "[]");
  store.setItem(CACHED_PROFILE_KEY, "{}");
  store.setItem(PREFERENCES_KEY, "{\"x\":1}");
  store.setItem(GUEST_HISTORY_KEY, "[1]");
}

describe("client account-session", () => {
  it("signOut posts the signout action and clears account state but keeps preferences and guest history", async () => {
    seed();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await signOut();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth");
    expect(JSON.parse(String(init.body))).toEqual({ action: "signout" });
    expect(store.getItem(SESSION_KEY)).toBeNull();
    expect(store.getItem(CACHED_TRIPS_KEY)).toBeNull();
    expect(store.getItem(CACHED_PROFILE_KEY)).toBeNull();
    expect(store.getItem(PREFERENCES_KEY)).toBe("{\"x\":1}");
    expect(store.getItem(GUEST_HISTORY_KEY)).toBe("[1]");
  });

  it("signOut still clears local state when the network fails", async () => {
    seed();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    await signOut();
    expect(store.getItem(SESSION_KEY)).toBeNull();
    expect(store.getItem(GUEST_HISTORY_KEY)).toBe("[1]");
  });

  it("handleUnauthorized clears the session but keeps drafts and caches of local data", () => {
    seed();
    handleUnauthorized();
    expect(store.getItem(SESSION_KEY)).toBeNull();
    expect(store.getItem(GUEST_HISTORY_KEY)).toBe("[1]");
    expect(store.getItem(PREFERENCES_KEY)).toBe("{\"x\":1}");
  });

  it("fetchSession caches only the email and name, and reports network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ signedIn: true, user: { email: "a@b.com", name: "A", sub: "x" } }), { status: 200 })));
    const s = await fetchSession();
    expect(s).toEqual({ signedIn: true, user: { email: "a@b.com", name: "A" } });
    expect(JSON.parse(store.getItem(SESSION_KEY)!)).toEqual({ email: "a@b.com", name: "A" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await fetchSession()).toEqual({ signedIn: false, error: true });
  });

  it("runMigrationV2 removes old email-keyed history once and keeps guest history", () => {
    store.setItem("tripgenie.history.a@b.com", "[1]");
    store.setItem(GUEST_HISTORY_KEY, "[2]");
    store.setItem(SESSION_KEY, JSON.stringify({ userId: "a@b.com", email: "a@b.com" }));
    expect(runMigrationV2()).toBe(true);
    expect(store.getItem("tripgenie.history.a@b.com")).toBeNull();
    expect(store.getItem(GUEST_HISTORY_KEY)).toBe("[2]");
    expect(JSON.parse(store.getItem(SESSION_KEY)!)).toEqual({ email: "a@b.com" });
    expect(store.getItem(MIGRATION_FLAG_KEY)).toBe("1");
    store.setItem("tripgenie.history.c@d.com", "[3]");
    expect(runMigrationV2()).toBe(false);
    expect(store.getItem("tripgenie.history.c@d.com")).toBe("[3]");
  });
});
