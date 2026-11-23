// chat-dates-xp-fixes task 6.1: Property 10 (displayed points equal scoring) for the Account page.
// AccountPoints is not exported, so AccountClient is server-rendered with the first useState
// (the session user) pinned and every data hook mocked. Node environment, no jsdom.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  user: null as null | { email: string; name?: string },
  xp: { status: "guest", state: null, error: undefined, retry: () => {}, award: async () => {} } as any,
}));

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    default: actual,
    // The session user is the only useState initialised with undefined in AccountClient.
    useState: (init?: unknown) => (init === undefined ? [h.user, () => {}] : actual.useState(init as never)),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/" }));
vi.mock("@/components/auth-landing", () => ({ default: () => null }));
vi.mock("@/components/account-hero", () => ({ AccountHero: () => null }));
vi.mock("@/lib/client/use-sync-status", () => ({ useSyncStatus: () => ({ state: "idle" }) }));
vi.mock("@/lib/client/account-session", () => ({
  fetchSession: async () => ({ signedIn: false }),
  signOut: async () => {},
  subscribeSession: () => () => {},
}));
vi.mock("@/lib/client/use-account-xp", () => ({ useAccountXp: () => h.xp }));

import AccountClient from "@/components/account-client";
import { XP_POINTS, LEVEL_BANDS, levelFor, type XpEvent } from "@/lib/gamification";
import { XP_EVENT_LABELS } from "@/lib/account/xp-labels";

const EVENTS = Object.keys(XP_POINTS) as XpEvent[];
const policy = { enabledProviders: [] } as never;
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function render(user: null | { email: string }, xp: object): string {
  h.user = user;
  h.xp = { error: undefined, retry: () => {}, award: async () => {}, ...xp };
  return renderToStaticMarkup(createElement(AccountClient, { policy }));
}

function expectHowCalculated(t: string) {
  expect(t).toContain("How points are calculated");
  for (const e of EVENTS) expect(t).toContain(`${XP_EVENT_LABELS[e]} +${XP_POINTS[e]} XP`);
  for (const b of LEVEL_BANDS) expect(t).toContain(`Level ${b.level}: ${b.name} ${b.min} XP`);
  expect(t.toLowerCase()).toContain("each action counts once per trip or draft");
  expect(t.toLowerCase()).toContain("xp is earned only while signed in");
}

describe("Property 10: displayed points equal scoring", () => {
  it("signed in: total, level, remaining XP, awarded events and the how-to section match lib/gamification", () => {
    fc.assert(
      fc.property(fc.subarray(EVENTS), (awarded) => {
        const total = awarded.reduce((n, e) => n + XP_POINTS[e], 0);
        const t = text(render({ email: "a@b.co" }, { status: "ready", state: { total, awarded } }));
        const lvl = levelFor(total);
        expect(t).toContain(`${total} XP · Level ${lvl.level}: ${lvl.name}`);
        expect(t).toContain(lvl.nextAt === null ? "You have reached the top level." : `${lvl.toNext} XP to the next level.`);
        const earned = t.split("How points are calculated")[0];
        for (const e of awarded) expect(earned).toContain(`${XP_EVENT_LABELS[e]} +${XP_POINTS[e]} XP`);
        if (awarded.length === 0) expect(earned).toContain("No XP earned yet");
        expectHowCalculated(t);
      }),
      { numRuns: 100 },
    );
  });

  it("signed in: renders a progress bar", () => {
    const html = render({ email: "a@b.co" }, { status: "ready", state: { total: 30, awarded: ["route_set"] } });
    expect(html).toContain('aria-label="Progress to the next level"');
  });

  it("guest: shows 'Sign in to earn XP' and the how-to section, and no XP total", () => {
    const html = render(null, { status: "guest", state: null });
    const t = text(html);
    expect(t).toContain("Sign in to earn XP");
    expect(html).not.toContain("account-points__total");
    expectHowCalculated(t);
  });

  it("failed fetch: shows an error with Retry and no zero total", () => {
    const html = render({ email: "a@b.co" }, { status: "error", state: null, error: "Couldn't load your XP. Please try again." });
    const t = text(html);
    expect(t).toContain("Couldn't load your XP");
    expect(t).toContain("Retry");
    expect(html).not.toContain("account-points__total");
    expect(t).not.toContain("0 XP · Level");
    expectHowCalculated(t);
  });
});
