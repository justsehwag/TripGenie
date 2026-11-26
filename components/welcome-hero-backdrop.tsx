"use client";

/**
 * WelcomeHeroBackdrop - full-bleed rotating photo backdrop for the welcome
 * screen, built from the bundled manifest in lib/welcome-photos.ts.
 *
 * - Two stacked <img class="welcome-photo"> layers crossfade (CSS opacity).
 *   The next photo is preloaded with `new Image()` and only then flipped in;
 *   a photo that fails to load is skipped.
 * - The first render always uses the manifest's first photo so server and
 *   client markup match; the session shuffle happens in a mount effect.
 * - Under prefers-reduced-motion (or without matchMedia) one static photo is
 *   shown and nothing rotates.
 * - AccountHero is still given `query` so its image hook stays wired; its
 *   result is not rendered because `media` replaces the photo layer.
 */

import { useEffect, useRef, useState } from "react";
import { AccountHero } from "@/components/account-hero";
import { WELCOME_PHOTOS, nextCycle, shuffleIds } from "@/lib/welcome-photos";
import type { WelcomePhoto } from "@/lib/welcome-photos";
import {
  WELCOME_HERO_QUERIES,
  shouldAdvance,
} from "@/lib/welcome-hero-rotation";

const TICK_MS = 500;
const BY_ID = new Map<string, WelcomePhoto>(WELCOME_PHOTOS.map((p) => [p.id, p]));
const ALL_IDS = WELCOME_PHOTOS.map((p) => p.id);

function licenceHost(p: WelcomePhoto): string {
  return p.licence === "Unsplash License" ? "Unsplash" : "Pexels";
}

export function WelcomeHeroBackdrop({
  eyebrow,
  title,
  subtitle,
  points,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  points?: string[];
}) {
  // layers[i] is the photo id shown on layer i; front is the visible layer.
  const [layers, setLayers] = useState<[string | null, string | null]>([
    ALL_IDS[0] ?? null,
    null,
  ]);
  const [front, setFront] = useState<0 | 1>(0);
  // Default to reduced motion until we can confirm it is safe to animate.
  const [reducedMotion, setReducedMotion] = useState(true);

  const orderRef = useRef<string[]>(ALL_IDS);
  const posRef = useRef(0);
  const sinceRef = useRef(0);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const frontRef = useRef<0 | 1>(0);
  frontRef.current = front;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Client-only: shuffle once per mount and read the motion preference.
  useEffect(() => {
    if (ALL_IDS.length > 1) {
      const order = shuffleIds(ALL_IDS, Math.random);
      orderRef.current = order;
      posRef.current = 0;
      setLayers([order[0], null]);
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setReducedMotion(true);
    } else {
      setReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }
    sinceRef.current = Date.now();
  }, []);

  useEffect(() => {
    if (reducedMotion || ALL_IDS.length < 2) return;
    sinceRef.current = Date.now();

    const takeNextId = (): string => {
      let next = posRef.current + 1;
      if (next >= orderRef.current.length) {
        const last = orderRef.current[orderRef.current.length - 1];
        orderRef.current = nextCycle(ALL_IDS, Math.random, last);
        next = 0;
      }
      posRef.current = next;
      return orderRef.current[next];
    };

    const preload = (src: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
      });

    const advance = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        for (let attempt = 0; attempt < ALL_IDS.length; attempt++) {
          const photo = BY_ID.get(takeNextId());
          if (!photo) continue;
          const ok = await preload(photo.src);
          if (!aliveRef.current) return;
          if (!ok) continue; // skip on error
          const hidden: 0 | 1 = frontRef.current === 0 ? 1 : 0;
          setLayers((prev) => {
            const copy: [string | null, string | null] = [prev[0], prev[1]];
            copy[hidden] = photo.id;
            return copy;
          });
          // Let the hidden layer render its new src before flipping.
          await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
          if (!aliveRef.current) return;
          setFront(hidden);
          break;
        }
      } finally {
        sinceRef.current = Date.now();
        busyRef.current = false;
      }
    };

    const id = window.setInterval(() => {
      const elapsedMs = Date.now() - sinceRef.current;
      if (shouldAdvance({ elapsedMs, loaded: true, reducedMotion })) void advance();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  const current = BY_ID.get(layers[front] ?? "") ?? WELCOME_PHOTOS[0];

  const media = (
    <>
      {([0, 1] as const).map((i) => {
        const photo = layers[i] ? BY_ID.get(layers[i] as string) : undefined;
        if (!photo) return null;
        const on = front === i;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            className={on ? "welcome-photo welcome-photo--on" : "welcome-photo"}
            src={photo.src}
            alt={on ? photo.alt : ""}
            aria-hidden={on ? undefined : true}
            decoding="async"
          />
        );
      })}
      {current && (
        <p className="welcome-credit">
          Photo:{" "}
          <a href={current.sourceUrl} target="_blank" rel="noopener noreferrer">
            {current.photographer}
          </a>{" "}
          / {licenceHost(current)}
        </p>
      )}
    </>
  );

  return (
    <AccountHero
      eyebrow={eyebrow}
      title={title}
      subtitle={subtitle}
      points={points}
      query={WELCOME_HERO_QUERIES[0]}
      media={media}
    />
  );
}
