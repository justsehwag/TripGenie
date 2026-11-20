import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PREFERENCES_VERSION_KEY,
  pullPreferences,
  saveAndSyncPreferences,
} from "@/lib/client/preferences-sync";
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, type TravelPreferences } from "@/lib/preferences";
import { getSyncStatus, setSyncIdle } from "@/lib/client/use-sync-status";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

let store: MemoryStorage;
const custom: TravelPreferences = { ...DEFAULT_PREFERENCES, pace: "relaxed", travellers: 4 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: store });
  vi.stubGlobal("localStorage", store);
  setSyncIdle();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preferences sync (requirements 6.1-6.5)", () => {
  it("applies server preferences in place of local ones", async () => {
    store.setItem(PREFERENCES_KEY, JSON.stringify(custom));
    const server = { ...DEFAULT_PREFERENCES, diet: "vegetarian" };
    vi.stubGlobal("fetch", vi.fn(async () => json({ preferences: server, version: 3 })));
    const r = await pullPreferences();
    expect(r.kind).toBe("applied");
    expect(JSON.parse(store.getItem(PREFERENCES_KEY)!).diet).toBe(server.diet);
    expect(store.getItem(PREFERENCES_VERSION_KEY)).toBe("3");
  });

  it("uploads local preferences once with expectedVersion 0 when the server has none", async () => {
    store.setItem(PREFERENCES_KEY, JSON.stringify(custom));
    const calls: { method: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      calls.push({ method: init.method!, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return init.method === "GET" ? json({ preferences: null, version: 0 }) : json({ version: 1 });
    }));
    const r = await pullPreferences();
    expect(r).toEqual({ kind: "uploaded", version: 1 });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect((puts[0].body as { expectedVersion: number }).expectedVersion).toBe(0);
    expect(store.getItem(PREFERENCES_VERSION_KEY)).toBe("1");
  });

  it("does not upload defaults when the server has none", async () => {
    const f = vi.fn(async () => json({ preferences: null, version: 0 }));
    vi.stubGlobal("fetch", f);
    expect((await pullPreferences()).kind).toBe("unchanged");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries once on 409 with currentVersion and reports saved", async () => {
    store.setItem(PREFERENCES_VERSION_KEY, "1");
    const sent: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const v = JSON.parse(String(init.body)).expectedVersion as number;
      sent.push(v);
      return v === 1 ? json({ currentVersion: 4 }, 409) : json({ version: 5 });
    }));
    const r = await saveAndSyncPreferences(custom);
    expect(r).toEqual({ ok: true, version: 5 });
    expect(sent).toEqual([1, 4]);
    expect(getSyncStatus().state).toBe("saved");
  });

  it("on failure keeps local values and shows failed with a retry control", async () => {
    store.setItem(PREFERENCES_KEY, JSON.stringify(custom));
    const f = vi.fn(async () => json({ error: "x" }, 500));
    vi.stubGlobal("fetch", f);
    const r = await saveAndSyncPreferences(custom);
    expect(r.ok).toBe(false);
    const s = getSyncStatus();
    expect(s.state).toBe("failed");
    expect(s.state === "failed" && typeof s.retry).toBe("function");
    expect(JSON.parse(store.getItem(PREFERENCES_KEY)!).travellers).toBe(4);

    f.mockImplementation(async () => json({ version: 1 }));
    if (s.state === "failed") s.retry!();
    await vi.waitFor(() => expect(getSyncStatus().state).toBe("saved"));
  });
});
