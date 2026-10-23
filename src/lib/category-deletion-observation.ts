import type { CategoryDeletionReceipt } from "@/lib/category-deletion-contract";
import { useTournamentStore } from "@/store/tournament";

/** Source lineage and the deleted execution are different identities in a terminal 410. */
export function applyCanonicalDeletionObservation(
  sourceCategoryId: string,
  receipt: CategoryDeletionReceipt
): boolean {
  const { categoryId, requestId, deletedAt } = receipt;
  return useTournamentStore
    .getState()
    .retireCategorySource(sourceCategoryId, { categoryId, requestId, deletedAt });
}
