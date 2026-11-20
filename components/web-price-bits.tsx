import type { RouteFareRange } from "@/lib/types";
import { formatCheckedAt, routeFareText, safeHttpsHref } from "@/lib/web-price-format";

/** Source link showing the host only; plain span when the URL is not a safe https URL. */
export function SourceLink({ url, host }: { url: string; host: string }) {
  const href = safeHttpsHref(url);
  if (!href) return <span className="price-source">{host}</span>;
  return (
    <a
      className="price-source"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={"Source: " + host + ", opens in a new tab"}
    >
      {host}
    </a>
  );
}

/** "checked <date>" timestamp; renders nothing for an invalid date. */
export function CheckedAt({ iso }: { iso: string }) {
  const text = formatCheckedAt(iso);
  if (!text) return null;
  return (
    <time className="price-checked" dateTime={iso}>
      checked {text}
    </time>
  );
}

/** Informational typical bus/train fare line; never part of totals. */
export function RouteFareLine({ fare }: { fare: RouteFareRange }) {
  return (
    <p className="route-fare">
      {routeFareText(fare)} (per <SourceLink url={fare.sourceUrl} host={fare.sourceHost} />){" "}
      <CheckedAt iso={fare.checkedAt} />
    </p>
  );
}
