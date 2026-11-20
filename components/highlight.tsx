import { Fragment, type ReactNode } from "react";
import { findRanges } from "@/lib/itinerary/search";

/** Renders `text` with each match of `query` wrapped in <mark>. */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (typeof text !== "string") return text as unknown as ReactNode;
  if (typeof query !== "string" || query.trim() === "") return text;
  const ranges = findRanges(text, query);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([start, end], i) => {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(<mark key={i}>{text.slice(start, end)}</mark>);
    pos = end;
  });
  if (pos < text.length) parts.push(text.slice(pos));
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

export default Highlight;
