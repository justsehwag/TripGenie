import type { SourceLink } from "@/lib/types";

export interface SourcesListProps {
  sources?: readonly SourceLink[];
}

/**
 * Web sources behind an itinerary: title and host only (no snippet text, no
 * prices). Renders nothing when there are no sources, so no empty heading or
 * placeholder ever appears. Titles are React text children and are escaped.
 */
export default function SourcesList({ sources }: SourcesListProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <section className="sources-list" aria-labelledby="sources-list-heading">
      <h2 id="sources-list-heading" className="sources-list__heading">
        Sources
      </h2>
      <ul className="sources-list__items">
        {sources.map((source) => (
          <li key={source.url} className="sources-list__item">
            <a
              className="sources-list__link"
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {source.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            <span className="sources-list__host">{source.host}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
