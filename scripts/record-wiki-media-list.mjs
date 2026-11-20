#!/usr/bin/env node
// Manual fixture recording (not a test): saves the live Wikipedia media-list for
// Eiffel Tower to test/fixtures/wikipedia/eiffel-tower.media.json.
// Usage: node scripts/record-wiki-media-list.mjs
// Node 18+, global fetch, no dependencies. Reads no environment files.

import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "test", "fixtures", "wikipedia", "eiffel-tower.media.json");
const URL_ = "https://en.wikipedia.org/api/rest_v1/page/media-list/Eiffel_Tower";
const UA = "TripGenie/1.0 (https://github.com/justsehwag/TripGenie)";
const REJECT = /\.svg|\b(flag|logo|map|locator|emblem|coat[ _]of[ _]arms|icon|symbol)\b|[_ .-](flag|logo|map|locator|emblem|icon|symbol)[_ .-]/i;

const res = await fetch(URL_, { headers: { "User-Agent": UA, Accept: "application/json" } });
const body = await res.text();
if (!res.ok) {
  console.error(`status ${res.status}`);
  process.exit(1);
}
const json = JSON.parse(body);
const first = (json.items ?? []).find((i) => i.type === "image" && !REJECT.test(i.title ?? "") && /\.(jpe?g|png|webp)$/i.test(i.title ?? ""));
if (!first) {
  console.error("no acceptable item in the media list");
  process.exit(1);
}
await writeFile(OUT, body, "utf8");
console.log(`wrote ${OUT}`);
console.log(`first acceptable item: ${first.title}`);
