/**
 * Pure lifecycle helpers for the planner's generate() calls.
 *
 * Client-safe: no imports, no server code. Never throws.
 */

export type ExitKind = "continue" | "silent" | "failure";

export interface ExitInput {
  aborted: boolean;
  generationActive: boolean;
  superseded: boolean;
  unmounted: boolean;
}

/**
 * Decide what generate() does at an abort/inactive checkpoint.
 * Silent only when a newer call superseded this one or the component really
 * unmounted; otherwise an abort or inactive generation is a failure.
 */
export function classifyExit(input: ExitInput): ExitKind {
  if (input.superseded || input.unmounted) return "silent";
  if (input.aborted || !input.generationActive) return "failure";
  return "continue";
}

/**
 * Defer the unmount abort one tick so React Strict Mode's simulated
 * unmount/remount (which flips the mount flag back to true) aborts nothing.
 */
export function scheduleUnmountAbort(
  isMounted: () => boolean,
  abort: () => void,
  schedule: (fn: () => void) => unknown = (fn) => setTimeout(fn, 0),
): void {
  try {
    schedule(() => {
      try {
        if (!isMounted()) abort();
      } catch {
        /* never throw */
      }
    });
  } catch {
    /* never throw */
  }
}
