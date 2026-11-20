"use client";

import { useEffect, useState } from "react";
import type { FocusEvent } from "react";
import { illustration } from "@/lib/illustrations";
import {
  ROTATION_INTERVAL_MS,
  removeFailed,
  shouldRotate,
  stepIndex,
  type Slide,
} from "@/lib/itinerary/carousel";

const LOCATION_PIN = illustration("location-pin");

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface DayCarouselProps {
  slides: Slide[];
  active: boolean;
}

export function DayCarousel({ slides, active }: DayCarouselProps) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const visible = removeFailed(slides, failed);
  const count = visible.length;
  const current = count > 0 ? Math.min(Math.max(index, 0), count - 1) : 0;

  const rotating = shouldRotate({ count, hovered, focused, hidden, reducedMotion, active });

  // Visibility and reduced-motion listeners (client only), removed on cleanup.
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);

    let mql: MediaQueryList | null = null;
    const onMotion = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      mql = window.matchMedia(REDUCED_MOTION_QUERY);
      setReducedMotion(mql.matches);
      mql.addEventListener("change", onMotion);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      if (mql) mql.removeEventListener("change", onMotion);
    };
  }, []);

  // Auto-advance. Depends on `current`, so any manual change restarts the interval.
  useEffect(() => {
    if (!rotating) return;
    const id = setTimeout(() => {
      setIndex(stepIndex(current, count, 1));
    }, ROTATION_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [rotating, current, count]);

  if (count === 0) {
    return (
      <div className="gpm day-hero">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="day-hero__img day-hero__img--illustration"
          src={LOCATION_PIN.src}
          alt=""
          width={LOCATION_PIN.width}
          height={LOCATION_PIN.height}
        />
      </div>
    );
  }

  const slide = visible[current];
  const multiple = count >= 2;

  const onFocus = () => setFocused(true);
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setFocused(false);
  };

  return (
    <section
      className="gpm day-carousel"
      aria-roledescription="carousel"
      aria-label="Photos for this day"
      aria-live={rotating ? "off" : "polite"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <figure
        className="day-carousel__slide"
        role="group"
        aria-roledescription="slide"
        aria-label={`${current + 1} of ${count}`}
        key={slide.ref}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="day-carousel__img"
          src={"/api/place-photo?ref=" + encodeURIComponent(slide.ref) + "&w=1280"}
          alt={(slide.name || "Place") + " - Google photo"}
          onError={() => {
            const ref = slide.ref;
            setFailed((prev) => {
              if (prev.has(ref)) return prev;
              const nextSet = new Set(prev);
              nextSet.add(ref);
              return nextSet;
            });
          }}
        />
        <figcaption className="day-carousel__caption">
          <span className="day-carousel__name">{slide.name}</span>
          {slide.time ? <span className="day-carousel__time">{slide.time}</span> : null}
        </figcaption>
      </figure>
      <span className="gpm__brand">Google</span>
      {multiple ? (
        <>
          <button
            type="button"
            className="day-carousel__btn day-carousel__btn--prev"
            aria-label="Previous photo"
            onClick={() => setIndex(stepIndex(current, count, -1))}
          >
            <span aria-hidden="true">&#8249;</span>
          </button>
          <button
            type="button"
            className="day-carousel__btn day-carousel__btn--next"
            aria-label="Next photo"
            onClick={() => setIndex(stepIndex(current, count, 1))}
          >
            <span aria-hidden="true">&#8250;</span>
          </button>
          <div className="day-carousel__dots">
            {visible.map((s, i) => (
              <button
                type="button"
                key={s.ref}
                className="day-carousel__dot"
                aria-label={`Show photo ${i + 1} of ${count}`}
                aria-current={i === current ? "true" : undefined}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export default DayCarousel;
