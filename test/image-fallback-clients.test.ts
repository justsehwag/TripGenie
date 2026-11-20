import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usableImageUrl } from "../components/destination-image";

/**
 * Task 4.4 / Requirement 11.10: client consumers of /api/image render the
 * Image_Fallback for `url: null` and on <img> onError, and never render an
 * <img> with a null or failed src. Static source checks plus a pure helper.
 */
const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

describe("usableImageUrl", () => {
  it("returns the url for a non-empty string", () => {
    expect(usableImageUrl({ url: "https://upload.wikimedia.org/a.jpg" })).toBe("https://upload.wikimedia.org/a.jpg");
  });
  it("returns null for url: null with a reason", () => {
    expect(usableImageUrl({ url: null, reason: "no-page" })).toBeNull();
  });
  it("returns null for missing, empty, non-string and non-object input", () => {
    expect(usableImageUrl({})).toBeNull();
    expect(usableImageUrl({ url: "  " })).toBeNull();
    expect(usableImageUrl({ url: 5 })).toBeNull();
    expect(usableImageUrl(null)).toBeNull();
    expect(usableImageUrl("x")).toBeNull();
  });
});

describe("destination-image hook", () => {
  const src = read("components", "destination-image.tsx");
  it("exposes onError that clears the url", () => {
    expect(src).toContain("onError: () => void");
    expect(src).toMatch(/onError = useCallback\(\(\) => setState\(\(s\) => \(\{ url: null/);
  });
  it("sets url null when the route returns no url", () => {
    expect(src).toContain("usableImageUrl(data)");
  });
  it("wires onError on the layer <img>", () => {
    expect(src).toMatch(/<img className="img-layer__img"[^>]*onError=\{onError\}/);
  });
});

describe("hook consumers wire onError on every dynamic <img>", () => {
  it("concierge-home HeroImage", () => {
    const s = read("components", "concierge-home.tsx");
    expect(s).toContain('const { url, srcSet, alt, onError } = useDestinationImage(query, 0, "hero");');
    expect(s).toMatch(/src=\{url\} onError=\{onError\}/);
  });
  it("homepage feature block", () => {
    const s = read("components", "homepage.tsx");
    expect(s).toContain('const { url, srcSet, alt, onError } = useDestinationImage(query, slot, "hero");');
    expect(s).toMatch(/src=\{url\}\s+onError=\{onError\}/);
  });
  it("planner TripCover", () => {
    const s = read("components", "planner.tsx");
    expect(s).toContain('const { url, srcSet, alt, onError } = useDestinationImage(query, 0, "cover");');
    expect(s).toContain("srcSet={srcSet} src={url} alt={alt} onError={onError} />");
  });
});

describe("discover-sights usePlaceImage", () => {
  const s = read("components", "discover-sights.tsx");
  it("returns url and onError, and nulls url for url: null", () => {
    expect(s).toContain("{ url: string | null; onError: () => void }");
    expect(s).toContain("return { url, onError: () => setUrl(null) };");
    expect(s).toMatch(/setUrl\(typeof d\?\.url === "string" && d\.url !== "" \? d\.url : null\)/);
  });
  it("every <img src={img}> has onError and sits behind a truthy guard", () => {
    const imgs = s.match(/<img[^>]*src=\{img\}[^>]*>/g) ?? [];
    expect(imgs.length).toBe(3);
    for (const tag of imgs) expect(tag).toContain("onError={onImgError}");
  });
  it("detail gallery drops failed sources", () => {
    expect(s).toContain("galleryAll.filter((g) => !badSrc.includes(g.src))");
    expect(s).toMatch(/className="disc-detail__img"[^>]*onError=/);
  });
});

describe("LocationCarousel", () => {
  const s = read("components", "location-carousel.tsx");
  it("removes a failed url on onError", () => {
    expect(s).toContain("onError={() => { setUrls((prev) => prev.filter((x) => x !== u)); setI(0); }}");
  });
  it("shows the fallback stage (no <img>) once resolved with no urls", () => {
    expect(s).toContain("if (!resolved) return null;");
    expect(s).toMatch(/<div className="loc-carousel__stage" \/>/);
  });
  it("no longer claims a Picsum fallback", () => {
    expect(s.toLowerCase()).not.toContain("picsum");
  });
});
