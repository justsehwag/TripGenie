import { describe, it, expect } from "vitest";
import {
  STANDARD_WIDTHS,
  MAX_IMAGE_WIDTH,
  MIN_USABLE_WIDTH,
  SIZE_WIDTHS,
  parseSizeClass,
  smallestStandardAtLeast,
  largestStandardAtMost,
  chooseWidths,
  rewriteThumbWidth,
  thumbFromOriginal,
  buildSrcSet,
  classifyImage,
} from "@/lib/wiki-image-policy";

const THUMB = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Taj_Mahal.jpg/640px-Taj_Mahal.jpg";

describe("constants", () => {
  it("lists the standard widths and caps", () => {
    expect([...STANDARD_WIDTHS]).toEqual([20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840]);
    expect(MAX_IMAGE_WIDTH).toBe(1920);
    expect(MIN_USABLE_WIDTH).toBe(330);
  });
  it("defines the size classes", () => {
    expect(SIZE_WIDTHS).toEqual({
      thumb: { x1: 120, x2: 250 },
      card: { x1: 500, x2: 960 },
      hero: { x1: 960, x2: 1280 },
      cover: { x1: 1280, x2: 1920 },
    });
  });
});

describe("parseSizeClass", () => {
  it("accepts the four classes and defaults to card", () => {
    for (const s of ["thumb", "card", "hero", "cover"]) expect(parseSizeClass(s)).toBe(s);
    for (const v of [undefined, null, "", "huge", 5, "toString", "__proto__"]) expect(parseSizeClass(v)).toBe("card");
  });
});

describe("standard width lookup", () => {
  it("rounds up and down", () => {
    expect(smallestStandardAtLeast(640)).toBe(960);
    expect(smallestStandardAtLeast(400)).toBe(500);
    expect(smallestStandardAtLeast(1)).toBe(20);
    expect(smallestStandardAtLeast(1920)).toBe(1920);
    expect(smallestStandardAtLeast(1921)).toBeNull();
    expect(largestStandardAtMost(700)).toBe(500);
    expect(largestStandardAtMost(19)).toBeNull();
    expect(largestStandardAtMost(5000)).toBe(1920);
    expect(smallestStandardAtLeast(Number.NaN)).toBeNull();
  });
});

describe("chooseWidths", () => {
  it("uses the class widths for a wide original", () => {
    expect(chooseWidths("card", 4000, 500)).toEqual({ x1: 500, x2: 960 });
    expect(chooseWidths("cover", 1920, 1280)).toEqual({ x1: 1280, x2: 1920 });
  });
  it("omits 2x when the original is narrower than x2", () => {
    expect(chooseWidths("hero", 1000, 960)).toEqual({ x1: 960 });
  });
  it("steps x1 down for a narrow original and drops 2x", () => {
    expect(chooseWidths("card", 400, 500)).toEqual({ x1: 330 });
    expect(chooseWidths("hero", 600, 960)).toEqual({ x1: 500 });
  });
  it("is unusable when the best width is below 330", () => {
    expect(chooseWidths("card", 300, 500)).toBeNull();
  });
  it("keeps only a usable standard thumb width when the original is unknown", () => {
    expect(chooseWidths("card", undefined, 500)).toEqual({ x1: 500 });
    expect(chooseWidths("card", undefined, 640)).toBeNull();
    expect(chooseWidths("card", undefined, 250)).toBeNull();
  });
});

describe("rewriteThumbWidth", () => {
  it("rewrites to a standard width and never produces 640", () => {
    expect(rewriteThumbWidth(THUMB, 640)).toContain("/960px-Taj_Mahal.jpg");
    expect(rewriteThumbWidth(THUMB, 640)).not.toContain("/640px-");
    expect(rewriteThumbWidth(THUMB, 500)).toContain("/500px-Taj_Mahal.jpg");
  });
  it("rejects bad input", () => {
    expect(rewriteThumbWidth(THUMB, 2500)).toBeNull();
    expect(rewriteThumbWidth("https://evil.example/thumb/a/ab/x.jpg/640px-x.jpg", 500)).toBeNull();
    expect(rewriteThumbWidth("http://upload.wikimedia.org/a/640px-x.jpg", 500)).toBeNull();
    expect(rewriteThumbWidth("https://upload.wikimedia.org/wikipedia/commons/a/ab/x.jpg", 500)).toBeNull();
    expect(rewriteThumbWidth("not a url", 500)).toBeNull();
  });
});

describe("thumbFromOriginal", () => {
  const orig = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Taj_Mahal.jpg";
  it("builds the thumb path", () => {
    expect(thumbFromOriginal(orig, 960)).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Taj_Mahal.jpg/960px-Taj_Mahal.jpg",
    );
  });
  it("rejects non-standard or over-cap widths, other hosts, thumbs and svg", () => {
    expect(thumbFromOriginal(orig, 640)).toBeNull();
    expect(thumbFromOriginal(orig, 3840)).toBeNull();
    expect(thumbFromOriginal("https://example.com/wikipedia/commons/a/ab/x.jpg", 500)).toBeNull();
    expect(thumbFromOriginal(THUMB, 500)).toBeNull();
    expect(thumbFromOriginal("https://upload.wikimedia.org/wikipedia/commons/a/ab/Flag.svg", 500)).toBeNull();
  });
});

describe("buildSrcSet", () => {
  it("formats 1x and 2x, or nothing without 2x", () => {
    expect(buildSrcSet("https://a/1.jpg", "https://a/2.jpg")).toBe("https://a/1.jpg 1x, https://a/2.jpg 2x");
    expect(buildSrcSet("https://a/1.jpg")).toBeUndefined();
  });
});

describe("classifyImage", () => {
  it("rejects Flag_of_India.svg.png in every form", () => {
    expect(classifyImage({ fileName: "Flag_of_India.svg.png" })).toBe("reject");
    expect(classifyImage({ fileName: "250px-Flag_of_India.svg.png" })).toBe("reject");
    expect(
      classifyImage({
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Flag_of_India.svg/250px-Flag_of_India.svg.png",
      }),
    ).toBe("reject");
    expect(classifyImage({ title: "Flag of India" })).toBe("reject");
  });
  it("rejects emblems, coats of arms, seals, maps, logos and svg", () => {
    for (const f of [
      "Emblem_of_India.png",
      "Coat_of_arms_of_Goa.jpg",
      "Seal_of_Paris.png",
      "Goa_locator_map.png",
      "Goa_location_map.jpg",
      "Map_of_Goa.png",
      "Company_logo.png",
      "Globe_icon.png",
      "Something.svg",
      "Photo.gif",
      "Photo.tif",
    ]) {
      expect(classifyImage({ fileName: f }), f).toBe("reject");
    }
    expect(classifyImage({ title: "Coat of arms of Spain" })).toBe("reject");
  });
  it("accepts photographs, including names that contain a pattern as a part of a word", () => {
    expect(classifyImage({ fileName: "Taj_Mahal_(Edited).jpeg" })).toBe("accept");
    expect(classifyImage({ fileName: "Flagstaff_Arizona.jpg", title: "Flagstaff" })).toBe("accept");
    expect(classifyImage({ title: "Flagler Beach" })).toBe("accept");
    expect(classifyImage({ fileName: "Beach.webp", title: "Goa" })).toBe("accept");
    expect(
      classifyImage({ url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Taj_Mahal.jpg/500px-Taj_Mahal.jpg" }),
    ).toBe("accept");
  });
  it("decodes percent-encoded names", () => {
    expect(classifyImage({ fileName: "Flag%20of%20India.jpg" })).toBe("reject");
  });
});
