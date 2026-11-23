/**
 * Pure parser that turns assistant chat text into plain data blocks.
 * No HTML is produced or interpreted; the UI maps blocks to React elements.
 */

export type Inline = { kind: "text" | "bold"; text: string };

export type Block =
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "ol"; items: Inline[][] }
  | { kind: "ul"; items: Inline[][] };

const OL_RE = /^\s*\d+[.)]\s+/;
const UL_RE = /^\s*[-*•]\s+/;
const HEADING_RE = /^\s*#{1,6}\s+/;
// Bold needs a non-alphanumeric character (or the edge) on the outside.
const BOLD_RE = /(?<![\p{L}\p{N}])\*\*([^*\n]+?)\*\*(?![\p{L}\p{N}])/gu;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/** Remove markdown marker characters; replace with a space if that would join two words. */
function clean(s: string): string {
  let out = s.replace(
    /(?<![\p{L}\p{N}_])_+([^_\n]+?)_+(?![\p{L}\p{N}_])/gu,
    "$1",
  );
  out = out.replace(/[*`]+/g, (run, offset: number, whole: string) => {
    const before = offset > 0 ? whole[offset - 1] : "";
    const after = whole[offset + run.length] ?? "";
    const joins = ALNUM_RE.test(before) && ALNUM_RE.test(after);
    return joins ? " " : "";
  });
  return out;
}

function parseInline(raw: string): Inline[] {
  const result: Inline[] = [];
  let last = 0;
  const push = (kind: Inline["kind"], text: string) => {
    if (text) result.push({ kind, text });
  };
  for (const m of raw.matchAll(BOLD_RE)) {
    const idx = m.index ?? 0;
    push("text", clean(raw.slice(last, idx)));
    push("bold", clean(m[1]));
    last = idx + m[0].length;
  }
  push("text", clean(raw.slice(last)));
  return result;
}

export function parseChatText(text: string): Block[] {
  if (!text) return [];
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  let para: string[] = [];
  let list: { kind: "ol" | "ul"; items: Inline[][] } | null = null;

  const flushPara = () => {
    if (para.length) {
      const inline = parseInline(para.join("\n"));
      if (inline.length) blocks.push({ kind: "paragraph", inline });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const kind = OL_RE.test(line) ? "ol" : UL_RE.test(line) ? "ul" : null;
    if (kind) {
      flushPara();
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      const body = line.replace(kind === "ol" ? OL_RE : UL_RE, "");
      list.items.push(parseInline(body));
      continue;
    }
    flushList();
    para.push(line.replace(HEADING_RE, "").trim());
  }
  flushPara();
  flushList();
  return blocks;
}

const joinInline = (parts: Inline[]) => parts.map((p) => p.text).join("");

/** Plain text of all blocks: paragraphs separated by a blank line, list items one per line. */
export function stripMarkdown(text: string): string {
  return parseChatText(text)
    .map((b) =>
      b.kind === "paragraph"
        ? joinInline(b.inline)
        : b.items.map(joinInline).join("\n"),
    )
    .join("\n\n");
}
