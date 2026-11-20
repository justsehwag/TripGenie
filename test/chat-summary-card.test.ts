// Task 2.5: ChatSummaryCard renders summaryRows in fixed order, tags carried values,
// offers one labelled Edit button per row, and exposes an explicit Generate button.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import ChatSummaryCard, {
  CARRIED_TAG_TEXT,
  GENERATE_LABEL,
  GENERATE_BLOCKED_TEXT,
} from "@/components/chat-summary-card";
import { initialIntakeState, step, summaryRows } from "@/lib/chat-intake";
import { REQUIRED_FIELDS } from "@/lib/preference-controller";
import type { TripContext } from "@/lib/types";

// React 19 hoists <link rel="preload"> tags into the output; remove them before comparing.
const strip = (html: string) => html.replace(/<link[^>]*rel="preload"[^>]*\/?>/g, "");

const noop = () => {};
const render = (ctx: TripContext, kind: "seed" | "answered" = "answered") => {
  let state = initialIntakeState();
  if (kind === "seed") state = step(state, { type: "seed", context: ctx }).state;
  else {
    for (const f of REQUIRED_FIELDS) {
      const value = ctx[f];
      state = step(state, { type: "edit", field: f, value }).state;
    }
  }
  return strip(
    renderToStaticMarkup(createElement(ChatSummaryCard, { rows: summaryRows(state), onEdit: noop, onGenerate: noop })),
  );
};

const FULL: TripContext = {
  origin: "Mumbai",
  destination: "Singapore",
  durationDays: 4,
  travellers: { adults: 2, children: 0 },
  budgetLevel: "mid",
  diet: "vegetarian",
  pace: "relaxed",
  interests: ["food", "museums"],
};

describe("ChatSummaryCard", () => {
  it("lists every required field in the fixed order", () => {
    const html = render(FULL);
    const order = [...html.matchAll(/data-field="([a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([...REQUIRED_FIELDS]);
  });

  it("shows values, and Not answered for unset rows with the default note", () => {
    const html = render({ origin: "Delhi", destination: "Goa" });
    expect(html).toContain("Delhi");
    expect(html).toContain("Goa");
    expect(html).toContain("Not answered");
    expect(html).toContain("Pace defaults to");
  });

  it("tags carried values only, using the earlier-trip wording", () => {
    const carried = render(FULL, "seed");
    expect(carried.split(CARRIED_TAG_TEXT).length - 1).toBe(REQUIRED_FIELDS.length);
    const fresh = render(FULL);
    expect(fresh).not.toContain(CARRIED_TAG_TEXT);
  });

  it("has one labelled Edit button per row", () => {
    const html = render(FULL);
    for (const label of ["From", "To", "Days", "Travellers", "Budget", "Diet", "Pace", "Interests"]) {
      expect(html).toContain(`aria-label="Edit ${label}"`);
    }
    expect((html.match(/>Edit<\/button>/g) ?? []).length).toBe(REQUIRED_FIELDS.length);
  });

  it("uses real buttons (keyboard operable) and a labelled region", () => {
    const html = render(FULL);
    expect((html.match(/<button type="button"/g) ?? []).length).toBe(REQUIRED_FIELDS.length + 1);
    expect(html).toContain('aria-labelledby="chat-summary-title"');
    expect(html).toContain('id="chat-summary-title"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("tabindex");
  });

  it("enables Generate itinerary when origin and destination are set", () => {
    const html = render(FULL);
    const m = html.match(/<button[^>]*chat-summary__generate[^>]*>/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain("disabled");
    expect(html).toContain(GENERATE_LABEL);
    expect(html).not.toContain(GENERATE_BLOCKED_TEXT);
  });

  it("disables Generate itinerary and explains why when the route is incomplete", () => {
    const html = render({ origin: "Delhi" });
    const m = html.match(/<button[^>]*chat-summary__generate[^>]*>/);
    expect(m![0]).toContain('disabled=""');
    expect(m![0]).toContain('aria-describedby="chat-summary-hint"');
    expect(html).toContain('id="chat-summary-hint"');
    expect(html).toContain(GENERATE_BLOCKED_TEXT);
  });

  it("never uses confirmed or bookable wording", () => {
    const html = render(FULL, "seed").toLowerCase();
    expect(html).not.toContain("confirmed");
    expect(html).not.toContain("bookable");
  });

  it("globals.css has the card block and no bare LF", () => {
    const css = readFileSync("app/globals.css");
    let bare = 0;
    for (let i = 0; i < css.length; i++) if (css[i] === 10 && (i === 0 || css[i - 1] !== 13)) bare++;
    expect(bare).toBe(0);
    const text = css.toString("utf8");
    expect(text).toContain(".chat-summary {");
    expect(text).toContain(".chat-summary__generate");
  });
});
