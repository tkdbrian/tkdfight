import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";

export function useCategoryInteractionBlocked(): boolean {
  const restarting = useCategoryRestartState((state) => state.pending || state.recoveryRequired);
  const deleting = useCategoryDeletionState((state) => state.pending || state.recoveryRequired);
  return restarting || deleting;
}
