import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ModelPrompt } from "@/lib/bedrock-model";

/**
 * Realtime AI integration — Bedrock_Route tests (task 3.2).
 *
 * The model boundary is MOCKED: `createBedrockInvoke` is replaced so NO live
 * AWS call ever happens. The REAL route, controller, and model fallback logic
 * run against a controllable fake `invokeModel`. This also confirms Bedrock is
 * reached only server-side (the route imports `createBedrockInvoke`, never the
 * browser).
 */

// Controllable fake the mocked createBedrockInvoke hands back. Tests swap this
// per case. It receives the ModelPrompt so a test can branch on prompt content.
let fakeInvoke: (prompt: ModelPrompt) => Promise<string>;

vi.mock("@/lib/bedrock-model", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bedrock-model")>(
    "@/lib/bedrock-model",
  );
  return {
    ...actual,
    // Only the AWS boundary is stubbed; extract/phrase/itinerary stay real.
    createBedrockInvoke: () => (prompt: ModelPrompt) => fakeInvoke(prompt),
  };
});

// Web grounding never reaches the network in these tests.
vi.mock("@/lib/grounding/service", async () => {
  const types = await vi.importActual<typeof import("@/lib/grounding/types")>(
    "@/lib/grounding/types",
  );
  return {
    groundItinerary: async () => types.EMPTY_BUNDLE("unavailable"),
  };
});

// Import the route AFTER the mock is registered.
import { POST } from "@/app/api/ai/route";
import { uncollected } from "@/lib/preference-controller";

function post(body: unknown): Request {
  return new Request("http://localhost/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  // Default: a model that returns nothing interpretable.
  fakeInvoke = async () => "";
});

describe("Feature: realtime-ai-integration, Bedrock_Route /api/ai", () => {
  it("turn success: reflects extraction and asks for the next uncollected field", async () => {
    // The extraction prompt is the one carrying the "Latest input" marker; the
    // phrasing prompt carries "Missing field". Branch so extraction yields a
    // destination and phrasing yields a concrete question string.
    fakeInvoke = async (prompt) => {
      if (prompt.user.includes("Missing field")) {
        return "Which city are you flying out of for this trip?";
      }
      return JSON.stringify({ destination: "Tokyo" });
    };

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "I want to go to Tokyo",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    // Context reflects the extraction.
    expect(json.response.state.context.destination).toBe("Tokyo");
    expect(json.response.phase).toBe("collecting");

    // The next question targets the first uncollected field of the merged
    // context (origin comes before destination is filled → origin is next).
    const nextField = uncollected(json.response.state.context)[0];
    expect(nextField).toBe("origin");
    expect(json.response.prompt).toBe(
      "Which city are you flying out of for this trip?",
    );
  });

  it("turn with a throwing model still returns a valid ControllerResponse (no 500)", async () => {
    fakeInvoke = async () => {
      throw new Error("bedrock unavailable");
    };

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "a trip to Tokyo from Delhi",
      }),
    );
    // Never a 500 for a model failure.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.response).toBeDefined();
    expect(["collecting", "completion"]).toContain(json.response.phase);
    expect(typeof json.response.prompt).toBe("string");
    expect(typeof json.systemPromptPrefix).toBe("string");
  });

  it("turn with a hanging/timeout model still returns a valid ControllerResponse (no 500)", async () => {
    // Never resolves before the bounded timeout fires → treated as an error →
    // deterministic rule-based fallback kicks in.
    fakeInvoke = () => new Promise<string>(() => {});

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "Delhi to Tokyo for 5 days",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.response).toBeDefined();
    expect(["collecting", "completion"]).toContain(json.response.phase);
    expect(typeof json.response.prompt).toBe("string");
    // Rule-based fallback parses what it can from the delta; "5 days" resolves
    // a duration deterministically via the date-intake heuristics.
    expect(json.response.state.context.durationDays).toBe(5);
    // A turn makes up to two bounded model calls (extract then phrase), each
    // with a ~5s timeout, so a fully hanging model takes ~10s to degrade.
  }, 20000);

  it("itinerary with a failing model returns unavailable and no itinerary", async () => {
    fakeInvoke = async () => {
      throw new Error("bedrock unavailable");
    };

    const res = await POST(
      post({
        action: "itinerary",
        context: { destination: "Tokyo", durationDays: 3 },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("unavailable");
    expect(typeof json.reason).toBe("string");
    expect("itinerary" in json).toBe(false);
  });

  it("bad JSON body returns 400", async () => {
    const res = await POST(post("{not valid json"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("missing action returns 400", async () => {
    const res = await POST(post({ state: { context: {}, questionsAsked: 0 } }));
    expect(res.status).toBe(400);
  });

  it("unknown action returns 400", async () => {
    const res = await POST(post({ action: "frobnicate" }));
    expect(res.status).toBe(400);
  });

  it("turn with invalid controller state returns 400", async () => {
    const res = await POST(post({ action: "turn", inputDelta: "hi" }));
    expect(res.status).toBe(400);
  });

  it("itinerary with missing context returns 400", async () => {
    const res = await POST(post({ action: "itinerary" }));
    expect(res.status).toBe(400);
  });
});

describe("Feature: trustworthy-itinerary, itinerary-batch /api/ai", () => {
  const KEY = "GOOGLE_PLACES_API_KEY";
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env[KEY];
    // No real network call may happen in any of these tests.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in test");
      }),
    );
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY];
    else process.env[KEY] = savedKey;
    vi.unstubAllGlobals();
  });

  const validBatch = {
    action: "itinerary-batch",
    context: { destination: "Tokyo", durationDays: 3 },
    fromDay: 1,
    dayCount: 1,
    usedPlaces: [] as string[],
  };

  it("returns 400 for an invalid body", async () => {
    const res = await POST(
      post({ action: "itinerary-batch", context: { destination: "", durationDays: 3 } }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
  });

  it("returns 200 unavailable/not-configured with no model call when the Places key is missing", async () => {
    delete process.env[KEY];
    let modelCalls = 0;
    fakeInvoke = async () => {
      modelCalls++;
      return "";
    };

    const res = await POST(post(validBatch));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("unavailable");
    expect(json.reason).toBe("not-configured");
    expect(json.days).toEqual([]);
    expect(modelCalls).toBe(0);
  });

  it("returns 200 unavailable (never fallback) when the model throws", async () => {
    process.env[KEY] = "test-key-not-real";
    fakeInvoke = async () => {
      throw new Error("bedrock unavailable");
    };

    const res = await POST(post(validBatch));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("unavailable");
    expect(json.source).not.toBe("fallback");
    expect(json.days).toEqual([]);
  });

  it('action "turn" still behaves as before', async () => {
    fakeInvoke = async (prompt) => {
      if (prompt.user.includes("Missing field")) {
        return "Which city are you flying out of for this trip?";
      }
      return JSON.stringify({ destination: "Tokyo" });
    };

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "I want to go to Tokyo",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.response.state.context.destination).toBe("Tokyo");
    expect(json.response.phase).toBe("collecting");
    expect(json.source).toBe("bedrock");
  });
});
