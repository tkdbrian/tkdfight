import { describe, expect, it } from "vitest";
import type { CompetitorEntry, FightEntry, TournamentGroup } from "@/store/tournament";
import { generateFinalFights, generateGroupsTournament } from "./bracket";
import {
  closedGroupBasis,
  groupWinnerId,
  isAuthorizedPlayoffFight,
  nextDirectFightIsGoldenPoint,
  preparePlayoffFights,
  type RankedCompetitor,
  resolveFirstPlace,
  roundRobinOutcome,
} from "./round-robin-resolution";

const athlete = (id: string): CompetitorEntry => ({ id, name: id });
const pair = (fight: FightEntry): string => [fight.red.id, fight.blue.id].sort().join("|");

/** Deterministic input generator: ascending n/seed makes a failure easy to minimize. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function randomizedResults(fights: FightEntry[], seed: number): FightEntry[] {
  const next = random(seed);
  return fights.map((fight, index) => {
    const outcome = next() % 3;
    const winner = outcome === 0 ? "red" : outcome === 1 ? "blue" : "draw";
    return {
      ...fight,
      id: `regular-${index}`,
      completed: true,
      winner,
      flagsRed: winner === "red" ? 3 : winner === "blue" ? 1 : 2,
      flagsBlue: winner === "blue" ? 3 : winner === "red" ? 1 : 2,
      foulsRed: next() % 3,
      foulsBlue: next() % 3,
      warningsRed: next() % 3,
      warningsBlue: next() % 3,
    };
  });
}

function referenceRank(group: TournamentGroup, fights: FightEntry[]): RankedCompetitor[] {
  const stats = new Map<string, RankedCompetitor>(
    group.competitors.map((competitor) => [
      competitor.id,
      { id: competitor.id, points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 },
    ])
  );
  for (const fight of fights.filter((entry) => entry.groupId === group.id)) {
    const red = stats.get(fight.red.id);
    const blue = stats.get(fight.blue.id);
    if (!red || !blue) throw new Error(`unknown entrant in ${fight.id}`);
    red.flagsFor += fight.flagsRed ?? 0;
    blue.flagsFor += fight.flagsBlue ?? 0;
    red.foulsAgainst += fight.foulsRed ?? 0;
    blue.foulsAgainst += fight.foulsBlue ?? 0;
    red.warnings += fight.warningsRed ?? 0;
    blue.warnings += fight.warningsBlue ?? 0;
    if (fight.winner === "red") red.points += 3;
    else if (fight.winner === "blue") blue.points += 3;
    else {
      red.points++;
      blue.points++;
    }
  }
  return [...stats.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.flagsFor - a.flagsFor ||
      a.foulsAgainst - b.foulsAgainst ||
      a.warnings - b.warnings
  );
}

function sameRank(a: RankedCompetitor, b: RankedCompetitor): boolean {
  return (
    a.points === b.points &&
    a.flagsFor === b.flagsFor &&
    a.foulsAgainst === b.foulsAgainst &&
    a.warnings === b.warnings
  );
}

function completeWithLeader(fights: FightEntry[], leaderId: string): FightEntry[] {
  return fights.map((fight, index) => {
    const winner = fight.red.id === leaderId ? "red" : fight.blue.id === leaderId ? "blue" : "draw";
    return {
      ...fight,
      id: `leader-${fight.groupId}-${index}`,
      completed: true,
      winner,
      flagsRed: winner === "red" ? 3 : winner === "blue" ? 1 : 2,
      flagsBlue: winner === "blue" ? 3 : winner === "red" ? 1 : 2,
      foulsRed: 0,
      foulsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
    };
  });
}

function completeWithTwoLeaders(fights: FightEntry[], first: string, second: string): FightEntry[] {
  return fights.map((fight, index) => {
    const isFirstPair = [fight.red.id, fight.blue.id].includes(first);
    const isSecondPair = [fight.red.id, fight.blue.id].includes(second);
    const winner =
      isFirstPair && isSecondPair
        ? "draw"
        : isFirstPair
          ? fight.red.id === first
            ? "red"
            : "blue"
          : isSecondPair
            ? fight.red.id === second
              ? "red"
              : "blue"
            : "draw";
    return {
      ...fight,
      id: `leaders-${fight.groupId}-${index}`,
      completed: true,
      winner,
      flagsRed: winner === "red" ? 3 : winner === "blue" ? 1 : 2,
      flagsBlue: winner === "blue" ? 3 : winner === "red" ? 1 : 2,
      foulsRed: 0,
      foulsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
    };
  });
}

describe("Round Robin generated-fixture invariants", () => {
  for (const size of [3, 4, 5, 6, 8, 12]) {
    it(`${size} entrants: every pair once, no early winner, lexicographic leader`, () => {
      const generated = generateGroupsTournament(
        Array.from({ length: size }, (_, index) => athlete(`athlete-${index}`))
      );
      for (const group of generated.groups) {
        const fixtures = generated.fights.filter((fight) => fight.groupId === group.id);
        const expected = (group.size * (group.size - 1)) / 2;
        expect(fixtures).toHaveLength(expected);
        expect(new Set(fixtures.map(pair)).size).toBe(expected);
        expect(
          closedGroupBasis(
            group.id,
            fixtures,
            group.competitors.map((competitor) => competitor.id)
          )
        ).toBeNull();
      }

      for (let seed = 0; seed < 24; seed++) {
        const completed = randomizedResults(generated.fights, size * 1000 + seed);
        for (const group of generated.groups) {
          const groupFights = completed.filter((fight) => fight.groupId === group.id);
          const ids = group.competitors.map((competitor) => competitor.id);
          const context = `n=${size} seed=${seed} group=${group.id}`;
          expect(closedGroupBasis(group.id, completed, ids), context).not.toBeNull();
          const rows = referenceRank(group, completed);
          const tied = rows.filter((row) => sameRank(row, rows[0]));
          const resolution = resolveFirstPlace(group.id, rows, completed, ids);
          expect(resolution.status, context).toBe(tied.length === 1 ? "none" : "needed");
          expect(groupWinnerId(group.id, rows, completed, ids), context).toBe(
            tied.length === 1 ? rows[0].id : null
          );
          for (const index of [0, Math.floor(groupFights.length / 2), groupFights.length - 1]) {
            const missing = completed.filter((fight) => fight.id !== groupFights[index].id);
            expect(
              closedGroupBasis(group.id, missing, ids),
              `${context} missing=${index}`
            ).toBeNull();
            expect(
              groupWinnerId(group.id, rows, missing, ids),
              `${context} missing=${index}`
            ).toBeNull();
          }
          const pending = completed.map((fight) =>
            fight.id === groupFights[0].id
              ? { ...fight, completed: false, winner: undefined }
              : fight
          );
          expect(groupWinnerId(group.id, rows, pending, ids), `${context} unconfirmed`).toBeNull();
        }
        if (generated.groups.length > 1) {
          expect(
            roundRobinOutcome(completed, generated.groups).championId,
            `n=${size} seed=${seed} no final`
          ).toBeNull();
        } else {
          const rows = referenceRank(generated.groups[0], completed);
          const unique = rows.filter((row) => sameRank(row, rows[0])).length === 1;
          expect(
            roundRobinOutcome(completed, generated.groups).championId,
            `n=${size} seed=${seed} one group`
          ).toBe(unique ? rows[0].id : null);
        }
      }
    });
  }

  for (const size of [3, 4, 5]) {
    it(`${size} exactly tied leaders replay complete mini tables until resolved`, () => {
      const { groups, fights } = generateGroupsTournament(
        Array.from({ length: size }, (_, index) => athlete(`a-${index}`))
      );
      const ids = groups[0].competitors.map((competitor) => competitor.id);
      const allDrawn = fights.map((fight, index) => ({
        ...fight,
        id: `regular-${index}`,
        completed: true,
        winner: "draw" as const,
        flagsRed: 2,
        flagsBlue: 2,
        foulsRed: 0,
        foulsBlue: 0,
        warningsRed: 0,
        warningsBlue: 0,
      }));
      const rows = referenceRank(groups[0], allDrawn);
      let history = allDrawn;
      for (let cycle = 0; cycle < 2; cycle++) {
        const resolution = resolveFirstPlace("G1", rows, history, ids);
        expect(resolution.status).toBe("needed");
        expect(resolution.nextIds).toEqual(ids);
        const proposed = preparePlayoffFights(groups[0].competitors, "G1", resolution, 60);
        expect(new Set(proposed.map(pair)).size).toBe((size * (size - 1)) / 2);
        const firstPending = [...history, ...proposed];
        expect(groupWinnerId("G1", rows, firstPending, ids)).toBeNull();
        history = [
          ...history,
          ...proposed.map((fight) => ({
            ...fight,
            completed: true,
            winner: "draw" as const,
            flagsRed: 2,
            flagsBlue: 2,
            foulsRed: 0,
            foulsBlue: 0,
            warningsRed: 0,
            warningsBlue: 0,
          })),
        ];
        expect(groupWinnerId("G1", rows, history, ids)).toBeNull();
      }
      const third = resolveFirstPlace("G1", rows, history, ids);
      const decisive = completeWithLeader(
        preparePlayoffFights(groups[0].competitors, "G1", third, 60),
        ids[0]
      );
      expect(groupWinnerId("G1", rows, [...history, ...decisive], ids)).toBe(ids[0]);
    });
  }

  it("uses flags, then fewer direct minus points, then fewer warnings after equal table points", () => {
    const { groups, fights } = generateGroupsTournament(["a", "b", "c"].map(athlete));
    const base = fights.map((fight, index) => ({
      ...fight,
      id: `tie-${index}`,
      completed: true,
      winner: "draw" as const,
      flagsRed: 1,
      flagsBlue: 1,
      foulsRed: 0,
      foulsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
    }));
    const setFor = (
      history: FightEntry[],
      id: string,
      field: "flags" | "fouls" | "warnings",
      value: number
    ): FightEntry[] =>
      history.map((fight) => {
        if (fight.red.id === id) {
          return {
            ...fight,
            [field === "flags" ? "flagsRed" : field === "fouls" ? "foulsRed" : "warningsRed"]:
              value,
          };
        }
        if (fight.blue.id === id) {
          return {
            ...fight,
            [field === "flags" ? "flagsBlue" : field === "fouls" ? "foulsBlue" : "warningsBlue"]:
              value,
          };
        }
        return fight;
      });
    const winner = (history: FightEntry[]): string | null =>
      groupWinnerId("G1", referenceRank(groups[0], history), history, ["a", "b", "c"]);
    expect(winner(base)).toBeNull();
    expect(winner(setFor(base, "a", "flags", 2))).toBe("a");
    const withFouls = setFor(setFor(base, "b", "fouls", 1), "c", "fouls", 1);
    expect(winner(withFouls)).toBe("a");
    const withWarnings = setFor(setFor(base, "b", "warnings", 1), "c", "warnings", 1);
    expect(winner(withWarnings)).toBe("a");
  });

  for (const size of [3, 4, 5]) {
    it(`${size} entrants: exact two-way first-place tie needs two timed draws then GP`, () => {
      const { groups, fights } = generateGroupsTournament(
        Array.from({ length: size }, (_, index) => athlete(`a-${index}`))
      );
      const [first, second] = groups[0].competitors;
      const ids = groups[0].competitors.map((competitor) => competitor.id);
      const regular = completeWithTwoLeaders(fights, first.id, second.id);
      const rows = referenceRank(groups[0], regular);
      expect(rows[0].points).toBe(rows[1].points);
      expect(sameRank(rows[0], rows[1])).toBe(true);
      let history = regular;
      for (let stage = 0; stage < 2; stage++) {
        const resolution = resolveFirstPlace("G1", rows, history, ids);
        expect(resolution.status).toBe("needed");
        expect(Boolean(resolution.goldenPoint)).toBe(false);
        const [proposed] = preparePlayoffFights([first, second], "G1", resolution, 60);
        expect(proposed).toMatchObject({ isTiebreakExtra: true, tiebreakerSeconds: 60 });
        expect(isAuthorizedPlayoffFight(proposed, [...history, proposed], ids)).toBe(true);
        expect(nextDirectFightIsGoldenPoint(proposed, [...history, proposed])).toBe(stage === 1);
        history = [
          ...history,
          {
            ...proposed,
            completed: true,
            winner: "draw",
            flagsRed: 2,
            flagsBlue: 2,
            foulsRed: 0,
            foulsBlue: 0,
            warningsRed: 0,
            warningsBlue: 0,
          },
        ];
        expect(groupWinnerId("G1", rows, history, ids)).toBeNull();
      }
      const resolution = resolveFirstPlace("G1", rows, history, ids);
      expect(resolution.goldenPoint).toBe(true);
      const [gp] = preparePlayoffFights([first, second], "G1", resolution, 60);
      expect(gp.isGoldenPointFight).toBe(true);
      expect(gp.tiebreakerSeconds).toBeUndefined();
      expect(isAuthorizedPlayoffFight(gp, [...history, gp], ids)).toBe(true);
      expect(
        groupWinnerId("G1", rows, [...history, { ...gp, completed: true, winner: "red" }], ids)
      ).toBe(first.id);
    });
  }

  it("three-way mini replay may narrow to two, then uses the full direct sequence", () => {
    const { groups, fights } = generateGroupsTournament(["a", "b", "c"].map(athlete));
    const regular = fights.map((fight, index) => ({
      ...fight,
      id: `regular-${index}`,
      completed: true,
      winner: "draw" as const,
      flagsRed: 2,
      flagsBlue: 2,
      foulsRed: 0,
      foulsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
    }));
    const ids = groups[0].competitors.map((competitor) => competitor.id);
    const rows = referenceRank(groups[0], regular);
    const initial = resolveFirstPlace("G1", rows, regular, ids);
    const mini = preparePlayoffFights(groups[0].competitors, "G1", initial, 60);
    const [first, second] = groups[0].competitors;
    const completedMini = mini.map((fight) => {
      const pairIds = [fight.red.id, fight.blue.id];
      const target =
        pairIds.includes(first.id) && pairIds.includes(second.id)
          ? null
          : pairIds.includes(first.id)
            ? first.id
            : second.id;
      const winner: NonNullable<FightEntry["winner"]> =
        target === null ? "draw" : fight.red.id === target ? "red" : "blue";
      return {
        ...fight,
        completed: true,
        winner,
        flagsRed: winner === "red" ? 3 : winner === "blue" ? 1 : 2,
        flagsBlue: winner === "blue" ? 3 : winner === "red" ? 1 : 2,
        foulsRed: 0,
        foulsBlue: 0,
        warningsRed: 0,
        warningsBlue: 0,
      };
    });
    let history = [...regular, ...completedMini];
    expect(resolveFirstPlace("G1", rows, history, ids).nextIds).toEqual([first.id, second.id]);
    for (let index = 0; index < 2; index++) {
      const resolution = resolveFirstPlace("G1", rows, history, ids);
      expect(Boolean(resolution.goldenPoint)).toBe(false);
      const [timed] = preparePlayoffFights([first, second], "G1", resolution, 60);
      history = [
        ...history,
        {
          ...timed,
          completed: true,
          winner: "draw" as const,
          flagsRed: 2,
          flagsBlue: 2,
          foulsRed: 0,
          foulsBlue: 0,
          warningsRed: 0,
          warningsBlue: 0,
        },
      ];
      expect(groupWinnerId("G1", rows, history, ids)).toBeNull();
    }
    const gpResolution = resolveFirstPlace("G1", rows, history, ids);
    expect(gpResolution.goldenPoint).toBe(true);
    const [gp] = preparePlayoffFights([first, second], "G1", gpResolution, 60);
    expect(gp.isGoldenPointFight).toBe(true);
    expect(
      groupWinnerId("G1", rows, [...history, { ...gp, completed: true, winner: "red" }], ids)
    ).toBe(first.id);
  });

  for (const size of [6, 8, 12]) {
    it(`${size} entrants: independent group winners and complete inter-group final`, () => {
      const { groups, fights } = generateGroupsTournament(
        Array.from({ length: size }, (_, index) => athlete(`a-${index}`))
      );
      const winners = groups.map((group) => group.competitors[0]);
      const completed = completeWithLeader(
        fights.filter((fight) => fight.groupId === "G1"),
        winners[0].id
      ).concat(
        groups.slice(1).flatMap((group, index) =>
          completeWithLeader(
            fights.filter((fight) => fight.groupId === group.id),
            winners[index + 1].id
          )
        )
      );
      expect(roundRobinOutcome(completed, groups).championId).toBeNull();
      const final = generateFinalFights(winners);
      expect(final).toHaveLength((winners.length * (winners.length - 1)) / 2);
      expect(roundRobinOutcome([...completed, ...final], groups).championId).toBeNull();
      const finalCompleted = completeWithLeader(final, winners[0].id);
      expect(
        roundRobinOutcome([...completed, ...finalCompleted.slice(0, -1)], groups).championId
      ).toBeNull();
      expect(roundRobinOutcome([...completed, ...finalCompleted], groups).championId).toBe(
        winners[0].id
      );
      expect(
        roundRobinOutcome([...completed, ...finalCompleted.slice(1)], groups).championId
      ).toBeNull();
      const missingGroup = groups.slice(0, -1);
      expect(
        roundRobinOutcome([...completed, ...finalCompleted], missingGroup).championId
      ).toBeNull();

      const drawnFinals = final.map((fight, index) => ({
        ...fight,
        id: `drawn-final-${index}`,
        completed: true,
        winner: "draw" as const,
        flagsRed: 2,
        flagsBlue: 2,
        foulsRed: 0,
        foulsBlue: 0,
        warningsRed: 0,
        warningsBlue: 0,
      }));
      const finalGroup: TournamentGroup = {
        id: "FINAL",
        competitors: winners,
        size: winners.length,
      };
      const finalRows = referenceRank(finalGroup, drawnFinals);
      const finalHistory = [...completed, ...drawnFinals];
      const firstResolution = resolveFirstPlace(
        "FINAL",
        finalRows,
        finalHistory,
        winners.map((winner) => winner.id)
      );
      expect(firstResolution.status).toBe("needed");
      const extra = preparePlayoffFights(winners, "FINAL", firstResolution, 60);
      expect(extra).toHaveLength((winners.length * (winners.length - 1)) / 2);
      if (winners.length === 2) {
        const timed = {
          ...extra[0],
          completed: true,
          winner: "draw" as const,
          flagsRed: 2,
          flagsBlue: 2,
          foulsRed: 0,
          foulsBlue: 0,
          warningsRed: 0,
          warningsBlue: 0,
        };
        const gpResolution = resolveFirstPlace(
          "FINAL",
          finalRows,
          [...finalHistory, timed],
          winners.map((winner) => winner.id)
        );
        expect(gpResolution.goldenPoint).toBe(true);
        const [gp] = preparePlayoffFights(winners, "FINAL", gpResolution, 60);
        expect(gp).toMatchObject({ isGoldenPointFight: true, isFinalFight: true });
        expect(
          roundRobinOutcome(
            [...finalHistory, timed, { ...gp, completed: true, winner: "red" }],
            groups
          ).championId
        ).toBe(winners[0].id);
      } else {
        const mini = completeWithLeader(extra, winners[0].id);
        expect(roundRobinOutcome([...finalHistory, ...mini], groups).championId).toBe(
          winners[0].id
        );
      }
    });
  }
});
