import type { RuleSetSparring } from "@/engine/types";
import type { BracketMatch, FightEntry, TournamentConfig } from "@/store/tournament";
import { isSingleBracketFinal } from "./bracket";

/** Resolve only configured round duration/count; tiebreak and Golden Point flow stay unchanged. */
export function applyFightTiming(
  rules: RuleSetSparring,
  config: Pick<TournamentConfig, "finalRounds" | "finalSeconds">,
  fight: FightEntry,
  bracketMatches: BracketMatch[],
): RuleSetSparring {
  let timedRules = rules;
  if (fight.tiebreakerSeconds != null) {
    return {
      ...timedRules,
      rounds: { ...timedRules.rounds, count: 1, duration_seconds: fight.tiebreakerSeconds },
    };
  }
  if (fight.isGoldenPointFight) return timedRules;
  const linkedMatch = bracketMatches.find((match) => match.id === fight.bracketMatchId);
  const isFinal = fight.isFinalFight ||
    (!fight.isTiebreakExtra && !fight.isGoldenPointFight && !!linkedMatch &&
      isSingleBracketFinal(bracketMatches, linkedMatch));
  if (isFinal && config.finalRounds != null) {
    timedRules = { ...timedRules, rounds: { ...timedRules.rounds, count: config.finalRounds } };
  }
  if (isFinal && config.finalSeconds != null) {
    timedRules = {
      ...timedRules,
      rounds: { ...timedRules.rounds, duration_seconds: config.finalSeconds },
    };
  }
  return timedRules;
}

/** Null means use the category/final preset; otherwise this value belongs to one bout only. */
export function parseBoutDurationOverride(input: string | null): number | null {
  if (input === null) return null;
  const seconds = Number(input);
  if (!/^\d+$/.test(input) || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error("Ingresá una duración entre 1 y 3600 segundos para este combate.");
  }
  return seconds;
}

export function applyBoutDurationOverride(
  rules: RuleSetSparring,
  overrideSeconds: number | null,
): RuleSetSparring {
  if (overrideSeconds === null) return rules;
  return { ...rules, rounds: { ...rules.rounds, duration_seconds: overrideSeconds } };
}

/** Ordinary round-robin draws are recorded as draws, never an in-bout overtime. */
export function withoutRegularRoundRobinTiebreak(
  rules: RuleSetSparring,
  mode: TournamentConfig["mode"],
  fight: FightEntry,
): RuleSetSparring {
  if (mode === "elimination" || fight.isFinalFight || fight.isTiebreakExtra || fight.isGoldenPointFight) return rules;
  return { ...rules, rounds: { ...rules.rounds, golden_point: false, overtime_seconds: 0 } };
}
