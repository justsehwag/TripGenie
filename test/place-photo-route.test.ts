import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/place-photo/route";

// Task 9.15: place-photo route. Four 404 cases with an empty body, and the key
// travels only in the request header. fetch is stubbed; no live network.

const KEY = "unit-test-photo-key";
const REF = "places/ChIJabc123/photos/AUy1YQ";

function get(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/place-photo${query}`);
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = KEY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = saved;
});

async function expectEmpty404(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
  expect(JSON.stringify([...res.headers.entries()])).not.toContain(KEY);
}

describe("GET /api/place-photo", () => {
  it("404 with an empty body for a bad ref, and no upstream call", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expectEmpty404(await GET(get("?ref=https%3A%2F%2Fevil.example%2Fx")));
    await expectEmpty404(await GET(get("?ref=places%2Fa%2Fphotos%2Fb%2Fextra")));
    await expectEmpty404(await GET(get("")));
    expect(f).not.toHaveBeenCalled();
  });

  it("404 with an empty body when no key is configured, and no upstream call", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expectEmpty404(await GET(get(`?ref=${encodeURIComponent(REF)}`)));
    expect(f).not.toHaveBeenCalled();
  });

  it("404 with an empty body when Google answers non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream says no", { status: 403 })));
    await expectEmpty404(await GET(get(`?ref=${encodeURIComponent(REF)}`)));
  });

  it("404 with an empty body when Google does not answer within 5 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const p = GET(get(`?ref=${encodeURIComponent(REF)}`));
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expectEmpty404(await p);
  });

  it("sends the key only in the X-Goog-Api-Key header and never returns it", async () => {
    const f = vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) =>
      new Response("IMG", { status: 200, headers: { "content-type": "image/jpeg", "x-goog-api-key": KEY } }),
    );
    vi.stubGlobal("fetch", f);
    const res = await GET(get(`?ref=${encodeURIComponent(REF)}&w=320`));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("IMG");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://places.googleapis.com/v1/${REF}/media?maxWidthPx=320`);
    expect(url).not.toContain(KEY);
    expect(init?.headers).toEqual({ "X-Goog-Api-Key": KEY });
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(KEY);
  });
});
