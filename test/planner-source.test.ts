import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const planner = readFileSync(join(root, "components", "planner.tsx"));
const css = readFileSync(join(root, "app", "globals.css"));
const plannerText = planner.toString("utf8");

function bareLfCount(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) n++;
  }
  return n;
}

describe("planner source checks", () => {
  it("uses resolveTripLength", () => {
    expect(plannerText).toContain("resolveTripLength");
  });

  it("does not contain carryEditToContext", () => {
    expect(plannerText).not.toContain("carryEditToContext");
  });

  it("does not patch durationDays into the context", () => {
    expect(plannerText).not.toContain("patchContext({ durationDays");
  });

  it("components/planner.tsx has 0 bare LF", () => {
    expect(bareLfCount(planner)).toBe(0);
  });

  it("app/globals.css has 0 bare LF", () => {
    expect(bareLfCount(css)).toBe(0);
  });
});
