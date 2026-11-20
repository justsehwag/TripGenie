import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SourcesList from "@/components/sources-list";
import type { SourceLink } from "@/lib/types";

const render = (sources?: readonly SourceLink[]): string =>
  renderToStaticMarkup(createElement(SourcesList, { sources }));

const LINKS: SourceLink[] = [
  { title: "Goa travel guide", url: "https://example.com/goa", host: "example.com" },
  { title: "Best beaches", url: "https://travel.example.org/beaches", host: "travel.example.org" },
];

describe("SourcesList", () => {
  it("renders nothing for missing or empty sources", () => {
    expect(render(undefined)).toBe("");
    expect(render([])).toBe("");
  });

  it("renders a labelled section with a Sources heading", () => {
    const html = render(LINKS);
    expect(html).toContain('aria-labelledby="sources-list-heading"');
    expect(html).toContain(">Sources</h2>");
  });

  it("renders links that open in a new tab safely, with title and host", () => {
    const html = render(LINKS);
    expect((html.match(/<a /g) ?? []).length).toBe(2);
    expect((html.match(/target="_blank"/g) ?? []).length).toBe(2);
    expect((html.match(/rel="noopener noreferrer"/g) ?? []).length).toBe(2);
    expect(html).toContain('href="https://example.com/goa"');
    expect(html).toContain("Goa travel guide");
    expect(html).toContain("travel.example.org");
    expect(html).toContain("(opens in a new tab)");
  });

  it("escapes HTML in titles", () => {
    const html = render([
      { title: '<img src=x onerror="alert(1)">', url: "https://example.com/x", host: "example.com" },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
