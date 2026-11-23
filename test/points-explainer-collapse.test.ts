// points-explainer-collapse task 3.1: the "How points are calculated" block is a collapsed <details>.
// Rendering approach mirrors test/account-points.test.ts (AccountPoints is not exported).
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  user: null as null | { email: string; name?: string },
  xp: { status: "guest", state: null, error: undefined, retry: () => {}, award: async () => {} } as any,
}));

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    default: actual,
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

const policy = { enabledProviders: [] } as never;

function render(user: null | { email: string }, xp: object): string {
  h.user = user;
  h.xp = { error: undefined, retry: () => {}, award: async () => {}, ...xp };
  return renderToStaticMarkup(createElement(AccountClient, { policy }));
}

function detailsBlock(html: string): { open: string; inner: string } {
  const m = html.match(/<details([^>]*)>([\s\S]*?)<\/details>/);
  expect(m).not.toBeNull();
  return { open: m![1], inner: m![2] };
}

const cases: [string, string][] = [
  ["signed in", render({ email: "a@b.co" }, { status: "ready", state: { total: 30, awarded: ["route_set"] } })],
  ["guest", render(null, { status: "guest", state: null })],
];

describe("points explainer is collapsed by default", () => {
  for (const [name, html] of cases) {
    describe(name, () => {
      it("renders <details class=account-points__how> without the open attribute", () => {
        const { open } = detailsBlock(html);
        expect(open).toContain('class="account-points__how"');
        expect(open).not.toMatch(/\bopen\b/);
      });

      it("has a <summary> with the heading text", () => {
        const { inner } = detailsBlock(html);
        expect(inner).toMatch(/<summary[^>]*class="account-points__summary"[^>]*>How points are calculated<\/summary>/);
      });

      it("keeps both lists and both notes inside the details element", () => {
        const { inner } = detailsBlock(html);
        expect(inner).toContain('aria-label="Points per action"');
        expect(inner).toContain('aria-label="Levels"');
        expect(inner).toContain("Each action counts once per trip or draft.");
        expect(inner).toContain("XP is earned only while signed in.");
      });
    });
  }

  it("globals.css styles .account-points__summary", () => {
    const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
    expect(css).toContain(".account-points__summary");
    expect(css).toContain(".account-points__summary::after");
  });
});
