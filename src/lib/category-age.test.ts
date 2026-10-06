import { describe, expect, it } from "vitest";
import { ageSelectionFromPreset, customAgeSelection, isMatchingAgePreset } from "./category-age";
import { COPA_DANES_26, type TimePreset } from "./tournament-presets";

describe("age preset selection", () => {
  it.each([["Kids (4-5)","4","5"],["Infantiles (6-7)","6","7"],["Infantiles A (8-9)","8","9"],["Infantiles B (10-11)","10","11"],["Pre-Junior (12-14)","12","14"],["Junior (15-17)","15","17"],["Adultos (18-35)","18","35"],["Seniors (36-45)","36","45"]])("applies %s range", (name, from, to) => {
    const preset = COPA_DANES_26.find((item) => item.name === name)!;
    expect(ageSelectionFromPreset(preset)).toEqual({ ageFrom: from, ageTo: to, ageOpenEnded: false });
  });
  it("supports the open-ended 46+ range", () => {
    expect(ageSelectionFromPreset(COPA_DANES_26[8])).toEqual({ ageFrom: "46", ageTo: "", ageOpenEnded: true });
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
