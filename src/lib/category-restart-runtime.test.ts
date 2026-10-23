import { afterEach, describe, expect, it } from "vitest";
import type { RuleSetSparring } from "@/engine/types";
import { generateEliminationBracket, generateGroupsTournament, getActiveBracketFights } from "@/lib/bracket";
import { currentCategoryDeletionSnapshot } from "@/lib/category-deletion-controller";
import { categoryDeletionPreviewRequestSchema } from "@/lib/category-deletion-contract";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import { categoryRestartSnapshotSchema, restartCategoryRequestSchema } from "@/lib/category-restart-contract";
import { categoryDeleteAndRestartRequestSchema } from "@/lib/category-restart-modes-contract";
import { yusanConfigPatch } from "@/lib/yusan-profile";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";

const initial = useTournamentStore.getState();

afterEach(() => {
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

/** Generate and advance the real bracket/store path, without schema-normalizing the fixture. */
function completedElimination(): TournamentCategorySnapshot {
  localStorage.clear();
  const config = { ...initial.config, id: crypto.randomUUID(),
    categoryName: "Amarillos a Puntas Azules · Masculino · 8-9 años", mode: "elimination" as const };
  const timing = yusanConfigPatch(config, { ageDivision: "infantiles-b", categoryAgeFrom: "8",
    categoryAgeTo: "9", sexDivision: "Masculino", gradeSystem: "GUPS",
    gupBand: "Amarillos a Puntas Azules" }, "elimination", baseline as RuleSetSparring);
  const competitors = Array.from({ length: 4 }, (_, index) => ({ id: crypto.randomUUID(),
    name: `Competidor ${index + 1}`, team: "Club", weight: 30 + index }));
  const generated = generateEliminationBracket(competitors);
  useTournamentStore.setState({ ...initial, config: { ...config, ...timing }, competitors,
    phase: "fighting", setupStarted: true, fights: [], groups: [],
    currentFightIndex: 0, bracketMatches: generated.matches, bracketSeeds: generated.seeds });
  for (let round = 0; round < 2; round++) {
    const state = useTournamentStore.getState();
    const next = getActiveBracketFights(state.bracketMatches, state.fights);
    state.setFights([...state.fights, ...next]);
    for (const fight of next) {
      state.completeFight(fight.id, "red", "flags", { flagsRed: 3, flagsBlue: 1 });
      state.completeBracketMatch(fight.bracketMatchId ?? "", fight.red.id);
    }
  }
  return currentCategoryDeletionSnapshot();
}

function expectRestartEnvelopes(previousSnapshot: TournamentCategorySnapshot): void {
  const replacementSnapshot = createRestartReplacement(previousSnapshot);
  const requestId = crypto.randomUUID();
  const archive = { requestId, categoryId: previousSnapshot.config.id, previousSnapshot,
    replacementSnapshot };
  const destructive = { requestId, expectedRevision: "a".repeat(64), previousSnapshot,
    replacementSnapshot };
  expect(restartCategoryRequestSchema.parse(archive)).toEqual(archive);
  expect(categoryDeletionPreviewRequestSchema.parse({ localSnapshot: previousSnapshot }))
    .toEqual({ localSnapshot: previousSnapshot });
  expect(categoryDeleteAndRestartRequestSchema.parse(destructive)).toEqual(destructive);
  expect(previousSnapshot.competitors.map((competitor) => competitor.id))
    .not.toEqual(replacementSnapshot.competitors.map((competitor) => competitor.id));
  expect(replacementSnapshot.config).toEqual({ ...previousSnapshot.config, id: replacementSnapshot.config.id });
  if (replacementSnapshot.config.mode === "elimination") expect(replacementSnapshot.fights).toEqual([]);
  else expect(replacementSnapshot.fights.every((fight) => !fight.completed && !fight.winner)).toBe(true);
}

describe("real generated elimination restart snapshots", () => {
  it("accepts the completed 3/3 four-entrant Yusan category in both restart modes", () => {
    const previous = completedElimination();
    expect(previous.fights).toHaveLength(3);
    expect(previous.fights.every((fight) => fight.completed)).toBe(true);
    expect(previous.bracketMatches.every((match) => match.completed)).toBe(true);
    expectRestartEnvelopes(previous);
  });

  it("archives the full historical bracket after removing a competitor, but restarts only the current three", () => {
    const completed = completedElimination();
    const removed = completed.fights[1].blue;
    useTournamentStore.getState().removeCompetitor(removed.id);
    const previous = currentCategoryDeletionSnapshot();
    const before = JSON.stringify(previous);
    expect(previous.competitors).toHaveLength(3);
    expect(previous.fights[1].blue).toEqual(removed);
    expect(previous.bracketSeeds).toContain(removed.id);
    expectRestartEnvelopes(previous);
    const replacement = createRestartReplacement(previous);
    expect(replacement.competitors).toHaveLength(3);
    expect(replacement.competitors.map(({ id: _id, ...competitor }) => competitor))
      .toEqual(previous.competitors.map(({ id: _id, ...competitor }) => competitor));
    expect(replacement.competitors.some((competitor) => competitor.id === removed.id)).toBe(false);
    expect(JSON.stringify(previous)).toBe(before);
  });

  it("also retains recorded RR participants while restarting from its reduced current roster", () => {
    const completed = completedElimination();
    const generated = generateGroupsTournament(completed.competitors);
    useTournamentStore.setState({ ...completed, config: { ...completed.config, mode: "round-robin" },
      ...generated, bracketSeeds: [], bracketMatches: [] });
    for (const fight of generated.fights)
      useTournamentStore.getState().completeFight(fight.id, "red", "flags", { flagsRed: 4, flagsBlue: 0 });
    const removed = completed.competitors[3];
    useTournamentStore.getState().removeCompetitor(removed.id);
    const previous = currentCategoryDeletionSnapshot();
    const before = JSON.stringify(previous);
    expect(previous.competitors).toHaveLength(3);
    expect(previous.groups[0].competitors).toHaveLength(4);
    expect(previous.fights).toHaveLength(6);
    expectRestartEnvelopes(previous);
    const replacement = createRestartReplacement(previous);
    expect(replacement.competitors).toHaveLength(3);
    expect(replacement.groups[0].competitors).toHaveLength(3);
    expect(replacement.fights).toHaveLength(3);
    expect(replacement.fights.every((fight) => !fight.completed)).toBe(true);
    expect(JSON.stringify(previous)).toBe(before);
  });

  it("rejects a historical seed or winner with no full participant record and malformed bracket records", () => {
    const previous = completedElimination();
    useTournamentStore.getState().removeCompetitor(previous.fights[1].blue.id);
    const historical = currentCategoryDeletionSnapshot();
    const unknown = crypto.randomUUID();
    const danglingSeed = { ...historical, bracketSeeds: [...historical.bracketSeeds, unknown] };
    const danglingWinner = { ...historical, bracketMatches: historical.bracketMatches.map((match, index) =>
      index === 0 ? { ...match, winnerId: unknown } : match) };
    const malformedSlot = { ...historical, bracketMatches: historical.bracketMatches.map((match, index) =>
      index === 0 ? { ...match, blue: { competitor: { id: unknown } } } : match) };
    for (const invalid of [danglingSeed, danglingWinner, malformedSlot])
      expect(categoryRestartSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it("preserves durable timed-extra lineage emitted by FightPage when restarting", () => {
    const previous = completedElimination();
    const final = previous.fights[2];
    previous.fights[2] = { ...final, winner: "draw" };
    previous.fights.push({ ...final, id: crypto.randomUUID(), isTiebreakExtra: true,
      tiebreakerSeconds: 60, continuationParentFightId: final.id, continuationStage: "timed-extra" });
    expectRestartEnvelopes(previous);
  });

  it("preserves golden-point provenance and the original snapshot without rewriting it", () => {
    const previous = completedElimination();
    const final = previous.fights[2];
    previous.fights[2] = { ...final, winner: "draw" };
    previous.fights.push({ ...final, id: crypto.randomUUID(), isGoldenPointFight: true,
      continuationParentFightId: final.id, continuationStage: "golden-point" });
    const before = structuredClone(previous);
    expectRestartEnvelopes(previous);
    expect(previous).toEqual(before);
  });

  it.each(["missing", "self"] as const)("rejects a %s continuation parent reference", (kind) => {
    const previous = completedElimination();
    const final = previous.fights[2];
    const id = crypto.randomUUID();
    previous.fights.push({ ...final, id, isTiebreakExtra: true,
      continuationParentFightId: kind === "self" ? id : crypto.randomUUID(), continuationStage: "timed-extra" });
    expect(categoryRestartSnapshotSchema.safeParse(previous).success).toBe(false);
  });

  it.each([
    { continuationParentFightId: "" },
    { continuationParentFightId: "x".repeat(129) },
    { continuationParentFightId: 3 },
    { continuationStage: "invented" },
    { continuationStage: null },
    { unknownContinuationField: true },
  ])("still rejects malformed or unknown provenance: %j", (invalid) => {
    const previous = completedElimination();
    const final = previous.fights[2];
    const snapshot = { ...previous, fights: [...previous.fights, { ...final,
      id: crypto.randomUUID(), isTiebreakExtra: true,
      continuationParentFightId: final.id, continuationStage: "timed-extra", ...invalid }] };
    expect(categoryRestartSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
