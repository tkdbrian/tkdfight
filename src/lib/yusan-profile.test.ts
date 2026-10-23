import { describe, expect, it } from "vitest";
import {
  AGE_DIVISIONS,
  ageDivisionForRange,
  resolveYusanPreset,
  validateDanRange,
  validateCategoryTimingForStart,
  yusanConfigPatch,
} from "./yusan-profile";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import type { FightEntry, TournamentConfig } from "@/store/tournament";
import { applyFightTiming } from "./fight-timing";

describe("Yusan 2026 duration matrix", () => {
  const eliminations = [60, 60, 60, 60, 120, 120, 120, 90, 90];
  const finals = [60, 120, 120, 120, 120, 120, 120, 120, 120];

  AGE_DIVISIONS.forEach((age, index) => {
    it(`${age.label}: elimination, final, round robin, and white GUP override`, () => {
      const dan = { ageDivision: age.id, gradeSystem: "DAN" as const, danFrom: 1, danTo: 3 };
      const elimination = resolveYusanPreset(dan, "elimination");
      const roundRobin = resolveYusanPreset(dan, "round-robin");
      expect(elimination).toMatchObject({
        roundCount: 1,
        durationSeconds: eliminations[index],
        finalRounds: 1,
        finalSeconds: finals[index],
        tiebreakerSeconds: 60,
      });
      expect(roundRobin).toMatchObject({ durationSeconds: 60, finalSeconds: finals[index], tiebreakerSeconds: 60 });
      for (const band of ["Amarillos a Puntas Azules", "Azules a Puntas Negras"]) {
        expect(resolveYusanPreset({
          ageDivision: age.id,
          gradeSystem: "GUPS",
          gupBand: band,
        }, "elimination")).toMatchObject({
          durationSeconds: eliminations[index],
          finalSeconds: finals[index],
          tiebreakerSeconds: 60,
        });
        expect(resolveYusanPreset({
          ageDivision: age.id,
          gradeSystem: "GUPS",
          gupBand: band,
        }, "round-robin")).toMatchObject({ durationSeconds: 60, finalSeconds: finals[index], tiebreakerSeconds: 60 });
      }
      for (const mode of ["elimination", "round-robin"] as const) {
        expect(resolveYusanPreset({
          ageDivision: age.id,
          gradeSystem: "GUPS",
          gupBand: "Blancos y Puntas Amarillas",
        }, mode)).toMatchObject({
          durationSeconds: 40,
          finalSeconds: 40,
          tiebreakerSeconds: 40,
        });
      }
    });
  });

  it("requires ordered positive DAN grades and explicit dimensions", () => {
    expect(validateDanRange("", "3")).not.toBeNull();
    expect(validateDanRange("0", "3")).not.toBeNull();
    expect(validateDanRange("4", "3")).not.toBeNull();
    expect(validateDanRange("9007199254740992", "9007199254740993")).not.toBeNull();
    expect(validateDanRange("1", "12")).toBeNull();
    expect(resolveYusanPreset({ ageDivision: "kids", gradeSystem: "DAN" }, "elimination"))
      .toBeNull();
    expect(resolveYusanPreset({ ageDivision: "kids", gradeSystem: "GUPS" }, "elimination"))
      .toBeNull();
  });

  it("loads the two-group direct final at elimination-final time but keeps RR and extra times", () => {
    const base = itfRules as RuleSetSparring;
    const duel: FightEntry = {
      id: "ab", red: { id: "a", name: "A" }, blue: { id: "b", name: "B" },
      groupId: "G1", completed: false,
    };
    for (const [band, regularSeconds, finalSeconds] of [
      [undefined, 60, 120],
      ["Blancos y Puntas Amarillas", 40, 40],
    ] as const) {
      const dimensions = band
        ? { ageDivision: "infantiles-b" as const, gradeSystem: "GUPS" as const, gupBand: band }
        : { ageDivision: "infantiles-b" as const, gradeSystem: "DAN" as const, danFrom: 1, danTo: 2 };
      const preset = resolveYusanPreset(dimensions, "round-robin");
      expect(preset).not.toBeNull();
      if (!preset) continue;
      const rules = { ...base, rounds: { ...base.rounds, duration_seconds: preset.durationSeconds } };
      const config = { finalRounds: preset.finalRounds, finalSeconds: preset.finalSeconds };
      expect(applyFightTiming(rules, config, duel, []).rounds.duration_seconds).toBe(regularSeconds);
      expect(applyFightTiming(rules, config,
        { ...duel, groupId: "FINAL", isFinalFight: true }, []).rounds.duration_seconds).toBe(finalSeconds);
      expect(applyFightTiming(rules, config,
        { ...duel, isTiebreakExtra: true, tiebreakerSeconds: preset.tiebreakerSeconds }, [])
        .rounds.duration_seconds).toBe(preset.tiebreakerSeconds);
    }
  });

  it("matches structured ages, not a free-text category name", () => {
    expect(ageDivisionForRange("3", "5", false)).toBe("kids");
    expect(ageDivisionForRange("46", "", true)).toBe("veteranos");
    expect(ageDivisionForRange("46", "", false)).toBeUndefined();
  });

  it("changes timing without changing engine overtime or Golden Point behavior", () => {
    const base = itfRules as RuleSetSparring;
    const config: TournamentConfig = {
      id: "category",
      tournamentName: "Yusan",
      categoryName: "Nombre libre",
      tableChief: "",
      ruleSet: base,
      judgesCount: 4,
      mode: "elimination",
      matchType: "sparring",
    };
    const patch = yusanConfigPatch(config, {
      ageDivision: "infantiles-b",
      gradeSystem: "GUPS",
      gupBand: "Blancos y Puntas Amarillas",
    }, "elimination", base);
    expect(patch).toMatchObject({
      profileId: "yusan-2026",
      profileApplied: true,
      finalSeconds: 40,
      tiebreakerSeconds: 40,
      ruleSet: { rounds: { count: 1, duration_seconds: 40 } },
    });
    expect((patch?.ruleSet as RuleSetSparring).rounds.golden_point).toBe(base.rounds.golden_point);
    expect((patch?.ruleSet as RuleSetSparring).rounds.overtime_seconds)
      .toBe(base.rounds.overtime_seconds);
    expect(patch?.maxTiebreakers).toBeUndefined();
    expect(patch?.categoryName).toBeUndefined();
  });

  it("rejects invalid new-category and profile dimensions through the shared start guard", () => {
    const base: TournamentConfig = {
      id: "restart-category",
      tournamentName: "Yusan",
      categoryName: "Prueba",
      tableChief: "",
      ruleSet: null,
      judgesCount: 4,
      mode: "elimination",
      matchType: "sparring",
      requiresGradeSelection: true,
      profileId: "yusan-2026",
      profileApplied: true,
      ageDivision: "juniors",
    };
    expect(validateCategoryTimingForStart(base)).toBe("Elegí GUPS o DANES.");
    expect(validateCategoryTimingForStart({ ...base, gradeSystem: "DAN", danFrom: 3, danTo: 1 }))
      .not.toBeNull();
    expect(validateCategoryTimingForStart({ ...base, gradeSystem: "DAN", danFrom: 1, danTo: 3 }))
      .toBeNull();
    expect(validateCategoryTimingForStart({
      ...base, gradeSystem: "GUPS", gupBand: "Blancos y Puntas Amarillas", ageDivision: undefined,
    })).not.toBeNull();
  });
});
