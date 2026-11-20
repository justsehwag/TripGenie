import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as labels from "../lib/itinerary/labels";
import { NOT_CHECKED_TEXT, NOT_CHECKED_UNAVAILABLE_TEXT } from "../lib/itinerary/labels";
import { applyPlan, checkPlan, type PlanContext } from "../lib/itinerary/plan-check";
import { dayLimits } from "../lib/itinerary/pace";
import { initialIntakeState, step, summaryRows } from "../lib/chat-intake";
import { REQUIRED_FIELDS } from "../lib/preference-controller";
import ChatSummaryCard from "../components/chat-summary-card";
import { StopMeta, PriceCellNote } from "../components/itinerary-parts";
import type { DaySpec } from "../lib/itinerary/scheduler";
import type { PlaceCandidate } from "../lib/providers/google-places";
import type { Activity, TripContext } from "../lib/types";

// Feature: chat-images-bedrock-planner, Property 19: Labels are honest
// **Validates: Requirements 10.4, 10.6, 10.7, 12.2**

const NUM_RUNS = 100;
const FORBIDDEN = ["confirmed", "bookable", "guaranteed", "100% accurate"] as const;

/** True when the text holds a forbidden claim in any letter case. */
function claims(s: string): boolean {
  const t = s.toLowerCase();
  return FORBIDDEN.some((w) => t.includes(w));
}

const strip = (html: string) => html.replace(/<link[^>]*rel="preload"[^>]*\/?>/g, "");

/** A forbidden word in a random letter case, with random text around it. */
const adversarial: fc.Arbitrary<string> = fc
  .tuple(
    fc.string({ maxLength: 8 }),
    fc.constantFrom(...FORBIDDEN),
    fc.array(fc.boolean(), { minLength: 14, maxLength: 14 }),
    fc.string({ maxLength: 8 }),
  )
  .map(([pre, word, flips, post]) => {
    const cased = [...word].map((ch, i) => (flips[i] ? ch.toUpperCase() : ch.toLowerCase())).join("");
    return `${pre}${cased}${post}`;
  });

/** Adversarial text or plain text. */
const anyText: fc.Arbitrary<string> = fc.oneof(adversarial, fc.string({ maxLength: 20 }), fc.constantFrom("Old Town", "Quiet walk"));

describe("Property 19: labels are honest", () => {
  it("every string export of labels.ts, including NOT_CHECKED_UNAVAILABLE_TEXT, makes no certainty claim", () => {
    const strings = Object.entries(labels).filter(([, v]) => typeof v === "string") as Array<[string, string]>;
    expect(strings.map(([k]) => k)).toContain("NOT_CHECKED_UNAVAILABLE_TEXT");
    for (const [name, value] of strings) {
      expect(claims(value), `${name} = ${value}`).toBe(false);
    }
    expect(NOT_CHECKED_UNAVAILABLE_TEXT).toBe("Not checked (price lookup unavailable)");
  });

  it("every function export of labels.ts returns clean text for any input", () => {
    fc.assert(
      fc.property(
        anyText,
        fc.oneof(fc.integer({ min: -5, max: 40 }), fc.double({ noNaN: false }), fc.constant(Number.POSITIVE_INFINITY)),
        fc.integer({ min: -5, max: 40 }),
        fc.constantFrom("verifying", "added", "withheld"),
        fc.constantFrom("ai", "estimated", "web", undefined),
        (text, n, m, kind, source) => {
          const outs: string[] = [
            labels.verifiedLinkLabel(text),
            labels.withheldText(n, m),
            labels.retryLabel(n, m),
            labels.failureReason(text),
            labels.progressText(kind as labels.ProgressKind, n, m),
            labels.stopsLabel(n),
            labels.unpricedLabel(n),
            labels.priceBadgeText({ priceSource: source, webDetails: text }),
            labels.priceBadgeText(null),
            labels.travelLabel(n),
            labels.verifiedLabel({ verifiedDays: [1], requestedDays: m } as never),
            labels.activitiesLabel({ verifiedDays: [1], requestedDays: m } as never),
            labels.activitiesLabel(undefined),
          ];
          const notice = labels.dateSpanNotice(n, m);
          if (notice !== null) outs.push(notice);
          for (const o of outs) expect(claims(o), o).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  describe("chat summary card", () => {
    const edit = (field: (typeof REQUIRED_FIELDS)[number], value: unknown, s = initialIntakeState()) =>
      step(s, { type: "edit", field, value: value as never }).state;

    it("markup holds no certainty claim, even when the user's own answers are adversarial", () => {
      fc.assert(
        fc.property(adversarial, adversarial, adversarial, adversarial, (origin, dest, diet, interest) => {
          let s = initialIntakeState();
          s = edit("origin", origin, s);
          s = edit("destination", dest, s);
          s = edit("durationDays", 3, s);
          s = edit("travellers", { adults: 2, children: 1 }, s);
          s = edit("budgetLevel", "mid", s);
          s = edit("diet", diet, s);
          s = edit("pace", "relaxed", s);
          s = edit("interests", [interest], s);
          const html = strip(
            renderToStaticMarkup(
              createElement(ChatSummaryCard, { rows: summaryRows(s), onEdit: () => {}, onGenerate: () => {} }),
            ),
          );
          // Carve-out: the card echoes the traveller's own answers verbatim in the value spans.
          // The honest-labels rule covers app-generated text, not user input, so those spans are
          // excluded. Row labels, tags, the button, hint and notes are still checked.
          const fixedText = html.replace(/<span class="chat-summary__value[^"]*">[\s\S]*?<\/span>/g, "");
          expect(claims(fixedText), fixedText).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("markup of seeded and partial contexts holds no certainty claim", () => {
      fc.assert(
        fc.property(fc.boolean(), fc.boolean(), (seed, full) => {
          const ctx: TripContext = full
            ? { origin: "Delhi", destination: "Goa", durationDays: 3, diet: "vegetarian", interests: ["food"] }
            : { origin: "Delhi" };
          const s = seed ? step(initialIntakeState(), { type: "seed", context: ctx }).state : initialIntakeState();
          const html = strip(
            renderToStaticMarkup(
              createElement(ChatSummaryCard, { rows: summaryRows(s), onEdit: () => {}, onGenerate: () => {} }),
            ),
          );
          expect(claims(html), html).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe("planner-written text after plan-check", () => {
    const OPEN_ALL_DAY = {
      periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
        open: { day: d, hour: 8, minute: 0 },
        close: { day: d, hour: 20, minute: 0 },
      })),
      weekdayDescriptions: ["Monday: 8:00 AM - 8:00 PM"],
    };
    const cand = (id: string, name: string): PlaceCandidate => ({
      placeId: id,
      name,
      address: `${id} Road, Old Town, France`,
      location: { lat: 0.001 * id.charCodeAt(id.length - 1), lng: 0.002 * id.charCodeAt(0) - 0.19 },
      rating: 4,
      userRatingCount: 100,
      hours: OPEN_ALL_DAY,
      utcOffsetMinutes: null,
      types: [],
      primaryType: "tourist_attraction",
      businessStatus: "OPERATIONAL",
      googleMapsUri: null,
      photos: [],
    });
    const SENT = [cand("a1", "Alpha Fort"), cand("a2", "Beta Garden"), cand("b1", "Gamma Museum"), cand("b2", "Delta Bridge")];
    const spec = (n: number): DaySpec => ({ day: n, date: null, weekday: null, limits: dayLimits("balanced", n, 2), earliestMin: 540 });
    const ctx = (): PlanContext => ({
      days: [
        { spec: spec(1), deterministicCount: 2 },
        { spec: spec(2), deterministicCount: 2 },
      ],
      sent: SENT,
      dates: ["2025-01-06", "2025-01-07"],
    });

    // Wrap the adversarial word in plain letters so only the claim word can trip the checker.
    const letters = fc.constantFrom("", "A ", "The ", "Calm ");
    const wrapped = fc.tuple(letters, adversarial.map((s) => s.replace(/[^A-Za-z0-9% ]/g, "")), fc.constantFrom("", " walk", " views"))
      .map(([a, b, c]) => `${a}${b}${c}`.trim())
      .filter((s) => s.length > 0);
    const mixed = fc.oneof(wrapped, fc.constantFrom("Old Town walk", "Quiet morning", "A calm stop nearby"));

    it("accepted titles and sentences never claim certainty, in any letter case", () => {
      fc.assert(
        fc.property(mixed, mixed, fc.array(mixed, { minLength: 4, maxLength: 4 }), (t1, t2, sentences) => {
          const plan = {
            days: [
              { day: 1, startTime: "09:00", title: t1, stops: [{ placeId: "a1", sentence: sentences[0] }, { placeId: "a2", sentence: sentences[1] }] },
              { day: 2, startTime: "09:00", title: t2, stops: [{ placeId: "b1", sentence: sentences[2] }, { placeId: "b2", sentence: sentences[3] }] },
            ],
          };
          const c = ctx();
          const v = checkPlan(c, plan);
          if (!v.ok) return;
          const applied = applyPlan(c, v);
          for (const d of applied.days) {
            expect(claims(d.title), `title: ${d.title}`).toBe(false);
            for (const s of d.stops) expect(claims(s.sentence), `sentence: ${s.sentence}`).toBe(false);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe("StopMeta and PriceCellNote markup", () => {
    const base: Activity = { time: "09:00", title: "Fort", description: "d", cost: 0 };
    const detail = (text: string, host: string) => ({
      text,
      sourceHost: host,
      sourceUrl: "https://example.com/page",
      checkedAt: "2025-01-06T10:00:00.000Z",
    });

    const activity: fc.Arbitrary<Activity> = fc
      .record({
        title: anyText,
        placeName: anyText,
        area: anyText,
        openingHours: anyText,
        hoursLabel: anyText,
        tip: anyText,
        booking: anyText,
        best: anyText,
        host: anyText,
        checked: fc.boolean(),
        unavailable: fc.option(fc.constant(true as const), { nil: undefined }),
        withDetails: fc.boolean(),
        web: fc.boolean(),
      })
      .map((r) => {
        const a: Activity = {
          ...base,
          title: r.title,
          placeName: r.placeName,
          area: r.area,
          openingHours: r.openingHours,
          hoursLabel: r.hoursLabel as never,
          verified: true,
          placeId: "p1",
          mapsUrl: "https://www.google.com/maps/place/?q=place_id:p1",
          travelToNextMin: 12,
        };
        if (r.web) {
          a.priceSource = "web";
          a.sourceHost = r.host;
          a.sourceUrl = "https://example.com/price";
          a.checkedAt = "2025-01-06T10:00:00.000Z";
        }
        const wd: NonNullable<Activity["webDetails"]> = { checked: r.checked };
        if (r.unavailable) wd.unavailable = true;
        if (r.withDetails) {
          wd.tip = detail(r.tip, r.host);
          wd.booking = detail(r.booking, r.host);
          wd.bestTime = detail(r.best, r.host);
        }
        a.webDetails = wd;
        return a;
      });

    it("holds no certainty claim for any activity, with and without unavailable", () => {
      fc.assert(
        fc.property(activity, fc.boolean(), (a, hasNext) => {
          const meta = strip(renderToStaticMarkup(createElement(StopMeta, { a, hasNext })));
          const note = strip(renderToStaticMarkup(createElement(PriceCellNote, { a })));
          expect(claims(meta), meta).toBe(false);
          expect(claims(note), note).toBe(false);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it("shows the unavailable text only for unchecked stops flagged unavailable", () => {
      fc.assert(
        fc.property(fc.boolean(), fc.option(fc.constant(true as const), { nil: undefined }), (checked, unavailable) => {
          const wd: NonNullable<Activity["webDetails"]> = { checked };
          if (unavailable) wd.unavailable = true;
          const a: Activity = { ...base, webDetails: wd };
          const note = strip(renderToStaticMarkup(createElement(PriceCellNote, { a })));
          const meta = strip(renderToStaticMarkup(createElement(StopMeta, { a, hasNext: false })));
          const shows = (html: string) => html.includes(NOT_CHECKED_UNAVAILABLE_TEXT);
          const expected = checked === false && unavailable === true;
          expect(shows(note)).toBe(expected);
          expect(shows(meta)).toBe(expected);
          if (checked === false && !unavailable) {
            expect(note).toContain(NOT_CHECKED_TEXT);
            expect(note).not.toContain("price lookup unavailable");
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
