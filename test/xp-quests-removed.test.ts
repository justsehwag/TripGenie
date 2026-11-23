// chat-dates-xp-fixes task 6.1: Quests absent from the XP panel (Requirements 4.1-4.4).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GamificationPanel from "@/components/gamification-panel";
import { XP_POINTS, awardMany, emptyXp, type XpEvent } from "@/lib/gamification";

const EVENTS = Object.keys(XP_POINTS) as XpEvent[];
const render = (events: XpEvent[], compact: boolean) =>
  renderToStaticMarkup(createElement(GamificationPanel, { state: awardMany(emptyXp(), events), compact }));

describe("Quests are absent from the XP panel", () => {
  it("compact and full views render no <details> and no xp-quests, and keep total, level and progress bar", () => {
    fc.assert(
      fc.property(fc.subarray(EVENTS), fc.boolean(), (events, compact) => {
        const html = render(events, compact);
        const total = events.reduce((n, e) => n + XP_POINTS[e], 0);
        expect(html).not.toContain("<details");
        expect(html).not.toContain("xp-quests");
        expect(html).not.toContain("Quests");
        expect(html).toContain(`${total} XP`);
        expect(html).toContain("Level ");
        expect(html).toContain('role="progressbar"');
      }),
      { numRuns: 100 },
    );
  });

  it("shows the badge list outside any disclosure when a badge is earned, and none otherwise", () => {
    for (const compact of [true, false]) {
      expect(render([], compact)).not.toContain("xp-badges");
      const html = render(EVENTS, compact);
      expect(html).toContain("xp-badges");
      expect(html).not.toContain("<details");
    }
  });
});
