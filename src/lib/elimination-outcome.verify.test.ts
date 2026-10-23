import { describe, expect, it } from "vitest";
import { resolveEliminationOutcome } from "@/lib/category-lifecycle";
import type { TournamentCategorySnapshot } from "@/store/tournament";

const red = { id: "red", name: "Red" };
const blue = { id: "blue", name: "Blue" };
const initial: TournamentCategorySnapshot = {
  config: { id: "category", tournamentName: "Test", categoryName: "Test", tableChief: "",
    ruleSet: null, judgesCount: 4, mode: "elimination", matchType: "sparring" },
  competitors: [red, blue],
  bracketMatches: [
    { id: "a", round: 0, position: 0, bracketGroup: "A", completed: true,
      winnerId: red.id, red: { competitor: red }, blue: { competitor: null } },
    { id: "b", round: 0, position: 0, bracketGroup: "B", completed: true,
      winnerId: blue.id, red: { competitor: blue }, blue: { competitor: null } },
  ],
  bracketSeeds: [], groups: [], currentFightIndex: 0, phase: "fighting", setupStarted: true,
  fights: [{ id: "final", red, blue, groupId: "FINAL_AB", isFinalFight: true,
    completed: true, winner: "draw" }],
};

describe("actual FINAL_AB continuation lineage", () => {
  it("accepts real byes as advancement without a fabricated bout", () => {
    const snapshot: TournamentCategorySnapshot = { ...initial, fights: [
      { ...initial.fights[0], winner: "red" },
    ] };
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({
      status: "resolved", championId: red.id, requiredResultIds: ["final"],
    });
  });

  it("requires review if a supposed bye has a fabricated completed bout", () => {
    const snapshot: TournamentCategorySnapshot = { ...initial, fights: [
      { ...initial.fights[0], winner: "red" },
      { id: "fabricated-bye", red, blue, bracketMatchId: "a",
        completed: true, winner: "red" },
    ] };
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({
      status: "review", championId: null, runnerUpId: null,
    });
  });

  it("resolves the timed extra created by FightPage even though the original has no bracketMatchId", () => {
    const snapshot: TournamentCategorySnapshot = { ...initial, fights: [
      initial.fights[0],
      { id: "extra", red, blue, groupId: "FINAL_AB", isFinalFight: true,
        bracketMatchId: "final", continuationParentFightId: "final",
        continuationStage: "timed-extra", isTiebreakExtra: true,
        completed: true, winner: "red" },
    ] };
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({
      status: "resolved", championId: red.id, decisiveFightId: "extra",
      requiredResultIds: ["final", "extra"],
    });
  });

  it("resolves the golden point created after a drawn timed extra", () => {
    const snapshot: TournamentCategorySnapshot = { ...initial, fights: [
      initial.fights[0],
      { id: "extra", red, blue, groupId: "FINAL_AB", isFinalFight: true,
        bracketMatchId: "final", continuationParentFightId: "final",
        continuationStage: "timed-extra", isTiebreakExtra: true,
        completed: true, winner: "draw" },
      { id: "golden", red, blue, groupId: "FINAL_AB", isFinalFight: true,
        bracketMatchId: "final", continuationParentFightId: "extra",
        continuationStage: "golden-point", isGoldenPointFight: true,
        completed: true, winner: "blue" },
    ] };
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({
      status: "resolved", championId: blue.id, decisiveFightId: "golden",
      requiredResultIds: ["final", "extra", "golden"],
    });
  });
});
