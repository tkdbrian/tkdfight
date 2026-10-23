import { describe, expect, it } from "vitest";
import baselineRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import type { CompetitorEntry, FightEntry } from "@/store/tournament";
import {
  generateDoubleBracket,
  generateEliminationBracket,
  getActiveBracketFights,
  isSingleBracketFinal,
} from "./bracket";
import {
  applyBoutDurationOverride,
  applyFightTiming,
  parseBoutDurationOverride,
  withoutRegularRoundRobinTiebreak,
} from "./fight-timing";

const rules = baselineRules as RuleSetSparring;
const config = { finalRounds: 1, finalSeconds: 120 };
const competitors: CompetitorEntry[] = Array.from({ length: 18 }, (_, index) => ({
  id: `competitor-${index}`,
  name: `Competidor ${index}`,
}));

function fight(id: string, bracketMatchId?: string, isFinalFight?: boolean): FightEntry {
  return {
    id,
    red: competitors[0],
    blue: competitors[1],
    bracketMatchId,
    isFinalFight,
    completed: false,
  };
}

describe("configured final timing", () => {
  it("sends finalSeconds for an automatically generated single-bracket final", () => {
    const { matches } = generateEliminationBracket(competitors.slice(0, 4));
    const final = matches.find((match) => match.round === 1);
    expect(final).toBeDefined();
    if (!final) return;
    const ready = matches.map((match) => match.id === final.id
      ? { ...match, red: { competitor: competitors[0] }, blue: { competitor: competitors[1] } }
      : { ...match, completed: true });
    const [finalFight] = getActiveBracketFights(ready, []);
    expect(finalFight.isFinalFight).toBe(true);
    expect(applyFightTiming(rules, config, finalFight, ready).rounds.duration_seconds).toBe(120);
  });

  it("uses finalSeconds for manual and legacy single-bracket final selection", () => {
    const { matches } = generateEliminationBracket(competitors.slice(0, 4));
    const final = matches.find((match) => match.round === 1);
    expect(final).toBeDefined();
    if (!final) return;
    expect(isSingleBracketFinal(matches, final)).toBe(true);
    expect(applyFightTiming(rules, config, fight("manual", final.id, true), matches)
      .rounds.duration_seconds).toBe(120);
    expect(applyFightTiming(rules, config, fight("legacy", final.id), matches)
      .rounds.duration_seconds).toBe(120);
  });

  it("keeps side finals at normal time but times the A-versus-B final at finalSeconds", () => {
    const { matches } = generateDoubleBracket(competitors);
    const sideFinal = matches.find((match) => match.bracketGroup === "A" &&
      match.round === Math.max(...matches.filter((candidate) => candidate.bracketGroup === "A")
        .map((candidate) => candidate.round)));
    expect(sideFinal).toBeDefined();
    if (!sideFinal) return;
    expect(isSingleBracketFinal(matches, sideFinal)).toBe(false);
    expect(applyFightTiming(rules, config, fight("side", sideFinal.id), matches)
      .rounds.duration_seconds).toBe(rules.rounds.duration_seconds);
    expect(applyFightTiming(rules, config, fight("ab-final", undefined, true), matches)
      .rounds.duration_seconds).toBe(120);
  });

  it("keeps explicit final tiebreak duration ahead of finalSeconds", () => {
    const final = fight("final", undefined, true);
    expect(applyFightTiming(rules, config, final, []).rounds.duration_seconds).toBe(120);
    for (const seconds of [60, 40]) {
      const extra = { ...fight(`extra-${seconds}`, undefined, true), isTiebreakExtra: true, tiebreakerSeconds: seconds };
      const actual = applyFightTiming(rules, config, extra, []);
      expect(actual.rounds).toMatchObject({ count: 1, duration_seconds: seconds });
    }
    const golden = { ...fight("gp", undefined, true), isGoldenPointFight: true };
    expect(applyFightTiming(rules, config, golden, []).rounds.duration_seconds).toBe(rules.rounds.duration_seconds);
  });
});

describe("single-bout pre-load duration correction", () => {
  it("overrides only the selected bout rules without changing its preset or another bout", () => {
    const firstFight = fight("first");
    const preset = applyFightTiming(rules, config, firstFight, []);
    const corrected = applyBoutDurationOverride(preset, parseBoutDurationOverride("75"));
    const nextBout = applyFightTiming(rules, config, fight("second"), []);
    expect(corrected.rounds.duration_seconds).toBe(75);
    expect(preset.rounds.duration_seconds).toBe(rules.rounds.duration_seconds);
    expect(nextBout.rounds.duration_seconds).toBe(rules.rounds.duration_seconds);
  });

  it("can correct a final after finalSeconds is resolved", () => {
    const original = applyFightTiming(rules, config, fight("final", undefined, true), []);
    const corrected = applyBoutDurationOverride(original, parseBoutDurationOverride("105"));
    expect(original.rounds.duration_seconds).toBe(120);
    expect(corrected.rounds.duration_seconds).toBe(105);
  });

  it("uses preset when untouched and rejects invalid durations", () => {
    expect(applyBoutDurationOverride(rules, parseBoutDurationOverride(null))).toBe(rules);
    for (const input of ["", "0", "1.5", "-5", "3601", "abc"]) {
      expect(() => parseBoutDurationOverride(input)).toThrow();
    }
  });
});

describe("ordinary round-robin draw", () => {
  it("disables in-bout overtime only for regular round-robin fights", () => {
    const preset = { ...rules, rounds: { ...rules.rounds, golden_point: true, overtime_seconds: 60 } };
    const normal = withoutRegularRoundRobinTiebreak(preset, "round-robin", fight("regular"));
    expect(normal.rounds).toMatchObject({ golden_point: false, overtime_seconds: 0 });
    expect(withoutRegularRoundRobinTiebreak(preset, "round-robin", { ...fight("final"), isFinalFight: true })).toBe(preset);
    expect(withoutRegularRoundRobinTiebreak(preset, "round-robin", { ...fight("extra"), isTiebreakExtra: true })).toBe(preset);
    expect(withoutRegularRoundRobinTiebreak(preset, "elimination", fight("elim"))).toBe(preset);
  });
});
