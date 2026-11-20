import { beforeEach, describe, expect, it } from "vitest";
import type { ModelPrompt } from "@/lib/bedrock-model";
import {
  buildPolishPrompt,
  clearPolishMemo,
  getPolishMemo,
  parsePolishText,
  polishBatch,
  polishMaxTokens,
  polishMemoKey,
  polishTimeoutMs,
  setPolishMemo,
  POLISH_MEMO_MAX,
  POLISH_MEMO_TTL_MS,
  type PolishStopIn,
} from "@/lib/itinerary/polish";
import { POLISH_TIMEOUT_MS } from "@/lib/itinerary/constants";
import { SYSTEM_PROMPT_PREFIX } from "@/lib/system-prompt";

const stops: PolishStopIn[] = [
  { placeId: "p1", name: "Fort", primaryType: "tourist_attraction", lat: 1.5, lng: 2.5, day: 1 },
  { placeId: "p2", name: "Beach", primaryType: null, lat: 3, lng: 4, day: 2 },
];

describe("buildPolishPrompt", () => {
  it("sends only the permitted fields and the prefix", () => {
    const p = buildPolishPrompt(stops, [1, 2], "Goa");
    expect(p.system.startsWith(SYSTEM_PROMPT_PREFIX)).toBe(true);
    const parsed = JSON.parse(p.user);
    expect(Object.keys(parsed.stops[0]).sort()).toEqual(
      ["day", "lat", "lng", "name", "placeId", "primaryType"].sort(),
    );
    expect(parsed.days).toEqual([1, 2]);
    expect(p.maxTokens).toBe(200 + 60 * 2 + 80 * 2);
    expect(p.timeoutMs).toBe(POLISH_TIMEOUT_MS);
  });

  it("does not put forbidden words in the instructions", () => {
    const p = buildPolishPrompt(stops, [1, 2], "Goa");
    expect(`${p.system}\n${p.user}`).not.toMatch(/confirmed|bookable/i);
  });

  it("ignores extra fields on the input objects", () => {
    const dirty = [{ ...stops[0], address: "1 Road", price: 500, photos: ["x"], hours: "9-5" }];
    const p = buildPolishPrompt(dirty as unknown as PolishStopIn[], [1], "Goa");
    expect(p.user).not.toMatch(/Road|500|photos|hours|address|price/);
  });

  it("honours an explicit timeout", () => {
    expect(buildPolishPrompt(stops, [1], "Goa", { timeoutMs: 1234 }).timeoutMs).toBe(1234);
  });
});

describe("budget helpers", () => {
  it("computes tokens and timeout", () => {
    expect(polishMaxTokens(3, 10)).toBe(200 + 180 + 800);
    expect(polishTimeoutMs(25_000, 0)).toBe(POLISH_TIMEOUT_MS);
    expect(polishTimeoutMs(25_000, 20_000)).toBe(4_000);
    expect(polishTimeoutMs(25_000, 25_000)).toBeLessThan(0);
  });
});

describe("parsePolishText", () => {
  it("parses plain, fenced and wrapped JSON objects", () => {
    expect(parsePolishText('{"days":[]}')).toEqual({ days: [] });
    expect(parsePolishText('```json\n{"days":[]}\n```')).toEqual({ days: [] });
    expect(parsePolishText('Here: {"days":[]} done')).toEqual({ days: [] });
  });
  it("returns null for anything else", () => {
    expect(parsePolishText("")).toBeNull();
    expect(parsePolishText("no json")).toBeNull();
    expect(parsePolishText("{bad")).toBeNull();
    expect(parsePolishText("[1,2]")).toBeNull();
    expect(parsePolishText(undefined as unknown as string)).toBeNull();
  });
});

describe("polishBatch", () => {
  const prompt = (): ModelPrompt => buildPolishPrompt(stops, [1, 2], "Goa", { timeoutMs: 50 });

  it("returns parsed output and calls the model once", async () => {
    let calls = 0;
    const r = await polishBatch(
      { invokeModel: async () => { calls++; return '{"days":[]}'; } },
      prompt(),
    );
    expect(r).toEqual({ ok: true, raw: { days: [] } });
    expect(calls).toBe(1);
  });

  it("fails without throwing on throw, empty text, bad text and timeout", async () => {
    expect(await polishBatch({ invokeModel: async () => { throw new Error("x"); } }, prompt())).toEqual({ ok: false });
    expect(await polishBatch({ invokeModel: async () => "  " }, prompt())).toEqual({ ok: false });
    expect(await polishBatch({ invokeModel: async () => "nope" }, prompt())).toEqual({ ok: false });
    expect(await polishBatch({ invokeModel: () => new Promise<string>(() => {}) }, prompt())).toEqual({ ok: false });
  });

  it("skips the call when no time is left or no model is given", async () => {
    let calls = 0;
    const p = { ...prompt(), timeoutMs: 0 };
    expect(await polishBatch({ invokeModel: async () => { calls++; return "{}"; } }, p)).toEqual({ ok: false });
    expect(calls).toBe(0);
    expect(await polishBatch({} as never, prompt())).toEqual({ ok: false });
  });
});

describe("polish memo", () => {
  beforeEach(() => clearPolishMemo());

  it("keys ignore input order", () => {
    expect(polishMemoKey([{ placeId: "b", day: 1 }, { placeId: "a", day: 2 }])).toBe(
      polishMemoKey([{ placeId: "a", day: 2 }, { placeId: "b", day: 1 }]),
    );
  });

  it("returns a stored value until it expires", () => {
    let t = 1000;
    setPolishMemo("k", { days: [] }, () => t);
    expect(getPolishMemo("k", () => t)).toEqual({ days: [] });
    t += POLISH_MEMO_TTL_MS;
    expect(getPolishMemo("k", () => t)).toBeUndefined();
  });

  it("evicts the oldest entry beyond the limit", () => {
    for (let i = 0; i <= POLISH_MEMO_MAX; i++) setPolishMemo(`k${i}`, i);
    expect(getPolishMemo("k0")).toBeUndefined();
    expect(getPolishMemo(`k${POLISH_MEMO_MAX}`)).toBe(POLISH_MEMO_MAX);
  });
});
