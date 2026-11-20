"use client";

import { useSyncStatus } from "@/lib/client/use-sync-status";

/** Polite live region that reports account sync state honestly. */
export function SyncStatus() {
  const status = useSyncStatus();
  let text = "";
  switch (status.state) {
    case "saving":
      text = "Saving to your account…";
      break;
    case "saved":
      text = "Saved to your account";
      break;
    case "failed":
      text = "Couldn't save to your account.";
      break;
    case "unavailable":
      text = "Account sync is unavailable. Your trips stay on this device.";
      break;
    default:
      text = "";
  }
  const note = status.note;
  return (
    <div className="sync-status" role="status" aria-live="polite">
      {text ? <span className="sync-status__text">{text}</span> : null}
      {note ? <span className="sync-status__text"> {note}</span> : null}
      {status.state === "failed" && status.retry ? (
        <button
          type="button"
          className="sync-status__retry"
          style={{ minHeight: 44, minWidth: 44 }}
          onClick={() => status.retry?.()}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export default SyncStatus;
