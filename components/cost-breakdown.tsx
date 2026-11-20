import type { CostBreakdown, CostLine } from "@/lib/cost-breakdown";
import { formatInr } from "@/lib/itinerary-inr";

/** Returns the parsed URL only for http/https sources, otherwise null. */
function parseWebSource(source: string): URL | null {
  const s = source.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function Source({ source }: { source: string }) {
  if (!source.trim()) return null;
  const url = parseWebSource(source);
  return (
    <span className="cost-breakdown__source">
      {url ? (
        <a href={url.href} target="_blank" rel="noopener noreferrer">
          {url.host}
        </a>
      ) : (
        source
      )}
    </span>
  );
}

function Line({ line }: { line: CostLine }) {
  const priced = line.amountInr !== null;
  return (
    <li
      className={`cost-breakdown__line${priced ? "" : " cost-breakdown__line--unpriced"}${
        line.included ? "" : " cost-breakdown__line--excluded"
      }`}
      data-line-key={line.key}
    >
      <span className="cost-breakdown__label">{line.label}</span>
      <span className="cost-breakdown__formula">{line.formula}</span>
      <span className="cost-breakdown__amount">
        {priced ? formatInr(line.amountInr as number) : "not priced"}
      </span>
      <Source source={line.source} />
      {line.note ? <span className="cost-breakdown__note">{line.note}</span> : null}
    </li>
  );
}

export function CostBreakdown({ breakdown }: { breakdown: CostBreakdown }) {
  return (
    <div className="cost-breakdown">
      <div className="cost-breakdown__head">
        <p className="cost-breakdown__travellers">{breakdown.travellersLine}</p>
        {breakdown.roomsAssumption ? (
          <p className="cost-breakdown__rooms">{breakdown.roomsAssumption}</p>
        ) : null}
      </div>
      <ul className="cost-breakdown__lines">
        {breakdown.lines.map((line, i) => (
          <Line key={`${line.key}-${i}`} line={line} />
        ))}
      </ul>
      <p className="cost-breakdown__total">
        <span className="cost-breakdown__total-label">{breakdown.totalLabel}</span>{" "}
        <span className="cost-breakdown__total-amount">{formatInr(breakdown.totalInr)}</span>
      </p>
    </div>
  );
}

export default CostBreakdown;
