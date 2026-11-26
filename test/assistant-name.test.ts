import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { buildSiteSystemPrompt } from "@/lib/site-assistant/prompt";
import { PAGE_IDS } from "@/lib/site-assistant/types";

/** Removes block comments and whole-line / trailing line comments (not URLs like http://). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

function readSource(rel: string): string {
  return stripComments(readFileSync(join(process.cwd(), rel), "utf8"));
}

describe("assistant name: Trip Saathi", () => {
  describe("Property 1: site prompt uses the new name for every page", () => {
    for (const page of PAGE_IDS) {
      it(`page "${page}"`, () => {
        const prompt = buildSiteSystemPrompt(page);
        expect(prompt).toContain("Trip Saathi");
        expect(prompt).not.toContain("TripGenie");
      });
    }
  });

  describe("Property 2: trip prompt uses the new name", () => {
    it("lib/assistant system prompt", () => {
      const prompt = buildSystemPrompt({ itinerary: null } as unknown as Parameters<typeof buildSystemPrompt>[0]);
      expect(prompt).toContain("You are Trip Saathi, the trip assistant");
      expect(prompt).not.toContain("TripGenie");
    });
  });

  describe("user-facing strings in components", () => {
    it("site-assistant.tsx has the new labels and no TripGenie", () => {
      const src = readSource("components/site-assistant.tsx");
      for (const s of ["Ask Trip Saathi", "Message Trip Saathi", "Open Trip Saathi", "Close Trip Saathi"]) {
        expect(src).toContain(s);
      }
      const rest = src.replace(/tripgenie\.assistant\./gi, "");
      expect(rest).not.toMatch(/TripGenie/);
    });

    it("trip-assistant.tsx has the new name and no TripGenie or old labels", () => {
      const src = readSource("components/trip-assistant.tsx");
      expect(src).toContain("Trip Saathi");
      const rest = src.replace(/tripgenie\.assistant\./gi, "");
      expect(rest).not.toMatch(/TripGenie/);
      expect(src).not.toContain("Message the trip assistant");
      expect(src).not.toContain("Collapse trip assistant");
    });
  });
});
