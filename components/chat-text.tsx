import { Fragment } from "react";
import { parseChatText, type Inline } from "@/lib/assistant/format";

/** Text with "\n" shown as line breaks. React escapes all characters, so no HTML is interpreted. */
function withBreaks(text: string, key: string) {
  const lines = text.split("\n");
  return lines.map((line, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
}

function renderInline(parts: Inline[], keyPrefix: string) {
  return parts.map((p, i) =>
    p.kind === "bold" ? (
      <strong key={`${keyPrefix}-${i}`}>{withBreaks(p.text, `${keyPrefix}-${i}`)}</strong>
    ) : (
      <Fragment key={`${keyPrefix}-${i}`}>{withBreaks(p.text, `${keyPrefix}-${i}`)}</Fragment>
    ),
  );
}

export function ChatText({ text }: { text: string }) {
  const blocks = parseChatText(text);
  return (
    <>
      {blocks.map((b, bi) => {
        if (b.kind === "paragraph") {
          return <p key={bi}>{renderInline(b.inline, `p${bi}`)}</p>;
        }
        const items = b.items.map((item, ii) => (
          <li key={ii}>{renderInline(item, `b${bi}-${ii}`)}</li>
        ));
        return b.kind === "ol" ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
      })}
    </>
  );
}
