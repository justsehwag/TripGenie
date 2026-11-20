import { afterEach, describe, expect, it } from "vitest";
import { loadAwsConfig, wikimediaContact } from "@/lib/config";
import { isAllowedImageUrl } from "@/lib/imagery";

const KEY = "TRIPGENIE_WIKIMEDIA_CONTACT";
const ALLOW_KEY = "TRIPGENIE_IMAGE_HOST_ALLOWLIST";
const saved = { c: process.env[KEY], a: process.env[ALLOW_KEY] };

afterEach(() => {
  for (const [k, v] of [[KEY, saved.c], [ALLOW_KEY, saved.a]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("wikimediaContact", () => {
  it("defaults to the repository URL when unset or blank", () => {
    delete process.env[KEY];
    expect(wikimediaContact()).toBe("https://github.com/justsehwag/TripGenie");
    process.env[KEY] = "   ";
    expect(wikimediaContact()).toBe("https://github.com/justsehwag/TripGenie");
  });

  it("returns the trimmed override", () => {
    process.env[KEY] = "  mailto:ops@example.com ";
    expect(wikimediaContact()).toBe("mailto:ops@example.com");
  });
});

describe("default image host allowlist", () => {
  it("includes thumb.wikimedia.org", () => {
    delete process.env[ALLOW_KEY];
    expect(loadAwsConfig().imageHostAllowlist).toContain("thumb.wikimedia.org");
    expect(isAllowedImageUrl("https://thumb.wikimedia.org/a/320px-x.jpg")).toBe(true);
  });
});
