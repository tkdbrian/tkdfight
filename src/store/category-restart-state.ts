import { create } from "zustand";
import { pendingDeleteAndRestartSource } from "@/lib/category-restart-journal";
import { categoryDeletionInteractionBlocked } from "@/store/category-deletion-state";
import { tournamentPersistenceBlocked } from "@/lib/tournament-persistence";

interface CategoryRestartState {
  pending: boolean;
  recoveryRequired: boolean;
  message: string | null;
  pendingDeleteAndRestartSourceId: string | null;
}

export const PENDING_CATEGORY_RESTART_KEY = "tkd-pending-category-restart-v1";

function hasPendingRecovery(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(PENDING_CATEGORY_RESTART_KEY) !== null
    );
  } catch {
    return false;
  }
}

/** Interaction state must never pass through the persisted tournament middleware. */
export const useCategoryRestartState = create<CategoryRestartState>(() => ({
  pending: false,
  recoveryRequired: hasPendingRecovery(),
  message: null,
  pendingDeleteAndRestartSourceId: pendingDeleteAndRestartSource(),
}));

export function categoryRestartInteractionBlocked(): boolean {
  const state = useCategoryRestartState.getState();
  return state.pending || state.recoveryRequired || hasPendingRecovery() || categoryDeletionInteractionBlocked() || tournamentPersistenceBlocked();
}

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== PENDING_CATEGORY_RESTART_KEY || useCategoryRestartState.getState().pending) return;
  useCategoryRestartState.setState({ recoveryRequired: event.newValue !== null,
    ...(event.newValue === null ? { pendingDeleteAndRestartSourceId: null } : {}),
    message: event.newValue === null ? null : "Otra ventana está resolviendo un reinicio. Solo lectura." });
});
