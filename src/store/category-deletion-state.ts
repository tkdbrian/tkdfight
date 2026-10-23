import { create } from "zustand";
import type { CategoryDeletionTombstone } from "@/lib/category-deletion-contract";

export const PENDING_CATEGORY_DELETION_KEY = "tkd-pending-category-deletion-v1";
interface CategoryDeletionState {
  pending: boolean;
  recoveryRequired: boolean;
  message: string | null;
  observed: readonly CategoryDeletionTombstone[];
}
function hasRecovery(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(PENDING_CATEGORY_DELETION_KEY) !== null
    );
  } catch {
    return true;
  }
}
export const useCategoryDeletionState = create<CategoryDeletionState>(() => ({
  pending: false,
  recoveryRequired: hasRecovery(),
  message: null,
  observed: [],
}));
export function categoryDeletionInteractionBlocked(): boolean {
  const state = useCategoryDeletionState.getState();
  return state.pending || state.recoveryRequired || hasRecovery();
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key !== PENDING_CATEGORY_DELETION_KEY || useCategoryDeletionState.getState().pending)
      return;
    useCategoryDeletionState.setState({
      recoveryRequired: event.newValue !== null,
      message:
        event.newValue === null
          ? null
          : "Otra ventana está resolviendo una eliminación. Solo lectura.",
    });
  });
