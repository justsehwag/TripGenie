"use client";

/**
 * History_Drawer — the accessible top-left drawer that lists the current
 * Scope's Drafts, Saved plans, and Confirmed bookings (design section
 * "Components and Interfaces" §6 "history-drawer.tsx"; Requirements 3.3, 3.4,
 * 3.5, 3.7, 3.9, 3.10, 3.11, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.10, 4.11, 4.12,
 * 4.13).
 *
 * Data comes exclusively from `useScopedHistory()` — guest Scope reads the
 * device-only Local_Store, signed-in Scope reads the owner-scoped `/api/trips`
 * Trip_Store. Nothing here fabricates data: every rendered item is a real
 * StoredTrip record returned by the hook. This module imports ONLY client-safe
 * modules and never touches a server-only secret.
 *
 * Accessibility (R4.10–R4.13):
 *   • The panel is `role="dialog"` + `aria-modal="true"`, labelled by its
 *     heading (`aria-labelledby`).
 *   • On open, focus moves into the panel (the close button) and Tab is trapped
 *     within the panel (first/last focusable cycling).
 *   • Escape closes via `onClose`. The parent (global-nav) owns focus-return to
 *     the trigger; this component never steals focus while closed and renders an
 *     inert hidden container when `open` is false.
 *
 * Reduced motion (R4.12) is handled entirely in CSS via
 * `@media (prefers-reduced-motion: reduce)` (added in task 11); no inline
 * animation is applied here. Visual classes are the new semantic
 * `history-drawer*` names (styled in task 11) alongside existing reusable
 * classes (`card`, `cta`, `btn`).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import type { IdentitySession } from "@/lib/identity";
import type { StoredTrip } from "@/lib/trip-retention";
import { useTripContext } from "@/components/trip-context";
import { useScopedHistory } from "@/components/use-scoped-history";

export interface HistoryDrawerProps {
  /** Whether the drawer is open. When false the component renders inert. */
  open: boolean;
  /** Close the drawer. The parent owns returning focus to the trigger. */
  onClose: () => void;
  /**
   * Optional session override, passed straight through to `useScopedHistory`
   * for test parity with my-trips-client.tsx / global-nav.tsx. `undefined`
   * reads browser-local storage; `null` forces an explicitly-anonymous Scope.
   */
  sessionOverride?: IdentitySession | null;
}

/** The selectors used to find focusable descendants for the focus trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** Format an ISO timestamp for display; returns null for an unparseable value. */
function formatDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Render a stored payload value as a short, legible string (never throws). */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

export default function HistoryDrawer({
  open,
  onClose,
  sessionOverride,
}: HistoryDrawerProps) {
  const router = useRouter();
  const h = useScopedHistory(sessionOverride);
  const { setContext, setDates, setItinerary, setUserInitiated } =
    useTripContext();

  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const headingId = "history-drawer-heading";

  // Which item has its inline detail panel expanded (View toggles this).
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  // An inline restore error shown in-drawer when a resume cannot be restored.
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Move focus into the panel when it opens; do not steal focus when closed.
  useEffect(() => {
    if (!open) return;
    // Prefer the close button; fall back to the panel container.
    const target = closeRef.current ?? panelRef.current;
    target?.focus();
  }, [open]);

  // Trap Tab within the panel and close on Escape while open.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === closeRef.current);
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  /** View: toggle an inline detail panel (no navigation). */
  const onView = useCallback((tripId: string) => {
    setOpenItemId((current) => (current === tripId ? null : tripId));
  }, []);

  /**
   * Edit: rename via window.prompt, then save keyed on the item's own
   * clientDraftId (guest → Local_Store automatically via the hook). The stored
   * payload is reused unchanged so no plan data is lost.
   */
  const onEdit = useCallback(
    (item: StoredTrip) => {
      const next =
        typeof window !== "undefined"
          ? window.prompt("Rename this plan", item.name)
          : null;
      const name = next?.trim();
      if (!name || name === item.name) return;
      void h.save({
        owner: item.owner,
        clientDraftId: item.clientDraftId,
        name,
        status: item.status,
        payload: item.payload,
        ttl: item.ttl,
      });
    },
    [h],
  );

  /**
   * Continue/Resume: reconstruct the CapturedPlan via the hook, apply it to the
   * Shared_Trip_Context, mark the plan user-initiated, then route to
   * /plan?trip=<tripId> and close. On a restore failure (null plan) keep the
   * drawer open, retain the current plan state, and show an inline error.
   */
  const onResume = useCallback(
    (tripId: string) => {
      setRestoreError(null);
      const plan = h.resume(tripId);
      if (plan === null) {
        setRestoreError(
          "We could not restore this plan. Your current plan was kept.",
        );
        return;
      }
      setContext(plan.context);
      setDates(plan.dates);
      setItinerary(plan.itinerary ?? null);
      setUserInitiated(true);
      router.push(`/plan?trip=${encodeURIComponent(tripId)}`);
      onClose();
    },
    [h, setContext, setDates, setItinerary, setUserInitiated, router, onClose],
  );

  /** Delete: confirm, then remove by tripId (other items are kept). */
  const onDelete = useCallback(
    (item: StoredTrip) => {
      if (
        typeof window !== "undefined" &&
        !window.confirm(`Delete "${item.name}"?`)
      ) {
        return;
      }
      void h.remove(item.tripId);
    },
    [h],
  );

  // Order each section most-recently-updated first (hook may already; sort
  // defensively so rendering never relies on store order).
  const byUpdatedDesc = useCallback(
    (a: StoredTrip, b: StoredTrip) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    [],
  );
  const drafts = useMemo(
    () => [...h.drafts].sort(byUpdatedDesc),
    [h.drafts, byUpdatedDesc],
  );
  const history = useMemo(
    () => [...h.history].sort(byUpdatedDesc),
    [h.history, byUpdatedDesc],
  );
  const bookings = useMemo(
    () => [...h.bookings].sort(byUpdatedDesc),
    [h.bookings, byUpdatedDesc],
  );

  const isEmpty =
    drafts.length === 0 && history.length === 0 && bookings.length === 0;

  // Render an inert hidden container when closed (no focus, no interaction).
  if (!open) {
    return <div className="history-drawer" hidden aria-hidden="true" />;
  }

  return (
    <div className="history-drawer" onKeyDown={onKeyDown}>
      {/* Backdrop — a click closes the drawer (parent returns focus). */}
      <div
        className="history-drawer__backdrop is-open"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="history-drawer__panel is-open"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
      >
        <div className="history-drawer__head">
          <h2 id={headingId} className="history-drawer__title">
            Your plans
          </h2>
          <button
            type="button"
            ref={closeRef}
            className="history-drawer__close"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="history-drawer__body">
          {h.loading && (
            <p className="history-drawer__status" aria-live="polite">
              Loading your plans…
            </p>
          )}

          {!h.loading && h.error && (
            <div className="history-drawer__status" role="alert">
              <p>{h.error}</p>
              <button
                type="button"
                className="cta"
                onClick={() => void h.reload()}
              >
                Try again
              </button>
            </div>
          )}

          {restoreError && (
            <p className="history-drawer__status" role="alert">
              {restoreError}
            </p>
          )}

          {!h.loading && !h.error && isEmpty && (
            <p className="history-drawer__empty">
              No saved plans yet. Start a trip to see it here.
            </p>
          )}

          {!h.loading && !h.error && !isEmpty && (
            <>
              <HistorySection
                title="Drafts"
                items={drafts}
                resumable
                openItemId={openItemId}
                onView={onView}
                onEdit={onEdit}
                onResume={onResume}
                onDelete={onDelete}
              />
              <HistorySection
                title="Saved"
                items={history}
                resumable
                openItemId={openItemId}
                onView={onView}
                onEdit={onEdit}
                onResume={onResume}
                onDelete={onDelete}
              />
              <HistorySection
                title="Confirmed bookings"
                items={bookings}
                resumable={false}
                openItemId={openItemId}
                onView={onView}
                onEdit={onEdit}
                onResume={onResume}
                onDelete={onDelete}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One labelled section (Drafts / Saved / Confirmed bookings). */
function HistorySection({
  title,
  items,
  resumable,
  openItemId,
  onView,
  onEdit,
  onResume,
  onDelete,
}: {
  title: string;
  items: StoredTrip[];
  resumable: boolean;
  openItemId: string | null;
  onView: (tripId: string) => void;
  onEdit: (item: StoredTrip) => void;
  onResume: (tripId: string) => void;
  onDelete: (item: StoredTrip) => void;
}) {
  if (items.length === 0) return null;
  const headingId = `history-section-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <section className="history-drawer__section" aria-labelledby={headingId}>
      <h3 id={headingId} className="history-drawer__section-title">
        {title}
      </h3>
      <ul className="history-drawer__list">
        {items.map((item) => (
          <li key={item.tripId}>
            <HistoryItem
              item={item}
              resumable={resumable}
              open={openItemId === item.tripId}
              onView={() => onView(item.tripId)}
              onEdit={() => onEdit(item)}
              onResume={() => onResume(item.tripId)}
              onDelete={() => onDelete(item)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A single history/draft/booking item with its actions and inline detail. */
function HistoryItem({
  item,
  resumable,
  open,
  onView,
  onEdit,
  onResume,
  onDelete,
}: {
  item: StoredTrip;
  resumable: boolean;
  open: boolean;
  onView: () => void;
  onEdit: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const detailId = `history-detail-${item.tripId}`;
  const updated = formatDate(item.updatedAt);

  return (
    <article className="card history-drawer__item">
      <div className="history-drawer__item-head">
        <h4 className="history-drawer__item-title">{item.name}</h4>
        {updated && (
          <span className="history-drawer__item-updated">Updated {updated}</span>
        )}
      </div>

      <div className="history-drawer__actions">
        <button
          type="button"
          className="btn"
          onClick={onView}
          aria-expanded={open}
          aria-controls={detailId}
        >
          {open ? "Hide details" : "View"}
        </button>
        {resumable && (
          <button type="button" className="cta" onClick={onResume}>
            Continue
          </button>
        )}
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn" onClick={onDelete}>
          Delete
        </button>
      </div>

      {open && (
        <div id={detailId} className="history-drawer__detail">
          <HistoryPayload payload={item.payload} />
        </div>
      )}
    </article>
  );
}

/** Render the stored payload summary (sensitive fields are already stripped). */
function HistoryPayload({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload ?? {});
  if (entries.length === 0) {
    return (
      <p className="history-drawer__payload-empty">
        No saved details for this plan yet.
      </p>
    );
  }
  return (
    <dl className="history-drawer__detail-list">
      {entries.map(([key, value]) => (
        <div className="row" key={key}>
          <dt>{key}</dt>
          <dd>{renderValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
