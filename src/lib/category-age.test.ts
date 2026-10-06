import { describe, expect, it } from "vitest";
import { ageSelectionFromCategoryName, ageSelectionFromPreset, categoryNameMatchesAgePreset, customAgeSelection, isTimePresetActive, isMatchingAgePreset } from "./category-age";
import { COPA_DANES_26, type TimePreset } from "./tournament-presets";

describe("age preset selection", () => {
  it.each([["Kids (4-5)","4","5"],["Infantiles (6-7)","6","7"],["Infantiles A (8-9)","8","9"],["Infantiles B (10-11)","10","11"],["Pre-Junior (12-14)","12","14"],["Junior (15-17)","15","17"],["Adultos (18-35)","18","35"],["Seniors (36-45)","36","45"]])("applies %s range", (name, from, to) => {
    const preset = COPA_DANES_26.find((item) => item.name === name)!;
    expect(ageSelectionFromPreset(preset)).toEqual({ ageFrom: from, ageTo: to, ageOpenEnded: false });
  });
  it("supports the open-ended 46+ range", () => {
    expect(ageSelectionFromPreset(COPA_DANES_26[8])).toEqual({ ageFrom: "46", ageTo: "", ageOpenEnded: true });
  });
  it("matches only the age embedded in the active category name", () => {
    const category = "Mediano A \u00b7 Blancos y Puntas Amarillas \u00b7 M \u00b7 8-9 a\u00f1os";
    expect(ageSelectionFromCategoryName(category)).toEqual({ ageFrom: "8", ageTo: "9", ageOpenEnded: false });
    expect(categoryNameMatchesAgePreset(COPA_DANES_26[2], category)).toBe(true);
    expect(categoryNameMatchesAgePreset(COPA_DANES_26[4], category)).toBe(false);
  });
  it("reads open-ended ages and ignores Dan belt ranges", () => {
    expect(ageSelectionFromCategoryName("Pesado \u00b7 1-2 Dan \u00b7 F \u00b7 46+ a\u00f1os")).toEqual({ ageFrom: "46", ageTo: "", ageOpenEnded: true });
    expect(ageSelectionFromCategoryName("Pesado \u00b7 1-2 Dan \u00b7 F")).toBeNull();
  });
  it("highlights exactly the selected age when rule timing is shared", () => {
    const current = { roundCount: 1, durationSeconds: 60, finalRounds: 1, finalSeconds: undefined, tiebreakerSeconds: 60, maxTiebreakers: 1 };
    const category = "Mediano A \u00b7 GUPS \u00b7 M \u00b7 8-9 a\u00f1os";
    expect(COPA_DANES_26.filter((preset) => isTimePresetActive(preset, current, category)).map((preset) => preset.name)).toEqual(["Infantiles A (8-9)"]);
  });
  it("does not mark ambiguous age presets active without category age metadata", () => {
    const current = { roundCount: 1, durationSeconds: 60, finalRounds: 1, finalSeconds: 120, tiebreakerSeconds: 60, maxTiebreakers: 1 };
    expect(COPA_DANES_26.filter((preset) => isTimePresetActive(preset, current, "")).map((preset) => preset.name)).toEqual([]);
    const saved: TimePreset = { id: 5, name: "Mis tiempos", ...current };
    expect(isTimePresetActive(saved, current, "")).toBe(true);
  });
  it("leaves age unchanged for time-only server presets", () => {
    const saved: TimePreset = { id: 4, name: "Tiempo guardado", roundCount: 1, durationSeconds: 60 };
    expect(ageSelectionFromPreset(saved)).toBeNull();
    expect(isMatchingAgePreset(saved, { ageFrom: "4", ageTo: "5", ageOpenEnded: false })).toBe(false);
  });
  it("matches a single age range and preserves values for custom editing", () => {
    const age = ageSelectionFromPreset(COPA_DANES_26[0])!;
    expect(isMatchingAgePreset(COPA_DANES_26[0], age)).toBe(true);
    expect(isMatchingAgePreset(COPA_DANES_26[1], age)).toBe(false);
    expect(customAgeSelection(age)).toEqual(age);
  });
});
