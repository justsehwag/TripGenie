/**
 * Pure reducer tracking the lifecycle of assistant action proposals.
 * It never runs page handlers: the component runs the handler in its click
 * handler after dispatching `apply`, so the reducer stays side-effect free.
 */
import type { ActionProposal, PageId } from "./types";

export type ActionStatus =
  | "pending"
  | "applied"
  | "cancelled"
  | "undone"
  | "stale";

export interface ActionState {
  proposal: ActionProposal;
  status: ActionStatus;
}

export type ActionEvent =
  | { type: "receive"; proposal: ActionProposal }
  | { type: "apply"; id: string; currentPage: PageId }
  | { type: "cancel"; id: string }
  | { type: "undo"; id: string };

function update(
  state: ActionState[],
  id: string,
  next: (entry: ActionState) => ActionState,
): ActionState[] {
  const index = state.findIndex((entry) => entry.proposal.id === id);
  if (index < 0) return state;
  const current = state[index];
  const updated = next(current);
  if (updated === current) return state;
  const copy = state.slice();
  copy[index] = updated;
  return copy;
}

export function actionReducer(
  state: ActionState[],
  event: ActionEvent,
): ActionState[] {
  switch (event.type) {
    case "receive": {
      // A proposal always enters as pending; duplicate ids are ignored.
      if (state.some((entry) => entry.proposal.id === event.proposal.id)) {
        return state;
      }
      return [...state, { proposal: event.proposal, status: "pending" }];
    }
    case "apply":
      return update(state, event.id, (entry) => {
        if (entry.status !== "pending") return entry; // applied once only
        const status: ActionStatus =
          entry.proposal.page === event.currentPage ? "applied" : "stale";
        return { ...entry, status };
      });
    case "cancel":
      return update(state, event.id, (entry) =>
        entry.status === "pending" ? { ...entry, status: "cancelled" } : entry,
      );
    case "undo":
      return update(state, event.id, (entry) =>
        entry.status === "applied" ? { ...entry, status: "undone" } : entry,
      );
    default:
      return state;
  }
}
