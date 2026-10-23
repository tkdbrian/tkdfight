import { generateGroupsTournament } from "@/lib/bracket";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import type { RestartCategorySuccess } from "@/lib/category-restart-contract";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";
export function recordedCategory(count = 3): TournamentCategorySnapshot {
  const config = useTournamentStore.getState().config;
  const competitors = Array.from({ length: count }, (_, i) => ({
    id: `entrant-${i}`,
    name: `Persona ${i}`,
    team: "Equipo",
    weight: 40 + i,
  }));
  const generated =
    count <= 12 ? generateGroupsTournament(competitors) : { groups: [], fights: [] };
  return {
    config: {
      ...config,
      id: "category-old",
      eventId: "event-kept",
      categoryName: "Mayores",
      mode: "round-robin",
      finalSeconds: 177,
    },
    competitors,
    ...generated,
    phase: "results",
    currentFightIndex: 2,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}

export function restartReceipt(): RestartCategorySuccess {
  const previous = recordedCategory();
  const replacementSnapshot = createRestartReplacement(previous);
  const requestId = crypto.randomUUID();
  return {
    ok: true,
    requestId,
    categoryId: previous.config.id,
    replacementCategoryId: replacementSnapshot.config.id,
    replacementSnapshot,
    archive: {
      categoryId: previous.config.id,
      replacementCategoryId: replacementSnapshot.config.id,
      requestId,
      archivedAt: "2026-10-22T00:00:00.000Z",
      sourceTournamentId: 1,
      replacementTournamentId: 2,
      provenance: "as-recorded",
      warnings: ["Resultados locales conservados"],
    },
  };
}
