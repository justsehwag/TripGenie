#!/usr/bin/env node
// Manual reproduction of the Wikipedia image failure (Requirement 11.12).
// Not a vitest test: it makes live network calls.
// Usage: node scripts/repro-wiki-image.mjs [--base <url>]
// Node 18+, global fetch, no dependencies. Reads no environment files.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = resolve(ROOT, "..", ".kiro", "specs", "places-first-itinerary", "wikipedia-repro.json");
const FIXTURE_DIR = join(ROOT, "test", "fixtures", "wikipedia");

// Copy of DEFAULT_IMAGE_HOST_ALLOWLIST from lib/config.ts (the current default, before task 4 adds thumb.wikimedia.org).
const DEFAULT_IMAGE_HOST_ALLOWLIST = [
  "upload.wikimedia.org",
  "commons.wikimedia.org",
  "picsum.photos",
  "fastly.picsum.photos",
  "i.picsum.photos",
];

const OLD_UA = "TripsaathiAI/1.0 (image thumbnails)";
const NEW_UA = "TripGenie/1.0 (https://github.com/justsehwag/TripGenie)";
const WIKI = "https://en.wikipedia.org";
const TIMEOUT_MS = 10000;
const REPRO_QUERIES = ["Taj Mahal India", "Goa"];
const FIXTURE_QUERIES = ["Taj Mahal", "Eiffel Tower", "Goa", "Taj Mahal India", "qzxjvkwpl zzqy xxkcd"];

const argv = process.argv.slice(2);
const baseIdx = argv.indexOf("--base");
const BASE = baseIdx >= 0 && argv[baseIdx + 1] ? argv[baseIdx + 1].replace(/\/+$/, "") : null;

const slug = (q) => q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};
const hostInfo = (u) => {
  const host = typeof u === "string" ? hostOf(u) : null;
  return { host, inAllowlist: host ? DEFAULT_IMAGE_HOST_ALLOWLIST.includes(host) : null };
};

/** One GET. Never throws; returns status, headers of interest and the full body text. */
async function get(url, ua) {
  const headers = { Accept: "application/json" };
  if (ua) headers["User-Agent"] = ua;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    const body = await res.text();
    return {
      url,
      userAgent: ua ?? null,
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
      contentType: res.headers.get("content-type"),
      cacheControl: res.headers.get("cache-control"),
      body,
    };
  } catch (e) {
    return { url, userAgent: ua ?? null, status: null, error: String(e && e.message ? e.message : e), body: "" };
  } finally {
    clearTimeout(timer);
    await sleep(400); // stay polite between requests
  }
}

const parse = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
const brief = (r) => ({
  url: r.url,
  userAgent: r.userAgent,
  status: r.status,
  retryAfter: r.retryAfter ?? null,
  contentType: r.contentType ?? null,
  ...(r.error ? { error: r.error } : {}),
});

const summaryUrl = (title) => `${WIKI}/api/rest_v1/page/summary/${title}`;
const titleSearchUrl = (q, limit) => `${WIKI}/w/rest.php/v1/search/title?q=${encodeURIComponent(q)}&limit=${limit}`;
const fullTextUrl = (q, limit) =>
  `${WIKI}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${limit}&srnamespace=0&format=json&formatversion=2`;

/** Summary request plus the image hosts it reports. */
async function summaryRow(title, ua) {
  const r = await get(summaryUrl(title), ua);
  const json = parse(r.body);
  return {
    ...brief(r),
    bodyFirst2000: r.body.slice(0, 2000),
    thumbnail: hostInfo(json?.thumbnail?.source),
    originalimage: hostInfo(json?.originalimage?.source),
    thumbnailSource: json?.thumbnail?.source ?? null,
    originalimageSource: json?.originalimage?.source ?? null,
  };
}

/** First title the resolver would pick: REST key, else full-text title (spaces to underscores). */
const firstTitleFromTitleSearch = (json) => {
  const p = Array.isArray(json?.pages) ? json.pages.find((x) => !/disambiguation|may refer to/i.test(x?.description ?? "")) : null;
  return p?.key ?? (p?.title ? p.title.replace(/ /g, "_") : null);
};
const firstTitleFromFullText = (json) => {
  const t = json?.query?.search?.[0]?.title;
  return t ? t.replace(/ /g, "_") : null;
};

async function reproQuery(q) {
  const out = { query: q };
  const currentTitle = encodeURIComponent(q.trim().replace(/\s+/g, "_"));
  out.currentTitle = currentTitle;
  out.currentUserAgent = await summaryRow(currentTitle, OLD_UA);
  out.contactUserAgent = await summaryRow(currentTitle, NEW_UA);

  const ts = await get(titleSearchUrl(q, 1), NEW_UA);
  const tsJson = parse(ts.body);
  const ft = await get(fullTextUrl(q, 1), NEW_UA);
  const ftJson = parse(ft.body);
  out.titleSearch = { ...brief(ts), firstTitle: firstTitleFromTitleSearch(tsJson), bodyFirst2000: ts.body.slice(0, 2000) };
  out.fullTextSearch = { ...brief(ft), firstTitle: firstTitleFromFullText(ftJson), bodyFirst2000: ft.body.slice(0, 2000) };

  const first = out.titleSearch.firstTitle ?? out.fullTextSearch.firstTitle;
  out.summaryOfFirstTitle = first
    ? { title: first, ...(await summaryRow(encodeURIComponent(first), NEW_UA)) }
    : { title: null, note: "no title from either search" };

  if (BASE) {
    const r = await get(`${BASE}/api/image?kind=destination&query=${encodeURIComponent(q)}&slot=0`, null);
    out.route = { ...brief(r), cacheControl: r.cacheControl ?? null, body: r.body.slice(0, 2000) };
  }
  return out;
}

async function saveFixtures(q) {
  const s = slug(q);
  const files = {};
  const title = await get(titleSearchUrl(q, 3), NEW_UA);
  const full = await get(fullTextUrl(q, 3), NEW_UA);
  const first = firstTitleFromTitleSearch(parse(title.body)) ?? firstTitleFromFullText(parse(full.body));
  // No usable search result: record the summary of the raw title to document the failure.
  const sumTitle = first ? encodeURIComponent(first) : encodeURIComponent(q.trim().replace(/\s+/g, "_"));
  const sum = await get(summaryUrl(sumTitle), NEW_UA);
  const write = async (suffix, r) => {
    const name = `${s}.${suffix}.json`;
    await writeFile(join(FIXTURE_DIR, name), r.body || JSON.stringify({ error: r.error ?? "empty body", status: r.status }), "utf8");
    files[suffix] = { file: `test/fixtures/wikipedia/${name}`, status: r.status, retryAfter: r.retryAfter ?? null };
  };
  await write("title", title); // REST title search (stage 1 of the resolver)
  await write("search", full); // full-text search (fallback stage)
  await write("summary", sum);
  return { query: q, summaryTitle: sumTitle, ...files };
}

async function main() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await mkdir(dirname(REPORT), { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    base: BASE,
    defaultAllowlist: DEFAULT_IMAGE_HOST_ALLOWLIST,
    userAgents: { current: OLD_UA, contact: NEW_UA },
    rows: [],
    fixtures: [],
  };
  for (const q of REPRO_QUERIES) {
    console.log(`repro: ${q}`);
    report.rows.push(await reproQuery(q));
  }
  for (const q of FIXTURE_QUERIES) {
    console.log(`fixture: ${q}`);
    report.fixtures.push(await saveFixtures(q));
  }
  await writeFile(REPORT, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`wrote ${REPORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
