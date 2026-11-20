"use client";

/**
 * Client hook for the per-day "Misc (AI estimate)" line.
 * Requests one estimate per distinct day key, one at a time, never retries,
 * and stores { status: "unavailable" } on any failure. Imports only the
 * client-safe shared module, never lib/bedrock-model.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TripDay } from "@/lib/types";
import {
  miscCacheKey,
  parseMiscResult,
  type MiscResult,
} from "@/lib/itinerary/misc-estimate-shared";

export const MISC_CLIENT_TIMEOUT_MS = 20_000;

export type MiscEntry = MiscResult | "loading";

/** Cache key for one day. Use it to read `misc[key]` in the Planner. */
export function miscKeyForDay(
  day: Pick<TripDay, "activities">,
  destination: string,
  travellers: number,
): string {
  return miscCacheKey(
    destination,
    travellers,
    (day.activities ?? []).map((a) => ({ placeId: a.placeId, title: a.title })),
  );
}

const UNAVAILABLE: MiscResult = { status: "unavailable" };

async function requestEstimate(
  day: TripDay,
  destination: string,
  travellers: number,
  controller: AbortController,
): Promise<MiscResult> {
  const timer = setTimeout(() => controller.abort(), MISC_CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        action: "misc-estimate",
        destination,
        travellers,
        stops: day.activities.map((a) => ({
          name: a.title,
          ...(a.placeId ? { placeId: a.placeId } : {}),
          ...(a.costClass ? { kind: a.costClass } : {}),
          ...(typeof a.travelToNextMin === "number"
            ? { travelMin: a.travelToNextMin }
            : {}),
        })),
      }),
    });
    if (!res.ok) return UNAVAILABLE;
    return parseMiscResult(await res.json());
  } catch {
    return UNAVAILABLE;
  } finally {
    clearTimeout(timer);
  }
}

export function useMiscEstimates(
  days: TripDay[],
  destination: string,
  travellers: number,
): Record<string, MiscEntry> {
  const [misc, setMisc] = useState<Record<string, MiscEntry>>({});
  const inFlight = useRef<Set<string>>(new Set());
  const done = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  const running = useRef(false);
  const cancelled = useRef<WeakSet<AbortController>>(new WeakSet());
  const controllerRef = useRef<AbortController | null>(null);
  const latest = useRef({ days, destination, travellers });
  latest.current = { days, destination, travellers };

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (mounted.current) {
        const { days: ds, destination: dest, travellers: n } = latest.current;
        const next = ds.find((d) => {
          if (!d.activities || d.activities.length === 0) return false;
          const k = miscKeyForDay(d, dest, n);
          return !done.current.has(k) && !inFlight.current.has(k);
        });
        if (!next) break;
        const key = miscKeyForDay(next, dest, n);
        inFlight.current.add(key);
        setMisc((prev) => ({ ...prev, [key]: "loading" }));
        const controller = new AbortController();
        controllerRef.current = controller;
        const result = await requestEstimate(next, dest, n, controller);
        controllerRef.current = null;
        inFlight.current.delete(key);
        if (cancelled.current.has(controller) || !mounted.current) continue;
        done.current.add(key);
        setMisc((prev) => ({ ...prev, [key]: result }));
      }
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const c = controllerRef.current;
      if (c) {
        cancelled.current.add(c);
        c.abort();
      }
    };
  }, []);

  useEffect(() => {
    void pump();
  }, [days, destination, travellers, pump]);

  return misc;
}
