import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usableImageUrl, usableSrcSet } from "@/components/destination-image";

const src = readFileSync(join(process.cwd(), "components", "destination-image.tsx"), "utf8");

describe("destination-image size and srcset", () => {
  it("usableSrcSet accepts a non-empty string only", () => {
    expect(usableSrcSet({ srcset: "a 1x, b 2x" })).toBe("a 1x, b 2x");
    expect(usableSrcSet({ srcset: "" })).toBeUndefined();
    expect(usableSrcSet({ srcset: "  " })).toBeUndefined();
    expect(usableSrcSet({ srcset: 5 })).toBeUndefined();
    expect(usableSrcSet({})).toBeUndefined();
    expect(usableSrcSet(null)).toBeUndefined();
  });

  it("usableImageUrl guard is unchanged", () => {
    expect(usableImageUrl({ url: null })).toBeNull();
    expect(usableImageUrl({ url: "https://x/y.jpg" })).toBe("https://x/y.jpg");
  });

  it("hook takes a size defaulting to card and sends it to /api/image", () => {
    expect(src).toContain('size: SizeClass = "card"');
    expect(src).toMatch(/URLSearchParams\(\{[^}]*size,/);
    expect(src).toContain("srcSet: state.srcSet");
  });

  it("layer uses card, sets srcSet and keeps onError", () => {
    expect(src).toContain('useDestinationImage(query, slot, "card")');
    expect(src).toContain("src={url} srcSet={srcSet}");
    expect(src).toContain("onError={onError}");
  });

  it("file keeps LF line endings", () => {
    expect(src.includes("\r")).toBe(false);
  });
});
