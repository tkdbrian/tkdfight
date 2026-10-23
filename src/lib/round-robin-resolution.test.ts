import { describe, expect, it } from "vitest";
import type { CompetitorEntry, FightEntry } from "@/store/tournament";
import { generateFinalFights, generateGroupsTournament } from "./bracket";
import {
  closedGroupBasis,
  groupWinnerId,
  isAuthorizedPlayoffFight,
  isExternalGuestFight,
  nextDirectFightIsGoldenPoint,
  preparePlayoffFights,
  type RankedCompetitor,
  rankedGroupIds,
  resolveFirstPlace,
  roundRobinOutcome,
} from "./round-robin-resolution";

const athlete = (id: string): CompetitorEntry => ({ id, name: id });
const rank = (
  id: string,
  points: number,
  flagsFor = 0,
  foulsAgainst = 0,
  warnings = 0
): RankedCompetitor => ({ id, points, flagsFor, foulsAgainst, warnings });
const fight = (
  id: string,
  red: string,
  blue: string,
  groupId = "G1",
  winner?: FightEntry["winner"]
): FightEntry => ({
  id,
  red: athlete(red),
  blue: athlete(blue),
  groupId,
  completed: winner !== undefined,
  winner,
});

describe("first-place round-robin resolution", () => {
  it("allows a normal drawn round-robin fight without a playoff when four ranking metrics differ", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    const rows = [rank("a", 4, 2), rank("b", 4, 1), rank("c", 0)];
    expect(resolveFirstPlace("G1", rows, regular).status).toBe("none");
    expect(groupWinnerId("G1", rows, regular)).toBe("a");
  });

  it("uses flags, recorded penalty points, then warnings to break standings ties", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    expect(
      groupWinnerId("G1", [rank("a", 4, 3, 2, 0), rank("b", 4, 2, 0, 0), rank("c", 0)], regular)
    ).toBe("a");
    expect(
      groupWinnerId("G1", [rank("a", 4, 2, 1, 0), rank("b", 4, 2, 0, 2), rank("c", 0)], regular)
    ).toBe("b");
    expect(
      groupWinnerId("G1", [rank("a", 4, 2, 0, 2), rank("b", 4, 2, 0, 1), rank("c", 0)], regular)
    ).toBe("b");
    expect(
      resolveFirstPlace("G1", [rank("a", 4, 2, 0, 1), rank("b", 4, 2, 0, 1), rank("c", 0)], regular)
        .status
    ).toBe("needed");
  });

  it("does not open or resolve a playoff before every regular group fight is complete", () => {
    const regular = [fight("ab", "a", "b", "G1", "draw"), fight("ac", "a", "c")];
    const premature = { ...fight("early", "a", "b", "G1", "red"), isTiebreakExtra: true };
    const rows = [rank("a", 4), rank("b", 4), rank("c", 0)];
    expect(resolveFirstPlace("G1", rows, [...regular, premature]).status).toBe("none");
    expect(groupWinnerId("G1", rows, [...regular, premature])).toBeNull();
  });

  it("rejects a marked early extra even after the missing regular fights later finish", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c"),
      fight("bc", "b", "c"),
    ];
    const early = {
      ...fight("early", "a", "b", "G1", "red"),
      isTiebreakExtra: true,
      playoffKind: "direct" as const,
    };
    const rows = [rank("a", 4), rank("b", 4), rank("c", 0)];
    expect(closedGroupBasis("G1", [...regular, early])).toBeNull();
    expect(isAuthorizedPlayoffFight(early, [...regular, early])).toBe(false);
    const closed = [
      regular[0],
      { ...regular[1], completed: true, winner: "red" as const },
      { ...regular[2], completed: true, winner: "red" as const },
    ];
    expect(resolveFirstPlace("G1", rows, [...closed, early]).status).toBe("review");
    expect(groupWinnerId("G1", rows, [...closed, early])).toBeNull();
  });

  it("does not close a group if a known pairing is absent or duplicated", () => {
    const missing = [fight("ab", "a", "b", "G1", "draw"), fight("ac", "a", "c", "G1", "red")];
    const duplicate = [...missing, fight("ab2", "a", "b", "G1", "blue")];
    const rows = [rank("a", 4), rank("b", 1), rank("c", 0)];
    expect(closedGroupBasis("G1", missing)).toBeNull();
    expect(closedGroupBasis("G1", duplicate)).toBeNull();
    expect(groupWinnerId("G1", rows, missing)).toBeNull();
    expect(closedGroupBasis("G1", [missing[0]], ["a", "b", "c"])).toBeNull();
    expect(resolveFirstPlace("G1", rows, [missing[0]], ["a", "b", "c"]).status).toBe("none");
    expect(resolveFirstPlace("G1", rows, duplicate).status).toBe("none");
  });

  it("does not announce a champion when an expected entrant or group is absent", () => {
    const ab = [fight("ab", "a", "b", "G1", "red")];
    const group = { id: "G1", competitors: [athlete("a"), athlete("b"), athlete("c")], size: 3 };
    expect(roundRobinOutcome(ab).championId).toBe("a"); // No roster: missing c is unknowable.
    expect(roundRobinOutcome(ab, [group]).championId).toBeNull();
    const second = { id: "G2", competitors: [athlete("d"), athlete("e"), athlete("f")], size: 3 };
    expect(roundRobinOutcome(ab, [group, second]).championId).toBeNull();
  });

  it("ignores a stored extra between unrelated competitors instead of treating it as first-place result", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    const wrongExtra = { ...fight("old", "a", "c", "G1", "red"), isTiebreakExtra: true };
    const rows = [rank("a", 4), rank("b", 4), rank("c", 0)];
    const resolution = resolveFirstPlace("G1", rows, [...regular, wrongExtra]);
    expect(resolution.status).toBe("needed");
    expect(resolution.nextIds).toEqual(["a", "b"]);
    expect(resolution.fights).toEqual([]);
    expect(groupWinnerId("G1", rows, [...regular, wrongExtra])).toBeNull();
  });

  it("rejects a marked direct extra between the wrong pair despite a matching closed basis", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    const wrong = {
      ...fight("wrong-pair", "a", "c"),
      isTiebreakExtra: true,
      playoffKind: "direct" as const,
      playoffBasis: closedGroupBasis("G1", regular) ?? undefined,
    };
    expect(isAuthorizedPlayoffFight(wrong, [...regular, wrong], ["a", "b", "c"])).toBe(false);
  });

  it("rejects a marked two-person extra when all three group leaders remain tied", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "draw"),
      fight("bc", "b", "c", "G1", "draw"),
    ];
    const wrong = {
      ...fight("premature-direct", "a", "b"),
      isTiebreakExtra: true,
      playoffKind: "direct" as const,
      playoffBasis: closedGroupBasis("G1", regular) ?? undefined,
    };
    expect(isAuthorizedPlayoffFight(wrong, [...regular, wrong], ["a", "b", "c"])).toBe(false);
  });

  it("rejects an extra scheduled before group closure even if later results match its basis", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    const early = {
      ...fight("early-marked", "a", "b"),
      isTiebreakExtra: true,
      playoffKind: "direct" as const,
      playoffBasis: closedGroupBasis("G1", regular) ?? undefined,
    };
    expect(
      isAuthorizedPlayoffFight(early, [regular[0], early, ...regular.slice(1)], ["a", "b", "c"])
    ).toBe(false);
  });

  it("rejects a duplicate mini-replay pair while other required pairs remain unplayed", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "draw"),
      fight("bc", "b", "c", "G1", "draw"),
    ];
    const basis = closedGroupBasis("G1", regular) ?? undefined;
    const first = {
      ...fight("mini-1", "a", "b", "G1", "draw"),
      isTiebreakExtra: true,
      playoffKind: "mini" as const,
      playoffBasis: basis,
    };
    const duplicate = {
      ...fight("mini-duplicate", "a", "b"),
      isTiebreakExtra: true,
      playoffKind: "mini" as const,
      playoffBasis: basis,
    };
    expect(isAuthorizedPlayoffFight(first, [...regular, first], ["a", "b", "c"])).toBe(true);
    expect(
      isAuthorizedPlayoffFight(duplicate, [...regular, first, duplicate], ["a", "b", "c"])
    ).toBe(false);
  });

  it("requires explicit recovery for an unmarked legacy extra between the eventual leaders", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    const rows = [rank("a", 4), rank("b", 4), rank("c", 0)];
    const oldExtra = { ...fight("old", "a", "b", "G1", "red"), isTiebreakExtra: true };
    const review = resolveFirstPlace("G1", rows, [...regular, oldExtra]);
    expect(review.status).toBe("review");
    expect(review.legacyExtras?.map((f) => f.id)).toEqual(["old"]);
    expect(groupWinnerId("G1", rows, [...regular, oldExtra])).toBeNull();
    const [official] = preparePlayoffFights([athlete("a"), athlete("b")], "G1", review, 60);
    expect(official).toMatchObject({
      isTiebreakExtra: true,
      playoffKind: "direct",
      tiebreakerSeconds: 60,
    });
    expect(resolveFirstPlace("G1", rows, [...regular, oldExtra, official]).status).toBe(
      "in_progress"
    );
    expect(
      groupWinnerId("G1", rows, [
        ...regular,
        oldExtra,
        { ...official, completed: true, winner: "blue" },
      ])
    ).toBe("b");
  });

  it("does not build a partial replay when three leaders remain tied", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "draw"),
      fight("bc", "b", "c", "G1", "draw"),
    ];
    const resolution = resolveFirstPlace(
      "G1",
      [rank("a", 2), rank("b", 2), rank("c", 2)],
      regular,
      ["a", "b", "c"]
    );
    expect(resolution.nextIds).toEqual(["a", "b", "c"]);
    expect(preparePlayoffFights([athlete("a"), athlete("b")], "G1", resolution, 60)).toEqual([]);
  });

  it("requires extra, timed rematch, then untimed Golden Point for a top-two group tie", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "red"),
      fight("bc", "b", "c", "G1", "red"),
    ];
    const rows = [rank("a", 4), rank("b", 4), rank("c", 0)];
    const basis = closedGroupBasis("G1", regular);
    const playoff = {
      ...fight("playoff", "a", "b", "G1", "draw"),
      isTiebreakExtra: true,
      playoffKind: "direct" as const,
      playoffBasis: basis ?? undefined,
      flagsRed: 3,
    };
    const pending = resolveFirstPlace("G1", rows, [...regular, playoff]);
    expect(pending.status).toBe("needed");
    expect(pending.goldenPoint).toBe(false);
    expect(nextDirectFightIsGoldenPoint(playoff, [...regular, playoff])).toBe(false);
    const legacy = { ...fight("legacy", "a", "b", "G1", "draw"), isTiebreakExtra: true };
    expect(nextDirectFightIsGoldenPoint(playoff, [...regular, legacy, playoff])).toBe(false);
    expect(groupWinnerId("G1", rows, [...regular, playoff])).toBeNull();
    const prematureGp = {
      ...fight("premature-gp", "a", "b", "G1", "blue"),
      isGoldenPointFight: true,
      playoffKind: "direct" as const,
      playoffBasis: basis ?? undefined,
    };
    expect(isAuthorizedPlayoffFight(prematureGp, [...regular, playoff, prematureGp])).toBe(false);
    expect(resolveFirstPlace("G1", rows, [...regular, playoff, prematureGp]).status).toBe("review");
    expect(groupWinnerId("G1", rows, [...regular, playoff, prematureGp])).toBeNull();
    const malformedReview = resolveFirstPlace("G1", rows, [...regular, playoff, prematureGp]);
    expect(preparePlayoffFights([athlete("a"), athlete("b")], "G1", malformedReview, 60)).toEqual(
      []
    );

    const [timed] = preparePlayoffFights([athlete("a"), athlete("b")], "G1", pending, 60);
    expect(timed).toMatchObject({
      isTiebreakExtra: true,
      playoffKind: "direct",
      tiebreakerSeconds: 60,
    });
    const drawnTimed = { ...timed, completed: true, winner: "draw" as const };
    const afterTimed = resolveFirstPlace("G1", rows, [...regular, playoff, drawnTimed]);
    expect(afterTimed.status).toBe("needed");
    expect(afterTimed.goldenPoint).toBe(true);
    expect(nextDirectFightIsGoldenPoint(drawnTimed, [...regular, playoff, drawnTimed])).toBe(true);
    const [generatedGp] = preparePlayoffFights([athlete("a"), athlete("b")], "G1", afterTimed, 60);
    expect(generatedGp).toMatchObject({ isGoldenPointFight: true, playoffKind: "direct" });
    expect(
      isAuthorizedPlayoffFight(generatedGp, [...regular, playoff, drawnTimed, generatedGp])
    ).toBe(true);

    const gp = {
      ...fight("gp", "a", "b", "G1", "blue"),
      isGoldenPointFight: true,
      playoffKind: "direct" as const,
      playoffBasis: basis ?? undefined,
      bracketMatchId: "playoff",
    };
    expect(
      resolveFirstPlace("G1", rows, [...regular, playoff, drawnTimed, gp]).resolvedOrder
    ).toEqual(["b", "a"]);
    expect(groupWinnerId("G1", rows, [...regular, playoff, drawnTimed, gp])).toBe("b");
  });

  it("does not resolve a three-way first-place tie from an incomplete legacy mini-table", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "draw"),
      fight("bc", "b", "c", "G1", "draw"),
    ];
    const rows = [rank("a", 2), rank("b", 2), rank("c", 2)];
    const basis = closedGroupBasis("G1", regular);
    const loneExtra = {
      ...fight("extra", "a", "b", "G1", "red"),
      isTiebreakExtra: true,
      playoffKind: "mini" as const,
      playoffBasis: basis ?? undefined,
    };
    expect(resolveFirstPlace("G1", rows, [...regular, loneExtra]).status).toBe("needed");
    expect(groupWinnerId("G1", rows, [...regular, loneExtra])).toBeNull();

    const allDrawn = [
      {
        ...fight("x1", "a", "b", "G1", "draw"),
        isTiebreakExtra: true,
        playoffKind: "mini" as const,
        playoffBasis: basis ?? undefined,
      },
      {
        ...fight("x2", "a", "c", "G1", "draw"),
        isTiebreakExtra: true,
        playoffKind: "mini" as const,
        playoffBasis: basis ?? undefined,
      },
      {
        ...fight("x3", "b", "c", "G1", "draw"),
        isTiebreakExtra: true,
        playoffKind: "mini" as const,
        playoffBasis: basis ?? undefined,
      },
    ];
    expect(resolveFirstPlace("G1", rows, [...regular, ...allDrawn]).status).toBe("needed");
    expect(groupWinnerId("G1", rows, [...regular, ...allDrawn])).toBeNull();
    const replayOne = {
      ...fight("x4", "a", "b", "G1", "red"),
      isTiebreakExtra: true,
      playoffKind: "mini" as const,
      playoffBasis: basis ?? undefined,
    };
    const afterOne = resolveFirstPlace("G1", rows, [...regular, ...allDrawn, replayOne]);
    expect(afterOne.status).toBe("needed");
    expect(afterOne.missingPairKeys).toEqual(["a|c", "b|c"]);
    const duplicateBeforeClosure = {
      ...fight("duplicate", "a", "b", "G1", "blue"),
      isTiebreakExtra: true,
      playoffKind: "mini" as const,
      playoffBasis: basis ?? undefined,
    };
    expect(
      resolveFirstPlace("G1", rows, [
        ...regular,
        ...allDrawn,
        replayOne,
        duplicateBeforeClosure,
        ...allDrawn.slice(1),
      ]).status
    ).toBe("review");
    const replay = [
      replayOne,
      {
        ...fight("x5", "a", "c", "G1", "red"),
        isTiebreakExtra: true,
        playoffKind: "mini" as const,
        playoffBasis: basis ?? undefined,
      },
      {
        ...fight("x6", "b", "c", "G1", "red"),
        isTiebreakExtra: true,
        playoffKind: "mini" as const,
        playoffBasis: basis ?? undefined,
      },
    ];
    expect(groupWinnerId("G1", rows, [...regular, ...allDrawn, ...replay])).toBe("a");
  });

  it("replays a complete three-person mini-table again when the second cycle is still tied", () => {
    const regular = [
      fight("ab", "a", "b", "G1", "draw"),
      fight("ac", "a", "c", "G1", "draw"),
      fight("bc", "b", "c", "G1", "draw"),
    ];
    const rows = [rank("a", 2), rank("b", 2), rank("c", 2)];
    const basis = closedGroupBasis("G1", regular);
    const cycle = (prefix: string): FightEntry[] => [
      {
        ...fight(`${prefix}-ab`, "a", "b", "G1", "draw"),
        isTiebreakExtra: true,
        playoffKind: "mini",
        playoffBasis: basis ?? undefined,
      },
      {
        ...fight(`${prefix}-ac`, "a", "c", "G1", "draw"),
        isTiebreakExtra: true,
        playoffKind: "mini",
        playoffBasis: basis ?? undefined,
      },
      {
        ...fight(`${prefix}-bc`, "b", "c", "G1", "draw"),
        isTiebreakExtra: true,
        playoffKind: "mini",
        playoffBasis: basis ?? undefined,
      },
    ];
    const twice = [...regular, ...cycle("one"), ...cycle("two")];
    const stillTied = resolveFirstPlace("G1", rows, twice);
    expect(stillTied.status).toBe("needed");
    expect(stillTied.nextIds).toEqual(["a", "b", "c"]);
    expect(
      preparePlayoffFights([athlete("a"), athlete("b"), athlete("c")], "G1", stillTied, 60)
    ).toHaveLength(3);
    expect(groupWinnerId("G1", rows, twice)).toBeNull();
    const thirdPartial = [...twice, { ...cycle("three")[0], winner: "red" as const }];
    expect(resolveFirstPlace("G1", rows, thirdPartial).missingPairKeys).toEqual(["a|c", "b|c"]);
    const [ab, ac, bc] = cycle("three");
    const decisive = [
      ...twice,
      { ...ab, winner: "red" as const },
      { ...ac, winner: "red" as const },
      bc,
    ];
    expect(groupWinnerId("G1", rows, decisive)).toBe("a");
  });

  it("six competitors form two groups of three, then exactly one direct final after each winner is known", () => {
    const { groups, fights: initial } = generateGroupsTournament("abcdef".split("").map(athlete));
    expect(groups.map((g) => g.size)).toEqual([3, 3]);
    expect(initial.filter((f) => f.groupId === "G1")).toHaveLength(3);
    expect(initial.filter((f) => f.groupId === "G2")).toHaveLength(3);
    const [a, b, c] = groups[0].competitors.map((x) => x.id);
    const [d, e, f] = groups[1].competitors.map((x) => x.id);
    const regular = [
      fight("ab", a, b, "G1", "draw"),
      fight("ac", a, c, "G1", "red"),
      fight("bc", b, c, "G1", "red"),
      fight("de", d, e, "G2", "red"),
      fight("df", d, f, "G2", "red"),
      fight("ef", e, f, "G2", "draw"),
    ];
    const firstRows = [rank(a, 4), rank(b, 4), rank(c, 0)];
    const secondRows = [rank(d, 6), rank(e, 1), rank(f, 1)];
    expect(groupWinnerId("G1", firstRows, regular)).toBeNull();
    expect(roundRobinOutcome(regular).championId).toBeNull();
    const initialResolution = resolveFirstPlace("G1", firstRows, regular);
    const [generatedPlayoff] = preparePlayoffFights(
      [athlete(a), athlete(b)],
      "G1",
      initialResolution,
      60
    );
    expect(generatedPlayoff).toMatchObject({
      isTiebreakExtra: true,
      playoffKind: "direct",
      tiebreakerSeconds: 60,
    });
    const playoff = { ...generatedPlayoff, completed: true, winner: "blue" as const };
    const resolved = [...regular, playoff];
    expect(groupWinnerId("G1", firstRows, resolved)).toBe(b);
    expect(groupWinnerId("G2", secondRows, resolved)).toBe(d);
    expect(roundRobinOutcome(resolved).championId).toBeNull();
    const external = fight("guest", b, "visitor", "EXT:guest", "red");
    expect(isExternalGuestFight(external)).toBe(true);
    expect(rankedGroupIds([...resolved, external])).toEqual(["G1", "G2"]);
    expect(roundRobinOutcome([...resolved, external]).championId).toBeNull();
    const final = generateFinalFights([athlete(b), athlete(d)]);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ groupId: "FINAL", isFinalFight: true });
    expect(roundRobinOutcome([...resolved, ...final]).championId).toBeNull();
    const cleanFinal = { ...final[0], completed: true, winner: "blue" as const, flagsRed: 3 };
    expect(roundRobinOutcome([...resolved, cleanFinal])).toEqual({ championId: d, runnerUpId: b });

    const drawnFinal = { ...final[0], completed: true, winner: "draw" as const, flagsRed: 3 };
    const finalRows = [rank(b, 1, 3), rank(d, 1, 0)];
    const finalResolution = resolveFirstPlace("FINAL", finalRows, [...resolved, drawnFinal]);
    expect(finalResolution.status).toBe("needed");
    expect(nextDirectFightIsGoldenPoint(drawnFinal, [...resolved, drawnFinal])).toBe(false);
    const [whiteBandExtra] = preparePlayoffFights(
      [athlete(b), athlete(d)],
      "FINAL",
      finalResolution,
      40
    );
    expect(whiteBandExtra).toMatchObject({
      isFinalFight: true,
      isTiebreakExtra: true,
      playoffKind: "direct",
      tiebreakerSeconds: 40,
    });
    const [otherExtra] = preparePlayoffFights(
      [athlete(b), athlete(d)],
      "FINAL",
      finalResolution,
      60
    );
    expect(otherExtra.tiebreakerSeconds).toBe(60);
    expect(groupWinnerId("FINAL", finalRows, [...resolved, drawnFinal])).toBeNull();
    expect(roundRobinOutcome([...resolved, drawnFinal]).championId).toBeNull();
    const extra = {
      ...fight("final-extra", b, d, "FINAL", "draw"),
      isTiebreakExtra: true,
      isFinalFight: true,
      playoffKind: "direct" as const,
      playoffBasis: finalResolution.playoffBasis,
    };
    expect(groupWinnerId("FINAL", finalRows, [...resolved, drawnFinal, extra])).toBeNull();
    expect(roundRobinOutcome([...resolved, drawnFinal, extra]).championId).toBeNull();
    const gpResolution = resolveFirstPlace("FINAL", finalRows, [...resolved, drawnFinal, extra]);
    expect(gpResolution.status).toBe("needed");
    expect(gpResolution.goldenPoint).toBe(true);
    expect(nextDirectFightIsGoldenPoint(extra, [...resolved, drawnFinal, extra])).toBe(true);
    const [generatedGp] = preparePlayoffFights([athlete(b), athlete(d)], "FINAL", gpResolution, 40);
    expect(generatedGp).toMatchObject({
      isFinalFight: true,
      isGoldenPointFight: true,
      playoffKind: "direct",
    });
    expect(generatedGp.tiebreakerSeconds).toBeUndefined();
    const gp = {
      ...fight("final-gp", b, d, "FINAL", "blue"),
      isGoldenPointFight: true,
      isFinalFight: true,
      playoffKind: "direct" as const,
      playoffBasis: finalResolution.playoffBasis,
    };
    expect(groupWinnerId("FINAL", finalRows, [...resolved, drawnFinal, extra, gp])).toBe(d);
    expect(roundRobinOutcome([...resolved, drawnFinal, extra, gp])).toEqual({
      championId: d,
      runnerUpId: b,
    });
  });

  it("retains the existing three-group mini final without promoting an incomplete final", () => {
    const groupIds = ["G1", "G2", "G3"];
    const pairs = [
      ["a", "b", "c"],
      ["d", "e", "f"],
      ["g", "h", "i"],
    ];
    const groups = pairs.map((ids, index) => ({
      id: groupIds[index],
      competitors: ids.map(athlete),
      size: 3,
    }));
    const regular = pairs.flatMap(([first, second, third], index) => [
      fight(`${index}-ab`, first, second, groupIds[index], "red"),
      fight(`${index}-ac`, first, third, groupIds[index], "red"),
      fight(`${index}-bc`, second, third, groupIds[index], "red"),
    ]);
    const finals = generateFinalFights([athlete("a"), athlete("d"), athlete("g")]);
    expect(finals).toHaveLength(3);
    expect(roundRobinOutcome([...regular, ...finals], groups).championId).toBeNull();
    const [ad, ag, dg] = finals;
    const incomplete = [
      ...regular,
      { ...ad, completed: true, winner: "red" as const },
      { ...ag, completed: true, winner: "red" as const },
      dg,
    ];
    expect(roundRobinOutcome(incomplete, groups).championId).toBeNull();
    const complete = [
      ...regular,
      { ...ad, completed: true, winner: "red" as const },
      { ...ag, completed: true, winner: "red" as const },
      { ...dg, completed: true, winner: "red" as const },
    ];
    expect(roundRobinOutcome(complete, groups).championId).toBe("a");
  });
});
