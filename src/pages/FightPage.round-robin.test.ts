import { describe, expect, it } from "vitest";
import { requiresIndividualFlagsForBout } from "@/pages/FightPage";
import type { FightEntry } from "@/store/tournament";

const red = { id: "red", name: "Rojo" };
const blue = { id: "blue", name: "Azul" };
const regular: FightEntry = { id: "regular", red, blue, groupId: "G1", completed: false };

describe("banderines de mesa en Round Robin", () => {
  it("requires individual judge flags only for regular ranked group bouts", () => {
    expect(requiresIndividualFlagsForBout("round-robin", regular)).toBe(true);
    expect(requiresIndividualFlagsForBout("groups", regular)).toBe(true);
    expect(requiresIndividualFlagsForBout("elimination", regular)).toBe(false);
    expect(requiresIndividualFlagsForBout("round-robin", { ...regular, isFinalFight: true })).toBe(
      false
    );
    expect(
      requiresIndividualFlagsForBout("round-robin", { ...regular, isTiebreakExtra: true })
    ).toBe(false);
    expect(
      requiresIndividualFlagsForBout("round-robin", {
        ...regular,
        isTiebreakExtra: true,
        playoffKind: "mini",
      })
    ).toBe(true);
    expect(
      requiresIndividualFlagsForBout("round-robin", {
        ...regular,
        isFinalFight: true,
        playoffKind: "mini",
        groupId: "FINAL",
      })
    ).toBe(true);
    expect(
      requiresIndividualFlagsForBout("round-robin", { ...regular, isGoldenPointFight: true })
    ).toBe(false);
    expect(
      requiresIndividualFlagsForBout("round-robin", { ...regular, groupId: "EXT:guest" })
    ).toBe(false);
  });
});
