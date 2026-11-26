/**
 * Feature: welcome-glass-photos
 * Shuffle/cycle properties, manifest validity, welcome markup and CSS block.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client/account-session", () => ({
  fetchSession: async () => ({ signedIn: false }),
  notifySession: () => {},
}));
vi.mock("@/components/destination-image", () => ({
  useDestinationImage: () => ({ url: null, loading: false, status: "idle", onError: () => {} }),
}));

import AuthLanding from "@/components/auth-landing";
import { WELCOME_PHOTOS, nextCycle, shuffleIds } from "@/lib/welcome-photos";

const RUNS = { numRuns: 100 };
const ROOT = process.cwd();

const uniqueIds = (min: number) =>
  fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), { minLength: min, maxLength: 20 });

/** Deterministic random in [0,1) driven by a list of integers. */
function makeRandom(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq.length ? seq[i++ % seq.length] : 0;
    return (Math.abs(v) % 1000) / 1000;
  };
}
const seqArb = fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 40 });

describe("welcome photo shuffling", () => {
  // Feature: welcome-glass-photos, Property 1: Shuffle is a permutation
  it("Property 1: shuffleIds returns a permutation of the ids", () => {
    // **Validates: Requirements 3.5, 3.6**
    fc.assert(
      fc.property(uniqueIds(0), seqArb, (ids, seq) => {
        const out = shuffleIds(ids, makeRandom(seq));
        expect(out).toHaveLength(ids.length);
        expect([...out].sort()).toEqual([...ids].sort());
      }),
      RUNS,
    );
  });

  // Feature: welcome-glass-photos, Property 2: No repeat within or across cycles
  it("Property 2: nextCycle is a permutation and never starts with the previous id", () => {
    // **Validates: Requirements 3.7**
    fc.assert(
      fc.property(uniqueIds(2), seqArb, fc.nat(), (ids, seq, pick) => {
        const random = makeRandom(seq);
        const last = ids[pick % ids.length];
        const cycle = nextCycle(ids, random, last);
        expect([...cycle].sort()).toEqual([...ids].sort());
        expect(cycle[0]).not.toBe(last);

        let prev = cycle[cycle.length - 1];
        for (let n = 0; n < 4; n++) {
          const next = nextCycle(ids, random, prev);
          expect([...next].sort()).toEqual([...ids].sort());
          expect(next[0]).not.toBe(prev);
          prev = next[next.length - 1];
        }
        for (let i = 1; i < cycle.length; i++) expect(cycle[i]).not.toBe(cycle[i - 1]);
      }),
      RUNS,
    );
  });
});

describe("welcome photo manifest", () => {
  const isHost = (url: string, hosts: string[]) => {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  };

  // Feature: welcome-glass-photos, Property 3: Manifest entries are valid
  it("Property 3: every manifest entry is valid", () => {
    // **Validates: Requirements 3.1, 3.3, 3.4**
    expect(WELCOME_PHOTOS.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.constantFrom(...WELCOME_PHOTOS), (p) => {
        expect(p.src.startsWith("/welcome/")).toBe(true);
        const file = join(ROOT, "public", "welcome", p.src.slice("/welcome/".length));
        expect(existsSync(file)).toBe(true);
        const buf = readFileSync(file);
        const isWebp =
          buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
        const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
        expect(isWebp || isJpeg).toBe(true);
        expect(statSync(file).size).toBeLessThanOrEqual(350 * 1024);
        for (const f of [p.id, p.alt, p.place, p.photographer, p.licence]) expect(f.trim().length).toBeGreaterThan(0);
        expect(isHost(p.sourceUrl, ["pexels.com", "unsplash.com"])).toBe(true);
        expect(isHost(p.photographerUrl, ["pexels.com", "unsplash.com"])).toBe(true);
        expect(["Unsplash License", "Pexels License"]).toContain(p.licence);
      }),
      RUNS,
    );
  });

  it("has unique ids", () => {
    const ids = WELCOME_PHOTOS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("AuthLanding glass photo markup", () => {
  it("renders the scenic hero, a photo layer and the credit line", () => {
    const html = renderToStaticMarkup(
      createElement(AuthLanding, { policy: { enabledProviders: ["email", "google"] } } as never),
    );
    expect(html).toContain("account-cine");
    expect(html).toContain("auth-split--scenic");
    expect(html).toContain("welcome-photo");
    expect(html).toContain("welcome-credit");
  });
});

describe("welcome-glass-photos CSS block", () => {
  it("contains the glass, fallback and reduced-transparency rules", () => {
    const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
    const start = css.indexOf("/* === welcome-glass-photos === */");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = css.slice(start);
    expect(block).toContain("backdrop-filter");
    expect(block).toContain("-webkit-backdrop-filter");
    expect(block).toContain("@supports not");
    expect(block).toContain("prefers-reduced-transparency");
  });
});
