import type { MatchState } from "../src/engine/types.js";
import type { MatchSnapshotData } from "./db/index.js";

/** Older Tul results had no separate phase; a reopened rest state means voting. */
export function recoverTulPhase(data: MatchSnapshotData): 'idle' | 'voting' | 'finished' {
  if (data.match.matchMode !== 'tul') return 'idle';
  if (data.matchState?.phase === 'finished') return 'finished';
  if (data.matchState?.phase === 'rest') return 'voting';
  return data.tulPhase === 'voting' ? 'voting' : 'idle';
}

/** An old RR snapshot cannot prove that previously recorded penalties are still present. */
export function recoverIndividualFlagMatchState(data: MatchSnapshotData): MatchState | null {
  const matchState = data.matchState;
  if (!matchState || !Array.isArray(matchState.rounds) ||
    !Number.isInteger(matchState.currentRound) || !Number.isFinite(matchState.timeLeft) ||
    typeof matchState.phase !== "string" ||
    matchState.rounds.some((round) => !round || !Array.isArray(round.events))) return null;
  return matchState;
}
