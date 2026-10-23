import type { MatchState } from "../src/engine/types.js";
import type { MatchSnapshotData } from "./db/index.js";

/** An old RR snapshot cannot prove that previously recorded penalties are still present. */
export function recoverIndividualFlagMatchState(data: MatchSnapshotData): MatchState | null {
  const matchState = data.matchState;
  if (!matchState || !Array.isArray(matchState.rounds) ||
    !Number.isInteger(matchState.currentRound) || !Number.isFinite(matchState.timeLeft) ||
    typeof matchState.phase !== "string" ||
    matchState.rounds.some((round) => !round || !Array.isArray(round.events))) return null;
  return matchState;
}
