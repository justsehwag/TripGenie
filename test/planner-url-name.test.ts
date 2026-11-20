import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// URL_NAME_RE is module-private, so it is read from source and rebuilt here.
const src = readFileSync(join(__dirname, "..", "lib", "itinerary", "planner.ts"), "utf8");
const m = src.match(/const URL_NAME_RE = (\/.+\/[a-z]*);/);
const re = (() => {
  const lit = m![1];
  const i = lit.lastIndexOf("/");
  return new RegExp(lit.slice(1, i), lit.slice(i + 1));
})();

describe("URL_NAME_RE", () => {
  it.each([
    "St. Paul's Cathedral",
    "Dr. Bhau Daji Lad Museum",
    "Mt. Abu",
    "No. 1 Beach",
  ])("accepts place name %s", (name) => {
    expect(re.test(name)).toBe(false);
  });

  it.each([
    "Visit tours.example.net now",
    "a.b.co.uk",
    "tickets.example.com/buy",
    "www.example",
    "https://example.com/x",
    "http://foo",
  ])("rejects URL-like name %s", (name) => {
    expect(re.test(name)).toBe(true);
  });
});
