import { describe, expect, it } from "vitest";
import {
  MAX_PER_HOST,
  MAX_SNIPPETS,
  dedupeAndTrim,
  normalizeTitle,
  normalizeUrlForCompare,
} from "@/lib/grounding/bundle";
import type { GroundingSnippet } from "@/lib/grounding/types";

const snip = (n: number, host = `h${n}.com`, extra: Partial<GroundingSnippet> = {}): GroundingSnippet => ({
  title: `Title ${n}`,
  snippet: `Snippet text number ${n} about places`,
  url: `https://${host}/p${n}`,
  host,
  ...extra,
});

describe("normalizeUrlForCompare", () => {
  it("strips scheme, www, fragment, trailing slash and tracking params", () => {
    expect(normalizeUrlForCompare("https://WWW.Example.com/a/?utm_source=x&id=2&fbclid=z&gclid=q#frag")).toBe(
      "example.com/a?id=2",
    );
  });
  it("treats equivalent urls as equal", () => {
    expect(normalizeUrlForCompare("https://example.com/a/")).toBe(normalizeUrlForCompare("https://www.example.com/a"));
  });
});

describe("normalizeTitle", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  Hello   WORLD ")).toBe("hello world");
  });
});

describe("dedupeAndTrim", () => {
  it("drops duplicate urls, keeping the first", () => {
    const a = snip(1);
    const b = { ...snip(2), url: "https://www.h1.com/p1/?utm_x=1" };
    expect(dedupeAndTrim([a, b]).map((s) => s.title)).toEqual(["Title 1"]);
  });
  it("drops duplicate titles", () => {
    const a = snip(1);
    const b = { ...snip(2), title: "  TITLE   1 " };
    expect(dedupeAndTrim([a, b])).toHaveLength(1);
  });
  it("caps per host and overall", () => {
    const sameHost = Array.from({ length: 6 }, (_, i) => snip(i, "a.com"));
    expect(dedupeAndTrim(sameHost)).toHaveLength(MAX_PER_HOST);
    const many = Array.from({ length: 30 }, (_, i) => snip(i));
    expect(dedupeAndTrim(many)).toHaveLength(MAX_SNIPPETS);
  });
  it("trims lengths and strips html", () => {
    const [r] = dedupeAndTrim([snip(1, "a.com", { title: "<b>" + "x".repeat(300) + "</b>", snippet: "y".repeat(500) })]);
    expect(r.title.length).toBeLessThanOrEqual(120);
    expect(r.snippet.length).toBeLessThanOrEqual(240);
    expect(r.title).not.toContain("<");
  });
  it("discards empty fields and bad urls", () => {
    expect(dedupeAndTrim([snip(1, "a.com", { title: "" }), snip(2, "b.com", { url: "nope" })])).toEqual([]);
  });
  it("is idempotent and does not mutate input", () => {
    const input = [
      snip(1, "a.com", { title: "<i>Long</i> " + "z".repeat(200) }),
      snip(2, "a.com"),
      snip(3, "a.com", { url: "https://a.com/p2/" }),
      snip(4, "b.com", { snippet: "q".repeat(400) }),
    ];
    const before = JSON.parse(JSON.stringify(input));
    const once = dedupeAndTrim(input);
    expect(input).toEqual(before);
    expect(dedupeAndTrim(once)).toEqual(once);
    expect(once[0]).not.toBe(input[0]);
  });
});
