import { describe, expect, it } from "vitest";
import type { CompetitorEntry, FightEntry } from "@/store/tournament";
import { generateFinalFights, generateGroupsTournament } from "./bracket";
import {
  compareRoundRobinRank, groupWinnerId, preparePlayoffFights,
  projectRoundRobinStandings, rankRoundRobinGroup, resolveFirstPlace, roundRobinOutcome,
  type RoundRobinStanding,
} from "./round-robin-resolution";

const athlete = (id: string): CompetitorEntry => ({ id, name: `Name ${id}`, team: `Team ${id}` });
const fight = (id: string, red: CompetitorEntry, blue: CompetitorEntry,
  winner: FightEntry["winner"], groupId = "G1"): FightEntry => ({
  id, red, blue, winner, groupId, completed: winner !== undefined,
});

/** StandingsPage's pre-extraction projection, kept only as an independent test oracle. */
function previousProjection(groupId: string, fights: FightEntry[]): RoundRobinStanding[] {
  const rows = new Map<string, RoundRobinStanding>();
  const row = (competitor: CompetitorEntry) => {
    let value = rows.get(competitor.id);
    if (!value) {
      value = { id: competitor.id, name: competitor.name, team: competitor.team,
        played: 0, wins: 0, draws: 0, losses: 0, points: 0,
        flagsFor: 0, foulsAgainst: 0, warnings: 0 };
      rows.set(competitor.id, value);
    }
    return value;
  };
  for (const f of fights) {
    if ((f.groupId ?? "G1") !== groupId || f.isTiebreakExtra || f.isGoldenPointFight ||
      f.groupId?.startsWith("EXT:")) continue;
    const red = row(f.red), blue = row(f.blue);
    if (!f.completed) continue;
    red.played++; blue.played++;
    red.flagsFor += f.flagsRed ?? 0; blue.flagsFor += f.flagsBlue ?? 0;
    red.foulsAgainst += f.foulsRed ?? 0; blue.foulsAgainst += f.foulsBlue ?? 0;
    red.warnings += f.warningsRed ?? 0; blue.warnings += f.warningsBlue ?? 0;
    if (f.winner === "red") { red.wins++; red.points += 3; blue.losses++; }
    else if (f.winner === "blue") { blue.wins++; blue.points += 3; red.losses++; }
    else { red.draws++; red.points++; blue.draws++; blue.points++; }
  }
  return [...rows.values()].sort((a, b) => b.points - a.points ||
    b.flagsFor - a.flagsFor || a.foulsAgainst - b.foulsAgainst || a.warnings - b.warnings);
}

describe("shared round-robin ranking", () => {
  it.each(Array.from({ length: 10 }, (_, i) => i + 3))(
    "matches the previous standings projection for %i entrants and resolver decisions", (n) => {
      const generated = generateGroupsTournament(Array.from({ length: n }, (_, i) => athlete(`${n}-${i}`)));
      const fights = generated.fights.map((entry, i) => ({ ...entry,
        completed: i % 4 !== 0, winner: i % 4 === 0 ? undefined :
          i % 3 === 0 ? "red" as const : i % 3 === 1 ? "blue" as const : "draw" as const,
        flagsRed: i % 4, flagsBlue: (i + 1) % 4,
        foulsRed: i % 2, foulsBlue: (i + 1) % 2,
        warningsRed: i % 3, warningsBlue: (i + 2) % 3,
      }));
      const projected = projectRoundRobinStandings(fights);
      expect([...projected.keys()]).toEqual(generated.groups.map((group) => group.id));
      for (const group of generated.groups) {
        const expectedIds = group.competitors.map((entry) => entry.id);
        const expected = previousProjection(group.id, fights);
        const actual = rankRoundRobinGroup(group.id, fights);
        expect(actual).toEqual(expected);
        expect(projected.get(group.id)).toEqual(expected);
        expect(actual.every((entry, index) => !index ||
          compareRoundRobinRank(actual[index - 1], entry) <= 0)).toBe(true);
        expect(resolveFirstPlace(group.id, actual, fights, expectedIds)).toEqual(
          resolveFirstPlace(group.id, expected, fights, expectedIds));
        expect(groupWinnerId(group.id, actual, fights, expectedIds)).toBe(
          groupWinnerId(group.id, expected, fights, expectedIds));
      }
    },
  );

  it("excludes playoff, Golden Point and external guest fights from regular rows", () => {
    const [a, b, c] = [athlete("a"), athlete("b"), athlete("c")];
    const regular = [fight("ab", a, b, "red"), fight("ac", a, c, undefined)];
    const extra = { ...fight("extra", a, b, "blue"), isTiebreakExtra: true, flagsBlue: 99 };
    const golden = { ...fight("gp", a, b, "blue"), isGoldenPointFight: true };
    const guest = fight("guest", a, athlete("guest"), "blue", "EXT:visitor");
    expect(rankRoundRobinGroup("G1", [...regular, extra, golden, guest])).toEqual(
      previousProjection("G1", regular));
    expect(rankRoundRobinGroup("G1", regular).find((entry) => entry.id === c.id)?.played).toBe(0);
  });

  it("feeds the existing direct playoff resolver without changing regular standings", () => {
    const [a, b, c] = [athlete("a"), athlete("b"), athlete("c")];
    const regular = [fight("ab", a, b, "draw"), fight("ac", a, c, "red"),
      fight("bc", b, c, "red")];
    const rows = rankRoundRobinGroup("G1", regular);
    expect(rows.map((row) => [row.id, row.points])).toEqual([["a", 4], ["b", 4], ["c", 0]]);
    const resolution = resolveFirstPlace("G1", rows, regular, ["a", "b", "c"]);
    expect(resolution).toMatchObject({ status: "needed", nextIds: ["a", "b"] });
    const [playoff] = preparePlayoffFights([a, b], "G1", resolution, 30);
    expect(playoff).toMatchObject({ playoffKind: "direct", isTiebreakExtra: true });
    const all = [...regular, { ...playoff, completed: true, winner: "red" as const }];
    expect(rankRoundRobinGroup("G1", all)).toEqual(rows);
    expect(groupWinnerId("G1", rows, all, ["a", "b", "c"])).toBe(playoff.red.id);
  });

  it("feeds the generated cross-group FINAL and champion resolution", () => {
    const generated = generateGroupsTournament(Array.from({ length: 6 }, (_, i) => athlete(`${i}`)));
    const groupLeaders = generated.groups.map((group) => group.competitors[0]);
    const regular = generated.fights.map((entry) => {
      const leader = groupLeaders.find((candidate) => candidate.id === entry.red.id ||
        candidate.id === entry.blue.id);
      return { ...entry, completed: true,
        winner: leader?.id === entry.red.id ? "red" as const : "blue" as const,
        flagsRed: 2, flagsBlue: 1 };
    });
    for (const group of generated.groups) {
      expect(groupWinnerId(group.id, rankRoundRobinGroup(group.id, regular), regular,
        group.competitors.map((entry) => entry.id))).toBe(group.competitors[0].id);
    }
    const [final] = generateFinalFights(groupLeaders);
    const all = [...regular, { ...final, completed: true, winner: "red" as const }];
    expect(rankRoundRobinGroup("FINAL", all).map((entry) => entry.id)).toEqual(
      [final.red.id, final.blue.id]);
    expect(groupWinnerId("FINAL", rankRoundRobinGroup("FINAL", all), all,
      groupLeaders.map((entry) => entry.id))).toBe(final.red.id);
    expect(roundRobinOutcome(all, generated.groups)).toEqual({ championId: final.red.id,
      runnerUpId: final.blue.id });
  });
});
