// site-wide-assistant checkpoint 3: quick sanity tests for the pure core.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { sanitizeContext, MAX_WIRE_BYTES, MAX_LIST_ITEMS } from "../lib/site-assistant/sanitize";
import { validateAction, TOOL_ALLOW_LISTS } from "../lib/site-assistant/tools";
import { actionReducer, type ActionState } from "../lib/site-assistant/action-reducer";
import { registerContext, getMergedContext } from "../lib/site-assistant/registry";
import type { ActionProposal, PageId } from "../lib/site-assistant/types";

const PAGES = Object.keys(TOOL_ALLOW_LISTS) as PageId[];
const SENSITIVE = /token|secret|password|authorization|cookie|email|key/i;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const dataArb = fc.oneof(
  fc.jsonValue(),
  fc.record({
    email: fc.constant("a@b.com"),
    apiKey: fc.string(),
    note: fc.constantFrom("mail me at x@y.org", "plain"),
    list: fc.array(fc.oneof(fc.string(), fc.constant("u@v.io")), { maxLength: 60 }),
    big: fc.array(fc.string({ maxLength: 300 }), { maxLength: 100 }),
    nested: fc.jsonValue(),
  }),
);

function maxArrayLen(v: unknown): number {
  if (Array.isArray(v)) return Math.max(v.length, ...v.map(maxArrayLen), 0);
  if (v && typeof v === "object") return Math.max(0, ...Object.values(v).map(maxArrayLen));
  return 0;
}
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keys(x, out);
    }
  }
  return out;
}

describe("sanitizeContext", () => {
  it("is bounded and free of emails and secret keys", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAGES), fc.string(), dataArb, (page, summary, data) => {
        const w = sanitizeContext(page, summary, data);
        const json = JSON.stringify(w);
        expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_WIRE_BYTES);
        expect(maxArrayLen(w.data)).toBeLessThanOrEqual(MAX_LIST_ITEMS);
        expect(EMAIL.test(w.summary)).toBe(false);
        expect(strings(w.data).some((s) => EMAIL.test(s))).toBe(false);
        expect(keys(w.data).some((k) => SENSITIVE.test(k))).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAGES), fc.string(), dataArb, (page, summary, data) => {
        const once = sanitizeContext(page, summary, data);
        const twice = sanitizeContext(page, once.summary, once.data);
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});

describe("validateAction", () => {
  it("rejects tools outside the page allow-list", () => {
    for (const page of PAGES) {
      const allowed = TOOL_ALLOW_LISTS[page];
      for (const tool of ["setSearch", "setSort", "setFilter", "searchPlace", "openPlace", "goTo", "bogus"]) {
        if (allowed.includes(tool)) continue;
        const r = validateAction(page, tool, { route: "/stays" });
        expect(r.ok).toBe(false);
      }
    }
  });

  it("rejects invalid params and accepts a valid goTo", () => {
    expect(validateAction("general", "goTo", { route: "/evil" }).ok).toBe(false);
    expect(validateAction("general", "goTo", { route: "/stays", extra: 1 }).ok).toBe(false);
    expect(validateAction("flights", "setSort", { sort: "nope" }).ok).toBe(false);
    expect(validateAction("flights", "setSearch", { origin: "DEL", destination: "BOM", departDate: "2020-01-01" }).ok).toBe(false);
    expect(validateAction("flights", "setSearch", { origin: "DEL" }).ok).toBe(false);
    expect(validateAction("stays", "setFilter", {}).ok).toBe(false);
    const ok = validateAction("general", "goTo", { route: "/stays" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.proposal.page).toBe("general");
  });
});

describe("actionReducer", () => {
  const prop = (id: string, page: PageId): ActionProposal => ({
    id,
    page,
    tool: "goTo",
    params: { route: "/stays" },
    summary: "s",
    fields: [],
  });

  it("applies only from pending, on the matching page, at most once", () => {
    let s: ActionState[] = actionReducer([], { type: "receive", proposal: prop("a", "flights") });
    expect(s[0].status).toBe("pending");
    s = actionReducer(s, { type: "apply", id: "a", currentPage: "flights" });
    expect(s[0].status).toBe("applied");
    const again = actionReducer(s, { type: "apply", id: "a", currentPage: "flights" });
    expect(again).toBe(s);

    let t = actionReducer([], { type: "receive", proposal: prop("b", "flights") });
    t = actionReducer(t, { type: "apply", id: "b", currentPage: "stays" });
    expect(t[0].status).toBe("stale");
    expect(actionReducer(t, { type: "apply", id: "b", currentPage: "flights" })[0].status).toBe("stale");

    let c = actionReducer([], { type: "receive", proposal: prop("c", "flights") });
    c = actionReducer(c, { type: "cancel", id: "c" });
    expect(actionReducer(c, { type: "apply", id: "c", currentPage: "flights" })[0].status).toBe("cancelled");
  });
});

describe("registry", () => {
  it("merges registered slots and removes them on unregister", () => {
    const off1 = registerContext({ page: "cars", slot: "one", summary: "A", data: { x: 1 }, actions: { goTo: () => {} } });
    const off2 = registerContext({ page: "cars", slot: "two", summary: "B", data: [2] });
    const m = getMergedContext("cars");
    expect(m.summary).toBe("A\nB");
    expect(m.data).toEqual({ one: { x: 1 }, two: [2] });
    expect(Object.keys(m.actions)).toEqual(["goTo"]);
    expect(getMergedContext("cars")).toBe(m);
    off1();
    const m2 = getMergedContext("cars");
    expect(m2.summary).toBe("B");
    expect(m2.data).toEqual({ two: [2] });
    off2();
    expect(getMergedContext("cars").summary).toBe("");
  });
});
