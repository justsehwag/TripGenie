import { describe, expect, it } from "vitest";
import { parseSourceLinks, toSourceLinks } from "@/lib/grounding/sources";
import { MAX_BLOCK_CHARS } from "@/lib/grounding/prompt";
import type { GroundingSnippet } from "@/lib/grounding/types";

const snip = (i: number, over: Partial<GroundingSnippet> = {}): GroundingSnippet => ({
  title: `Title ${i}`,
  snippet: "A reasonably long snippet about a place worth visiting.",
  url: `https://site${i}.example.com/p`,
  host: `site${i}.example.com`,
  ...over,
});

describe("toSourceLinks", () => {
  it("dedupes by URL and sets host from the URL", () => {
    const links = toSourceLinks([snip(1), snip(2, { url: snip(1).url }), snip(3)]);
    expect(links.map((l) => l.url)).toEqual([snip(1).url, snip(3).url]);
    expect(links[0].host).toBe("site1.example.com");
  });

  it("keeps https only", () => {
    const links = toSourceLinks([snip(1, { url: "http://a.example.com/x" }), snip(2)]);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(snip(2).url);
  });

  it("caps at 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => snip(i));
    expect(toSourceLinks(many)).toHaveLength(12);
  });

  it("includes only snippets that fit the block", () => {
    const big = (i: number) => snip(i, { snippet: "x".repeat(240), title: "t".repeat(120) });
    const many = Array.from({ length: 12 }, (_, i) => big(i));
    const links = toSourceLinks({ snippets: many });
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThan(12);
    expect(MAX_BLOCK_CHARS).toBe(4000);
  });

  it("never throws on junk", () => {
    expect(toSourceLinks(undefined)).toEqual([]);
    expect(toSourceLinks({ snippets: null as never })).toEqual([]);
  });
});

describe("parseSourceLinks", () => {
  const ok = { title: "T", url: "https://a.example.com/x", host: "a.example.com" };

  it("accepts valid entries and dedupes", () => {
    expect(parseSourceLinks([ok, ok])).toEqual([ok]);
  });

  it("rejects junk", () => {
    expect(parseSourceLinks(null)).toEqual([]);
    expect(parseSourceLinks("x")).toEqual([]);
    expect(parseSourceLinks({})).toEqual([]);
    expect(
      parseSourceLinks([
        null,
        1,
        { ...ok, title: "" },
        { ...ok, title: 5 },
        { ...ok, url: "http://a.example.com/x" },
        { ...ok, url: "javascript:alert(1)" },
        { ...ok, host: "evil.example.com" },
        { title: "T", url: ok.url },
      ]),
    ).toEqual([]);
  });

  it("caps at 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `T${i}`,
      url: `https://h${i}.example.com/`,
      host: `h${i}.example.com`,
    }));
    expect(parseSourceLinks(many)).toHaveLength(12);
  });
});
