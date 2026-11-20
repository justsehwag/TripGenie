"use client";

import { useEffect, useRef, useState } from "react";
import { TOAST_MS, type ToastModel } from "@/lib/save-feedback";

export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastModel | null;
  onDismiss: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const id = toast ? toast.id : null;

  // A new toast always starts unpaused with a fresh timer.
  useEffect(() => {
    setPaused(false);
  }, [id]);

  useEffect(() => {
    if (id === null || paused) return;
    const timer = setTimeout(() => dismissRef.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, paused]);

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast ? (
        <div
          key={toast.id}
          className={`toast is-${toast.kind}`}
          onPointerEnter={() => setPaused(true)}
          onPointerLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={() => setPaused(false)}
        >
          <span className="toast__message">{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
