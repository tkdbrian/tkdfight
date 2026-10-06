import { describe, expect, it } from "vitest";
import {
  COPA_DANES_26,
  getPresetForCategoryAge,
  getPresetForCategoryFormat,
  type TimePreset,
} from "./tournament-presets";

describe("category time presets", () => {
  it("defines the expected age group names and ranges", () => {
    expect(COPA_DANES_26.map(({ name, ageFrom, ageTo }) => [name, ageFrom, ageTo])).toEqual([
      ["Kids (4-5)", 4, 5],
      ["Infantiles A (6-7)", 6, 7],
      ["Infantiles B (8-9)", 8, 9],
      ["Infantiles C (10-11)", 10, 11],
      ["Pre-Junior (12-14)", 12, 14],
      ["Junior (15-17)", 15, 17],
      ["Adultos (18-35)", 18, 35],
      ["Seniors (36-45)", 36, 45],
      ["Veteranos (46+)", 46, undefined],
    ]);
  });

  it.each([
    ["Pre-Junior (12-14)", 120, 120],
    ["Junior (15-17)", 120, 120],
    ["Adultos (18-35)", 120, 120],
    ["Seniors (36-45)", 90, 120],
    ["Veteranos (46+)", 90, 120],
  ])("%s has the requested elimination and final times", (name, roundSeconds, finalSeconds) => {
    const preset = COPA_DANES_26.find((item) => item.name === name);
    expect(preset?.durationSeconds).toBe(roundSeconds);
    expect(preset?.finalSeconds).toBe(finalSeconds);
  });

  it.each(["Kids (4-5)", "Infantiles A (6-7)", "Infantiles B (8-9)", "Infantiles C (10-11)"])(
    "%s keeps one-minute eliminations and final",
    (name) => {
      const preset = COPA_DANES_26.find((item) => item.name === name);
      expect(preset?.durationSeconds).toBe(60);
      expect(preset?.finalSeconds).toBeUndefined();
    },
  );

  it.each([
    ["4", "Kids (4-5)"],
    ["6", "Kids (4-5)"],
    ["8", "Kids (4-5)"],
    ["10", "Kids (4-5)"],
    ["12", "Pre-Junior (12-14)"],
    ["18", "Pre-Junior (12-14)"],
    ["36", "Seniors (36-45)"],
    ["46", "Veteranos (46+)"],
  ])("uses age %s to select an elimination default", (ageFrom, expectedName) => {
    expect(getPresetForCategoryAge(ageFrom)?.name).toBe(expectedName);
  });

  it("uses one-minute rounds for every category in Round Robin without replacing final or tie defaults", () => {
    const preset = COPA_DANES_26.find((item) => item.name === "Seniors (36-45)")!;
    expect(getPresetForCategoryFormat(preset, "round-robin")).toMatchObject({
      roundCount: 1,
      durationSeconds: 60,
      finalRounds: 1,
      finalSeconds: 120,
      tiebreakerSeconds: 60,
      maxTiebreakers: 1,
    });
  });

  it("keeps time-only server presets independent of age-based format defaults", () => {
    const serverPreset: TimePreset = {
      id: 7,
      name: "Mi regla guardada",
      roundCount: 2,
      durationSeconds: 90,
      finalRounds: 1,
      finalSeconds: 120,
    };
    expect(getPresetForCategoryFormat(serverPreset, "round-robin")).toEqual(serverPreset);
    expect(getPresetForCategoryAge("")).toBeNull();
  });
});
