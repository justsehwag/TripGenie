/**
 * Spec: welcome-idle-saved-trips, task 6.1.
 * Properties 1-8, markup examples and source checks.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/",
}));
vi.mock("next/link", () => ({
  default: (p: { href: string; className?: string; children?: unknown; [k: string]: unknown }) =>
    createElement("a", { href: p.href, className: p.className, "aria-label": p["aria-label"] }, p.children as never),
}));
vi.mock("@/components/auth-landing", () => ({ default: () => null }));
vi.mock("@/lib/client/account-session", async (orig) => {
  const actual = await orig<typeof import("@/lib/client/account-session")>();
  return {
    ...actual,
    fetchSession: async () => ({ signedIn: false }),
    subscribeSession: () => () => {},
  };
});

import { planHeading } from "@/lib/plan-heading";
import {
  decideWelcome,
  readWelcomeSeen,
  markWelcomeSeen,
  WELCOME_SEEN_KEY,
  GUEST_LIMIT_LINES,
  type WelcomeSession,
} from "@/lib/welcome-gate";
import { selectRecentTrips, RECENT_TRIPS_LIMIT } from "@/lib/recent-trips";
import { clearLocalAccountState, SESSION_KEY, GUEST_HISTORY_KEY } from "@/lib/client/account-session";
import { safeReturnTo } from "@/lib/auth/oauth";
import type { StoredTrip } from "@/lib/trip-retention";
import { RecentTripsView } from "@/components/account-recent-trips";
import { WelcomeGate } from "@/components/welcome-gate";

const RUNS = { numRuns: 100 };
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// ---------- fake storage ----------
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
}
const g = globalThis as { localStorage?: Storage };
const originalLs = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (originalLs) Object.defineProperty(globalThis, "localStorage", originalLs);
  else delete g.localStorage;
});
function setLs(s: Storage | undefined) {
  Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true, writable: true });
}

// ---------- generators ----------
const isoDate = fc
  .date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2099-12-28T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString());
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const tripArb = fc.record({
  tripId: fc.stringMatching(/^[a-z0-9 &?\/#-]{1,12}$/),
  owner: fc.constant("o"),
  clientDraftId: fc.constant("c"),
  name: fc.string({ maxLength: 20 }),
  status: fc.constantFrom("draft", "planned", "booked"),
  payload: fc.oneof(
    fc.constant({} as Record<string, unknown>),
    fc.record({
      destination: fc.option(fc.string({ maxLength: 15 }), { nil: undefined }),
      days: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined }),
      itinerary: fc.option(
        fc.record({ days: fc.array(fc.record({ date: isoDate.map((s) => s.slice(0, 10)) }), { maxLength: 6 }) }),
        { nil: undefined },
      ),
    }) as fc.Arbitrary<Record<string, unknown>>,
  ),
  createdAt: isoDate,
  updatedAt: isoDate,
}) as fc.Arbitrary<StoredTrip>;
const tripsArb = fc.uniqueArray(tripArb, { selector: (t) => t.tripId, maxLength: 15 });

// ---------- Property 1-3 ----------
describe("planHeading", () => {
  it("Property 1: idle heading never claims a build", () => {
    fc.assert(
      fc.property(fc.boolean(), (resultsOnly) => {
        const h = planHeading({ resultsOnly, generating: false, itineraryTitle: null });
        if (!resultsOnly) return true;
        return !h.title.includes("Building") && h.showLead === false && h.eyebrow === null;
      }),
      RUNS,
    );
  });

  it("Property 2: building heading only while generating", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
        (resultsOnly, generating, itineraryTitle) => {
          const h = planHeading({ resultsOnly, generating, itineraryTitle });
          const building = h.title === "Building your trip plan…";
          return building === (resultsOnly && generating && itineraryTitle === null);
        },
      ),
      RUNS,
    );
  });

  it("Property 3: itinerary title wins", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.boolean(), (title, generating) => {
        const h = planHeading({ resultsOnly: true, generating, itineraryTitle: title });
        return h.title === title && h.showLead === true;
      }),
      RUNS,
    );
  });
});

// ---------- Property 4 ----------
describe("decideWelcome", () => {
  it("Property 4: welcome decision table", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<WelcomeSession>("unknown", "signed-in", "guest", "error"),
        (seen, storageOk, session) => {
          const d = decideWelcome({ seen, storageOk, session });
          const fresh = storageOk && !seen;
          if (d.view === "welcome" !== (fresh && session === "guest")) return false;
          if ((d.view === "app" && d.markSeen) !== (fresh && session === "signed-in")) return false;
          if ((!storageOk || seen || session === "error") && !(d.view === "app" && !d.markSeen)) return false;
          if (d.view === "pending" !== (fresh && session === "unknown")) return false;
          return true;
        },
      ),
      RUNS,
    );
  });

  it("readWelcomeSeen / markWelcomeSeen never throw when storage throws", () => {
    const boom = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    setLs(boom);
    expect(readWelcomeSeen()).toEqual({ seen: false, storageOk: false });
    expect(() => markWelcomeSeen()).not.toThrow();
  });

  it("reads and writes the flag", () => {
    setLs(fakeStorage());
    expect(readWelcomeSeen()).toEqual({ seen: false, storageOk: true });
    markWelcomeSeen();
    expect(readWelcomeSeen()).toEqual({ seen: true, storageOk: true });
  });

  it("guest limits copy is honest", () => {
    const text = GUEST_LIMIT_LINES.join(" ");
    expect(text).toMatch(/5/);
    expect(text).toMatch(/20/);
    expect(text).not.toMatch(/confirmed|bookable|guaranteed|100% accurate/i);
  });
});

// ---------- Property 5 ----------
describe("welcome flag and sign-out", () => {
  it("Property 5: welcome flag survives sign-out", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.oneof(
            fc.constantFrom(SESSION_KEY, GUEST_HISTORY_KEY, "tripgenie.cache.trips.v1"),
            fc.stringMatching(/^tripgenie\.(history|trips|profile|cache)\.[a-z]{1,6}$/),
            fc.stringMatching(/^[a-z.]{1,10}$/),
          ),
          fc.string({ maxLength: 8 }),
        ),
        (others) => {
          setLs(fakeStorage({ ...others, [WELCOME_SEEN_KEY]: "1" }));
          clearLocalAccountState();
          return g.localStorage!.getItem(WELCOME_SEEN_KEY) === "1";
        },
      ),
      RUNS,
    );
  });
});

// ---------- Property 6-7 ----------
describe("selectRecentTrips", () => {
  it("Property 6: newest five, in order", () => {
    fc.assert(
      fc.property(tripsArb, (trips) => {
        const rows = selectRecentTrips(trips);
        const byId = new Map(trips.map((t) => [t.tripId, t]));
        if (rows.length !== Math.min(RECENT_TRIPS_LIMIT, trips.length)) return false;
        if (!rows.every((r) => byId.has(r.tripId))) return false;
        const times = rows.map((r) => Date.parse(byId.get(r.tripId)!.updatedAt));
        for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) return false;
        // nothing left out is newer than the last returned row
        const shown = new Set(rows.map((r) => r.tripId));
        const min = times.length ? times[times.length - 1] : 0;
        return trips.every((t) => shown.has(t.tripId) || Date.parse(t.updatedAt) <= min);
      }),
      RUNS,
    );
  });

  it("Property 7: rows are complete and well-formed", () => {
    fc.assert(
      fc.property(tripsArb, (trips) => {
        const byId = new Map(trips.map((t) => [t.tripId, t]));
        return selectRecentTrips(trips, 100).every((r) => {
          const t = byId.get(r.tripId)!;
          if (!r.name || !r.whenLabel) return false;
          if (r.href !== `/plan?trip=${encodeURIComponent(r.tripId)}`) return false;
          const days = ((t.payload.itinerary as { days?: { date: string }[] } | undefined)?.days) ?? [];
          if (days.length > 0) {
            return (
              r.whenLabel.includes(short(days[0].date)) && r.whenLabel.includes(short(days[days.length - 1].date))
            );
          }
          const n = t.payload.days as number | undefined;
          if (typeof n === "number") return r.whenLabel === (n === 1 ? "1 day" : `${n} days`);
          return r.whenLabel.startsWith("Updated ");
        });
      }),
      RUNS,
    );
  });

  it("tolerates malformed trips", () => {
    const bad = [
      { tripId: "a", name: 5, payload: null, updatedAt: "nope" },
      { tripId: "b", payload: { itinerary: { days: [null, { date: 3 }] }, days: -2 } },
    ] as unknown as StoredTrip[];
    const rows = selectRecentTrips(bad);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name && r.whenLabel)).toBe(true);
  });
});

// ---------- Property 8 ----------
describe("safeReturnTo", () => {
  const safePath = fc
    .tuple(
      fc.stringMatching(/^[A-Za-z0-9_-]$/),
      fc.stringMatching(/^[A-Za-z0-9_\-\/.]{0,80}$/),
      fc.option(fc.stringMatching(/^[A-Za-z0-9=&:_-]{0,40}$/), { nil: undefined }),
    )
      .map(([h, rest, q]) => `/${h}${rest}${q === undefined ? "" : `?${q}`}`);

  it("Property 8: safe relative paths are returned unchanged", () => {
    fc.assert(
      fc.property(safePath, (p) => safeReturnTo(p) === p),
      RUNS,
    );
    expect(safeReturnTo("/")).toBe("/");
  });

  it("rejects unsafe values with the default", () => {
    for (const bad of ["//evil.com", "/\\evil", "https://x.com", "/a:b", "", "x"]) {
      expect(safeReturnTo(bad)).toBe("/plan");
    }
  });
});

// ---------- markup ----------
const rows = selectRecentTrips([
  {
    tripId: "t 1",
    owner: "o",
    clientDraftId: "c",
    name: "Goa break",
    status: "planned",
    payload: { destination: "Goa", days: 3 },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  },
]);
const view = (p: Partial<Parameters<typeof RecentTripsView>[0]> = {}) =>
  renderToStaticMarkup(createElement(RecentTripsView, { status: "ready", trips: rows, signedIn: true, ...p }));

describe("RecentTripsView markup", () => {
  it("loading shows a status skeleton", () => {
    const html = view({ status: "loading", trips: [] });
    expect(html).toContain('role="status"');
    expect(html).toContain("skeleton");
  });
  it("empty shows a Plan a trip link", () => {
    const html = view({ trips: [] });
    expect(html).toContain("No saved trips yet");
    expect(html).toContain('href="/plan"');
    expect(html).toContain("Plan a trip");
  });
  it("error shows retry", () => {
    const html = view({ status: "error", trips: [], onRetry: () => {} });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Try again");
  });
  it("unavailable shows storage message", () => {
    const html = view({ status: "unavailable", trips: [] });
    expect(html).toContain("unavailable");
  });
  it("ready lists rows with Open and My Trips links", () => {
    const html = view();
    expect(html).toContain("Goa break");
    expect(html).toContain("Goa");
    expect(html).toContain("3 days");
    expect(html).toContain('href="/plan?trip=t%201"');
    expect(html).toContain("Open");
    expect(html).toContain('href="/trips"');
    expect(html).toContain("See all in My Trips");
  });
  it("guest variant", () => {
    const html = view({ signedIn: false });
    expect(html).toContain("Saved on this device");
    expect(html).toContain("Sign in to keep your trips on your account");
    expect(html).not.toContain("See all in My Trips");
  });
});

describe("WelcomeGate server markup", () => {
  it("keeps children in a hidden div plus a loading status", () => {
    const html = renderToStaticMarkup(
      createElement(WelcomeGate, null, createElement("main", null, "DISCOVER-CONTENT")),
    );
    expect(html).toMatch(/<div hidden(="")?>/);
    expect(html).toContain("DISCOVER-CONTENT");
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading");
  });
});

// ---------- source checks ----------
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(rel);
  }
  return out;
}
const bareLf = (s: string) => /(?<!\r)\n/.test(s);

describe("source checks", () => {
  it("welcome-gate component is imported only by app/page.tsx", () => {
    const importers = [...walk("app"), ...walk("components"), ...walk("lib")].filter((f) =>
      /from\s+["']@\/components\/welcome-gate["']/.test(read(f)),
    );
    expect(importers).toEqual(["app/page.tsx"]);
  });

  it("auth-landing no longer hard-codes /plan for sign-in; My Trips passes /trips", () => {
    const src = read("components/auth-landing.tsx");
    expect(src).not.toMatch(/returnTo=\/plan/);
    expect(src).not.toMatch(/router\.push\(\s*["']\/plan["']\s*\)/);
    expect(src).toMatch(/afterSignInPath\s*=\s*"\/"/);
    expect(read("components/my-trips-client.tsx")).toContain('afterSignInPath="/trips"');
  });

  it("planner uses planHeading, keeps the lead text and is CRLF only", () => {
    const src = read("components/planner.tsx");
    expect(src).toContain("planHeading(");
    expect(src).toContain("no activity is a confirmed booking");
    expect(bareLf(src)).toBe(false);
  });

  it("globals.css has no bare LF and carries the new rules", () => {
    const css = read("app/globals.css");
    expect(bareLf(css)).toBe(false);
    expect(css).toContain(".account-recent");
    expect(css).toContain(".welcome-note");
  });

  it("account client mounts the recent trips for both states", () => {
    const src = read("components/account-client.tsx");
    expect(src).toContain("<AccountRecentTrips signedIn />");
    expect(src).toContain("<AccountRecentTrips signedIn={false} />");
  });
});
