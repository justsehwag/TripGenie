// Static source check: concierge-home `submit` forwards routeOnly into the intake `text` event.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "components", "concierge-home.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("concierge-home routeOnly wiring", () => {
  it("reads routeOnly from the extract response", () => {
    expect(src).toContain("routeOnly?: boolean");
    expect(src).toContain("routeOnly = data.routeOnly === true");
  });

  it("computes routeOnly from groundExtraction on the local fallback path", () => {
    expect(src).toContain("routeOnly = g.routeOnly");
  });

  it("passes routeOnly into the text event given to step", () => {
    expect(src).toMatch(/applyIntakeEvent\(\{ type: "text", text: answer, extracted: fields, routeOnly \}\)/);
  });
});
