/**
 * Pure keyboard navigation for the place suggestion combobox.
 *
 * Invariants:
 *  - `active` is always in [-1, length - 1]; -1 means "no option highlighted".
 *  - `text` (what the user typed) changes only on `input` (user typing) or
 *    `accept`. Arrow, Home, End and Escape never touch it.
 *  - Arrow keys do not wrap.
 */

export interface SuggestNavState {
  /** The text in the input. */
  text: string;
  /** Index of the highlighted option, or -1 for none. */
  active: number;
  /** Whether the listbox is open. */
  open: boolean;
}

export type SuggestNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "Escape";

export type SuggestNavAction =
  | { type: "key"; key: SuggestNavKey; length: number }
  | { type: "input"; text: string }
  | { type: "accept"; value: string };

export const initialSuggestNavState: SuggestNavState = {
  text: "",
  active: -1,
  open: false,
};

function clampActive(active: number, length: number): number {
  const max = Math.max(0, Math.floor(Number.isFinite(length) ? length : 0)) - 1;
  if (max < 0) return -1;
  if (!Number.isFinite(active)) return -1;
  return Math.min(Math.max(Math.trunc(active), -1), max);
}

export function suggestReducer(
  state: SuggestNavState,
  action: SuggestNavAction,
): SuggestNavState {
  switch (action.type) {
    case "input":
      return { text: action.text, active: -1, open: true };
    case "accept":
      return { text: action.value, active: -1, open: false };
    case "key": {
      const length = Math.max(
        0,
        Math.floor(Number.isFinite(action.length) ? action.length : 0),
      );
      const current = clampActive(state.active, length);
      switch (action.key) {
        case "ArrowDown":
          return {
            ...state,
            open: length > 0 ? true : state.open,
            active: length === 0 ? -1 : Math.min(current + 1, length - 1),
          };
        case "ArrowUp":
          return { ...state, active: Math.max(current - 1, -1) };
        case "Home":
          return { ...state, active: length === 0 ? -1 : 0 };
        case "End":
          return { ...state, active: length === 0 ? -1 : length - 1 };
        case "Escape":
          return { ...state, open: false, active: -1 };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}
