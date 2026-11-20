import { describe, expect, it } from "vitest";
import { createGroundingCache, groundingCacheKey } from "@/lib/grounding/cache";
import { createProviderStore } from "@/lib/providers/provider-store";
import type { GroundingBundle, GroundingStatus } from "@/lib/grounding/types";

const bundle = (status: GroundingStatus): GroundingBundle => ({
  status,
  snippets: [],
  droppedCount: 0,
});
const T0 = 1_700_000_000_000;

describe("grounding cache", () => {
  it("keeps ok/partial for 24 h", () => {
    for (const st of ["ok", "partial"] as const) {
      const c = createGroundingCache();
      c.set("k", bundle(st), T0);
      expect(c.get("k", T0 + 86_399_000)?.status).toBe(st);
      expect(c.get("k", T0 + 86_401_000)).toBeNull();
    }
  });

  it("keeps empty for 15 min", () => {
    const c = createGroundingCache();
    c.set("k", bundle("empty"), T0);
    expect(c.get("k", T0 + 899_000)?.status).toBe("empty");
    expect(c.get("k", T0 + 901_000)).toBeNull();
  });

  it("never stores unavailable or disabled", () => {
    const c = createGroundingCache();
    c.set("a", bundle("unavailable"), T0);
    c.set("b", bundle("disabled"), T0);
    expect(c.get("a", T0)).toBeNull();
    expect(c.get("b", T0)).toBeNull();
  });

  it("tolerates store failures", () => {
    const store = createProviderStore(10);
    store.get = () => {
      throw new Error("boom");
    };
    store.set = () => {
      throw new Error("boom");
    };
    const c = createGroundingCache(store);
    expect(() => c.set("k", bundle("ok"), T0)).not.toThrow();
    expect(c.get("k", T0)).toBeNull();
  });

  it("normalises key case, whitespace and controls", () => {
    expect(groundingCacheKey("  GOA ", "Beach  Party")).toBe(groundingCacheKey("goa", "beach party"));
    expect(groundingCacheKey("goa\u0000", "x")).toBe(groundingCacheKey("goa", "x"));
    expect(groundingCacheKey("goa", "a")).not.toBe(groundingCacheKey("goa", "b"));
  });

  it("shares one in-flight promise per key", async () => {
    const c = createGroundingCache();
    let calls = 0;
    const producer = async () => {
      calls++;
      return bundle("ok");
    };
    const [a, b] = await Promise.all([c.dedupe("k", producer), c.dedupe("k", producer)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });
});
