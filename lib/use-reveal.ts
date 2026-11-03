"use client";

import { useEffect, useRef } from "react";

/**
 * useReveal — tiny, dependency-free scroll-reveal hook (Task 4.1).
 *
 * Attach the returned ref to an element that also carries the `.reveal` class.
 * When the element scrolls into view, the `reveal--in` class is added once and
 * the element is unobserved. The CSS in app/globals.css handles the actual
 * transition (opacity + translateY), honoring prefers-reduced-motion.
 *
 * Behavior:
 * - SSR-safe: does no work during server render; all logic runs in useEffect
 *   after mount and guards `typeof window` / IntersectionObserver availability.
 * - Reduced motion: if the user prefers reduced motion, the final state is shown
 *   immediately (class added on mount) with no reliance on intersection.
 * - No IntersectionObserver: falls back to showing the final state immediately
 *   so content is never left hidden.
 * - One observer per element, disconnected after the first reveal and on unmount.
 *
 * @param options.rootMargin  IntersectionObserver rootMargin (default "0px 0px -10% 0px").
 * @param options.threshold   IntersectionObserver threshold (default 0.15).
 * @returns a ref to attach to the element to reveal.
 */
export interface UseRevealOptions {
  rootMargin?: string;
  threshold?: number;
}

const REVEAL_IN_CLASS = "reveal--in";

export function useReveal<T extends HTMLElement = HTMLElement>(
  options: UseRevealOptions = {},
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Guard against non-browser environments.
    if (typeof window === "undefined") return;

    const reveal = () => el.classList.add(REVEAL_IN_CLASS);

    // Respect reduced motion: show the final state immediately, no animation gating.
    const prefersReduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || typeof IntersectionObserver === "undefined") {
      reveal();
      return;
    }

    // Already in view on mount? Reveal without waiting for a scroll.
    const observer = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            reveal();
            obs.unobserve(entry.target);
            obs.disconnect();
            break;
          }
        }
      },
      {
        rootMargin: options.rootMargin ?? "0px 0px -10% 0px",
        threshold: options.threshold ?? 0.15,
      },
    );

    observer.observe(el);

    return () => observer.disconnect();
    // rootMargin/threshold are read once on mount; intentionally not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return ref;
}

export default useReveal;
