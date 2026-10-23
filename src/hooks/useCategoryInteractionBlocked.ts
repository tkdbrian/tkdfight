import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { useTournamentPersistenceState } from "@/lib/tournament-persistence";

export function useCategoryInteractionBlocked(): boolean {
  const restarting = useCategoryRestartState((state) => state.pending || state.recoveryRequired);
  const deleting = useCategoryDeletionState((state) => state.pending || state.recoveryRequired);
  const persistence = useTournamentPersistenceState((state) => state.blocked);
  return restarting || deleting || persistence;
}
