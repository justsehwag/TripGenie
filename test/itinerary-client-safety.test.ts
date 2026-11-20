import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Client-bundle safety (Requirements 13.1, 13.5): no "use client" file may
 * reach a server-only module through runtime (non type-only) imports.
 */

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib"];
const FORBIDDEN_FILES = new Set(
  [
    "lib/config.ts",
    "lib/bedrock-model.ts",
    "lib/grounding/service.ts",
    "lib/itinerary/verifier.ts",
    "lib/itinerary/verification-cache.ts",
    "lib/itinerary/grounding-memo.ts",
    "lib/itinerary/batch-service.ts",
  ].map((p) => path.join(ROOT, p).toLowerCase()),
);
const FORBIDDEN_DIR = path.join(ROOT, "lib", "providers").toLowerCase() + path.sep;

function isForbidden(file: string): boolean {
  const f = file.toLowerCase();
  return FORBIDDEN_FILES.has(f) || f.startsWith(FORBIDDEN_DIR);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Removes block and line comments while leaving string literals intact. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i];
          i++;
        }
        if (i < n) out += src[i];
        i++;
      }
      if (i < n) out += src[i];
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function isUseClient(src: string): boolean {
  const first = stripComments(src)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return !!first && /^["']use client["'];?$/.test(first);
}

/** Runtime module specifiers (type-only imports/exports are skipped). */
function runtimeSpecifiers(src: string): string[] {
  const code = stripComments(src);
  const specs: string[] = [];
  const re = /\b(import|export)\b(\s+type\b)?([^;'"`]*?)\bfrom\s*(["'])([^"']+)\4|\bimport\s*(["'])([^"']+)\6|\bimport\s*\(\s*(["'])([^"']+)\8\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[5] !== undefined) {
      if (m[2]) continue; // import type / export type ... from
      const clause = m[3] ?? "";
      // `import { type A, type B } from` has only erased names; keep conservative:
      // all named members prefixed with `type` => erased at build time.
      const named = /\{([\s\S]*)\}/.exec(clause);
      const hasDefaultOrNamespace = /[\w$*]/.test(clause.replace(/\{[\s\S]*\}/, ""));
      if (named && !hasDefaultOrNamespace) {
        const members = named[1].split(",").map((s) => s.trim()).filter(Boolean);
        if (members.length > 0 && members.every((s) => /^type\s/.test(s))) continue;
      }
      specs.push(m[5]);
    } else if (m[7] !== undefined) specs.push(m[7]);
    else if (m[9] !== undefined) specs.push(m[9]);
  }
  return specs;
}

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(from), spec);
  else return null; // bare package import
  const candidates = [base, base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && /\.(ts|tsx)$/.test(c)) return c;
  }
  return null;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

function scan() {
  const all = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  const clientFiles = all.filter((f) => isUseClient(fs.readFileSync(f, "utf8")));
  const violations: string[] = [];
  const graph = new Set<string>();

  for (const entry of clientFiles) {
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
      const cur = queue.shift()!;
      graph.add(cur);
      if (cur !== entry && isForbidden(cur)) {
        const chain: string[] = [];
        for (let n: string | null | undefined = cur; n; n = parent.get(n)) chain.unshift(rel(n));
        violations.push(chain.join(" -> "));
        continue;
      }
      let src: string;
      try {
        src = fs.readFileSync(cur, "utf8");
      } catch {
        continue;
      }
      for (const spec of runtimeSpecifiers(src)) {
        const target = resolveSpec(spec, cur);
        if (target && !parent.has(target)) {
          parent.set(target, cur);
          queue.push(target);
        }
      }
    }
  }
  return { clientFiles, graph, violations };
}

describe("client bundle safety", () => {
  it("detects imports in the scanner (sanity)", () => {
    const src = [
      '// import a from "./commented";',
      'import type { T } from "./type-only";',
      'import { type A } from "./inline-type";',
      'import {\n  x,\n  y,\n} from "./multi";',
      'import "./side-effect";',
      'export { z } from "./reexport";',
      'export type { Q } from "./type-reexport";',
      'const m = import("./dynamic");',
      'import React from "react";',
    ].join("\n");
    expect(runtimeSpecifiers(src).sort()).toEqual(
      ["./dynamic", "./multi", "./reexport", "./side-effect", "react"].sort(),
    );
  });

  it("no use-client file transitively imports a server-only module at runtime", () => {
    const { clientFiles, graph, violations } = scan();
    expect(clientFiles.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`client files scanned: ${clientFiles.length}; graph size: ${graph.size}`);
    expect(violations, `Server-only module reachable from client code:\n${violations.join("\n")}`).toEqual([]);
  });
});
