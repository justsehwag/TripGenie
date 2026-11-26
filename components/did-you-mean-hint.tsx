"use client";

import { useMemo } from "react";
import { airportCandidates } from "@/lib/destination-airports";
import { didYouMean, type FuzzyCandidate } from "@/lib/fuzzy-match";
import { emptyRouteState, parseRoute } from "@/lib/route-intake";
import { WORLD_PLACES } from "@/lib/world-places";

export interface DidYouMeanHintProps {
  /** The full text the user typed (planner request or chat draft). */
  text: string;
  /** Called with the full text after only the misspelled token is replaced. */
  onAccept: (nextText: string) => void;
}

let cachedCandidates: FuzzyCandidate[] | null = null;

function allCandidates(): FuzzyCandidate[] {
  if (cachedCandidates) return cachedCandidates;
  const seen = new Set(airportCandidates().map((c) => c.label.toLowerCase()));
  const extra: FuzzyCandidate[] = [];
  for (const p of WORLD_PLACES) {
    for (const label of [p.name, p.country]) {
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push({ id: `world:${label}`, label });
    }
  }
  cachedCandidates = [...airportCandidates(), ...extra];
  return cachedCandidates;
}

/** Replace the first case-insensitive occurrence of `token` in `text`. */
function replaceToken(text: string, token: string, replacement: string): string | null {
  const at = text.toLowerCase().indexOf(token.toLowerCase());
  if (at < 0) return null;
  return text.slice(0, at) + replacement + text.slice(at + token.length);
}

export function DidYouMeanHint({ text, onAccept }: DidYouMeanHintProps) {
  const fix = useMemo(() => {
    const value = (text ?? "").trim();
    if (value.length < 4) return null;
    const route = parseRoute(value, emptyRouteState());
    const tokens = [route.origin, route.destination, route.routeCandidate].filter(
      (t): t is string => Boolean(t),
    );
    const candidates = allCandidates();
    for (const token of tokens) {
      const hit = didYouMean(token, candidates);
      if (!hit) continue;
      const next = replaceToken(text, token, hit.label);
      if (next !== null) return { typed: token, label: hit.label, next };
    }
    return null;
  }, [text]);

  if (!fix) return null;

  return (
    <p className="place-suggest__hint" role="status">
      Did you mean{" "}
      <button
        type="button"
        className="place-suggest__hint-btn"
        onClick={() => onAccept(fix.next)}
        aria-label={`Replace ${fix.typed} with ${fix.label}`}
      >
        {fix.label}
      </button>
      ?
    </p>
  );
}

export default DidYouMeanHint;
