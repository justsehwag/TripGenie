import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { confirmOnce, type IdempotencyStore } from "@/lib/booking-store";

/** Feature: tripgenie - booking edge idempotency (at-most-once order). */

class MemIdemp implements IdempotencyStore {
  map = new Map<string, string>();
  puts: number = 0;
  async putIfAbsent(key: string, orderId: string) {
    if (this.map.has(key)) return false;
    this.map.set(key, orderId);
    this.puts += 1;
    return true;
  }
  async get(key: string) { return this.map.get(key) ?? null; }
}

describe("Feature: tripgenie, booking edge idempotency", () => {
  it("first confirm wins and is not deduped", async () => {
    const store = new MemIdemp();
    let n = 0;
    const out = await confirmOnce(store, "k-1", () => `ord-${++n}`);
    expect(out.deduped).toBe(false);
    expect(out.orderId).toBe("ord-1");
    expect(store.puts).toBe(1);
  });

  it("duplicate confirms place at most one order", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 20 }), fc.string(), async (dups, key) => {
      const store = new MemIdemp();
      let n = 0;
      const mkId = () => `ord-${++n}`;
      const out: { orderId: string; deduped: boolean }[] = [];
      for (let i = 0; i < dups; i++) out.push(await confirmOnce(store, key, mkId));
      expect(store.puts).toBe(1);
      expect(out[0].deduped).toBe(false);
      for (let i = 1; i < out.length; i++) expect(out[i].deduped).toBe(true);
      const first = out[0].orderId;
      for (const o of out) expect(o.orderId).toBe(first);
    }), { numRuns: 100 });
  });

  it("distinct keys each place their own order", async () => {
    const store = new MemIdemp();
    let n = 0;
    const mkId = () => `ord-${++n}`;
    const a = await confirmOnce(store, "k-a", mkId);
    const b = await confirmOnce(store, "k-b", mkId);
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(a.orderId).not.toBe(b.orderId);
    expect(store.puts).toBe(2);
  });
});
