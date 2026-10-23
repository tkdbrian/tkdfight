import type { RuleSetSparring } from "@/engine/types";
import type { BracketMatch, FightEntry, TournamentMode } from "@/store/tournament";
import { isSingleBracketFinal } from "./bracket";
import { applyBoutDurationOverride, parseBoutDurationOverride } from "./fight-timing";

export type PreFightTimingKind = "regular" | "elimination-final" | "continuation";
export function preFightTimingKind(fight: FightEntry, matches: BracketMatch[]): PreFightTimingKind {
  if (fight.isGoldenPointFight || fight.isTiebreakExtra || fight.tiebreakerSeconds != null) return "continuation";
  const linked = matches.find((match) => match.id === fight.bracketMatchId);
  return fight.isFinalFight || (linked && isSingleBracketFinal(matches, linked)) ? "elimination-final" : "regular";
}
export function applyPreFightSettings(
  rules: RuleSetSparring, seconds: string | null, rounds: number | null,
  kind: PreFightTimingKind, mode: TournamentMode,
): RuleSetSparring {
  if (kind === "continuation") return rules;
  const timed = applyBoutDurationOverride(rules, parseBoutDurationOverride(seconds));
  const count = kind === "elimination-final" ? rounds ?? timed.rounds.count : mode !== "elimination" ? 1 : timed.rounds.count;
  return { ...timed, rounds: { ...timed.rounds, count } };
}
