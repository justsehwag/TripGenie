import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WikiReason } from "@/lib/wiki-image";

/**
 * Task 4.10 (Requirements 4.3, 4.5, 4.6, 4.8, 4.12, 5.6, 12.7). The resolver is
 * stubbed, as in test/wiki-image-integration.test.ts. No live network.
 */

const resolver = vi.hoisted(() => ({
  impl: null as null | ((q: string, deps?: Record<string, unknown>) => Promise<unknown>),
  calls: [] as Array<{ q: string; deps?: Record<string, unknown> }>,
}));
vi.mock("@/lib/wiki-image", async () => {
  const actual = await vi.importActual<typeof import("@/lib/wiki-image")>("@/lib/wiki-image");
  return {
    ...actual,
    resolveWikiImage: (q: string, deps?: Record<string, unknown>) => {
      resolver.calls.push({ q, deps });
      return resolver.impl ? resolver.impl(q, deps) : actual.resolveWikiImage(q, deps as never);
    },
  };
});

const U1 = "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/500px-X.jpg";
const U2 = "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg";
const BAD = "https://evil.example.com/x.jpg";
const PLACE = "/api/place-photo?ref=places/abc/photos/def&w=800";

async function get(qs: string) {
  const { GET } = await import("@/app/api/image/route");
  const res = await GET(new NextRequest(`http://localhost/api/image?${qs}`));
  return { res, body: (await res.json()) as Record<string, unknown> };
}
const base = "kind=destination&query=Goa&slot=0";

beforeEach(() => {
  resolver.calls.length = 0;
  resolver.impl = async () => ({ url: U1 });
});

describe("size parsing", () => {
  it("defaults to card when absent", async () => {
    await get(base);
    expect(resolver.calls[0].deps).toMatchObject({ size: "card", slot: 0, kind: "destination" });
  });

  it.each(["thumb", "card", "hero", "cover"])("passes a valid size %s through", async (size) => {
    await get(`${base}&size=${size}`);
    expect(resolver.calls[0].deps).toMatchObject({ size });
  });

  it.each(["huge", "", "CARD", "__proto__", "constructor"])("falls back to card for %j", async (size) => {
    await get(`${base}&size=${encodeURIComponent(size)}`);
    expect(resolver.calls[0].deps).toMatchObject({ size: "card" });
  });

  it("parses size from a POST body too", async () => {
    const { POST } = await import("@/app/api/image/route");
    const res = await POST(
      new NextRequest("http://localhost/api/image", {
        method: "POST",
        body: JSON.stringify({ kind: "attraction", query: "Taj Mahal", slot: 2, size: "hero" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(resolver.calls[0].deps).toMatchObject({ size: "hero", slot: 2, kind: "attraction" });
  });
});

describe("srcset", () => {
  it("is returned when every URL is allowed", async () => {
    const srcset = `${U1} 1x, ${U2} 2x`;
    resolver.impl = async () => ({ url: U1, srcset });
    const { body } = await get(base);
    expect(body.srcset).toBe(srcset);
    expect(body.url).toBe(U1);
  });

  it("is omitted when any URL is not allowed", async () => {
    resolver.impl = async () => ({ url: U1, srcset: `${U1} 1x, ${BAD} 2x` });
    const { res, body } = await get(base);
    expect(res.status).toBe(200);
    expect(body.url).toBe(U1);
    expect("srcset" in body).toBe(false);
  });

  it("is omitted for an empty or non-string srcset", async () => {
    for (const srcset of ["", 5, null]) {
      resolver.impl = async () => ({ url: U1, srcset });
      const { body } = await get(base);
      expect("srcset" in body).toBe(false);
    }
  });

  it("is omitted when the resolver gives none (1x only)", async () => {
    const { body } = await get(base);
    expect("srcset" in body).toBe(false);
  });
});

describe("place-photo URL from the resolver", () => {
  it("is returned directly for a destination, labelled representative", async () => {
    resolver.impl = async () => ({ url: PLACE });
    const { res, body } = await get(base);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      url: PLACE,
      label: "Representative Goa image",
      representative: true,
      source: "resolved",
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("uses the plain query label and representative false for an attraction", async () => {
    resolver.impl = async () => ({ url: PLACE });
    const { body } = await get("kind=attraction&query=Taj%20Mahal");
    expect(body).toMatchObject({ url: PLACE, label: "Taj Mahal", representative: false, source: "resolved" });
  });

  it("carries an allowed srcset alongside", async () => {
    const srcset = `${PLACE} 1x, /api/place-photo?ref=places/abc/photos/def&w=1200 2x`;
    resolver.impl = async () => ({ url: PLACE, srcset });
    const { body } = await get(base);
    expect(body.srcset).toBe(srcset);
  });

  it("rejects a malformed place-photo URL with rejected-url", async () => {
    resolver.impl = async () => ({ url: "/api/place-photo?ref=evil&w=800" });
    const { body } = await get(base);
    expect(body).toMatchObject({ url: null, reason: "rejected-url" });
  });

  it("rejects a non-allowlisted host", async () => {
    resolver.impl = async () => ({ url: BAD });
    const { body } = await get(base);
    expect(body).toMatchObject({ url: null, reason: "rejected-url" });
  });
});

describe("cache headers per reason", () => {
  const TRANSIENT: WikiReason[] = ["timeout", "rate-limited", "upstream-error"];
  const LONG: WikiReason[] = ["no-page", "no-thumbnail", "rejected-url"];

  it.each(TRANSIENT)("%s is no-store", async (reason) => {
    resolver.impl = async () => ({ url: null, reason });
    const { res, body } = await get(base);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ url: null, reason });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each(LONG)("%s is cached for a day", async (reason) => {
    resolver.impl = async () => ({ url: null, reason });
    const { res, body } = await get(base);
    expect(body.reason).toBe(reason);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("no-representative-image is cached for one hour", async () => {
    resolver.impl = async () => ({ url: null, reason: "no-representative-image" });
    const { res, body } = await get(base);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      url: null,
      label: "Goa",
      representative: false,
      source: "none",
      reason: "no-representative-image",
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("a resolved image is cached for a day", async () => {
    const { res } = await get(base);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

describe("backward-compatible response shape", () => {
  it("keeps url, label, representative, source and no extra keys without srcset", async () => {
    const { res, body } = await get(base);
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["label", "representative", "source", "url"]);
    expect(body.url).toBe(U1);
    expect(body.source).toBe("resolved");
    expect(typeof body.label).toBe("string");
    expect(typeof body.representative).toBe("boolean");
  });

  it("a provider candidate url still bypasses the resolver", async () => {
    const { body } = await get(`${base}&url=${encodeURIComponent(U1)}`);
    expect(resolver.calls).toHaveLength(0);
    expect(body).toMatchObject({ url: U1, source: "resolved" });
  });

  it("a rejected candidate url yields url null, never a bundled photo", async () => {
    const { body } = await get(`${base}&url=${encodeURIComponent(BAD)}`);
    expect(body).toMatchObject({ url: null, source: "none", reason: "rejected-url" });
  });

  it("answers 400 for a missing kind or query", async () => {
    expect((await get("query=Goa")).res.status).toBe(400);
    expect((await get("kind=hotel")).res.status).toBe(400);
  });
});
