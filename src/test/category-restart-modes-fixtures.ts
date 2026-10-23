import { createRestartReplacement } from "@/lib/category-lifecycle";
import type { CategoryDeleteAndRestartSuccess } from "@/lib/category-restart-modes-contract";
import type { TournamentCategorySnapshot } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

export function deleteAndRestartReceipt(
  previous: TournamentCategorySnapshot = recordedCategory()
): CategoryDeleteAndRestartSuccess {
  const replacementSnapshot = createRestartReplacement(previous);
  const requestId = crypto.randomUUID();
  return {
    ok: true,
    requestId,
    categoryId: previous.config.id,
    replacementCategoryId: replacementSnapshot.config.id,
    replacementSnapshot,
    deletion: {
      ok: true,
      requestId,
      categoryId: previous.config.id,
      tournamentId: null,
      deletedAt: "2026-10-23T00:00:00.000Z",
      counts: {
        competitors: previous.competitors.length,
        fights: previous.fights.length,
        completedFights: previous.fights.filter((fight) => fight.completed).length,
        confirmedResults: 0,
        localOnlyFights: previous.fights.length,
      },
    },
  };
}
