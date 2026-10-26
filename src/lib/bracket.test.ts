import { describe, it, expect } from "vitest";
import {
  generateGroupsTournament,
  generateEliminationBracket,
  generateDoubleBracket,
  generateTiebreakFights,
  generateFinalFights,
  getActiveBracketFights,
  getGroupDistribution,
} from "./bracket";
import type { CompetitorEntry } from "@/store/tournament";

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeCompetitors(n: number): CompetitorEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    name: `Competidor ${i + 1}`,
  }));
}

// ── getGroupDistribution ──────────────────────────────────────────────────

describe("getGroupDistribution", () => {
  it("returns valid distributions for 3-12 competitors", () => {
    for (let n = 3; n <= 12; n++) {
      const dist = getGroupDistribution(n);
      expect(dist).toBeDefined();
      expect(dist?.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("returns undefined for unsupported sizes", () => {
    expect(getGroupDistribution(2)).toBeUndefined();
    expect(getGroupDistribution(13)).toBeUndefined();
  });
});

// ── generateGroupsTournament (round-robin) ────────────────────────────────

describe("generateGroupsTournament", () => {
  const restPatterns: Record<number, string> = {
    6: "121212", 7: "221212122", 8: "112211221122", 9: "1121211221121211",
    10: "11221122112211221122", 11: "221332123312233", 12: "112233112233112233",
  };
  const minimumRecovery: Record<number, number> = {
    6: 1, 7: 1, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4,
  };

  it("keeps legacy group blocks when the policy is omitted", () => {
    for (let n = 3; n <= 12; n++) {
      const fights = generateGroupsTournament(makeCompetitors(n)).fights;
      expect(fights.map((fight) => fight.groupId)).toEqual(
        [...fights].sort((a, b) => (a.groupId ?? "").localeCompare(b.groupId ?? ""))
          .map((fight) => fight.groupId),
      );
    }
  });

  it("merges each group queue in its fixed rest-optimized order without changing pairs", () => {
    for (let n = 3; n <= 12; n++) {
      const competitors = makeCompetitors(n);
      const blocked = generateGroupsTournament(competitors, "SERPENTINE", "group-blocks");
      const optimized = generateGroupsTournament(competitors, "SERPENTINE", "rest-optimized");
      const pattern = restPatterns[n] ?? "1".repeat(optimized.fights.length);
      expect(optimized.fights.map((fight) => fight.groupId?.slice(1)).join("")).toBe(pattern);
      expect(optimized.groups).toEqual(blocked.groups);
      for (const group of blocked.groups) {
        const pairs = (fights: typeof blocked.fights) => fights
          .filter((fight) => fight.groupId === group.id)
          .map((fight) => `${fight.red.id}-${fight.blue.id}`);
        expect(pairs(optimized.fights)).toEqual(pairs(blocked.fights));
      }
      const pairKeys = optimized.fights.map((fight) =>
        [fight.red.id, fight.blue.id].sort().join("-"));
      expect(new Set(pairKeys).size).toBe(pairKeys.length);
      for (let index = 1; n >= 6 && index < optimized.fights.length; index++) {
        const previous = optimized.fights[index - 1];
        const current = optimized.fights[index];
        expect([previous.red.id, previous.blue.id]).not.toContain(current.red.id);
        expect([previous.red.id, previous.blue.id]).not.toContain(current.blue.id);
      }
      if (n >= 6) {
        const appearances = new Map<string, number[]>();
        optimized.fights.forEach((fight, index) => {
          for (const competitor of [fight.red, fight.blue]) {
            appearances.set(competitor.id, [...(appearances.get(competitor.id) ?? []), index]);
          }
        });
        const meanRecovery = [...appearances.values()].map((indexes) => {
          const recoveries = indexes.slice(1).map((index, i) => index - indexes[i] - 1);
          expect(Math.min(...recoveries)).toBeGreaterThanOrEqual(minimumRecovery[n]);
          return recoveries.reduce((sum, value) => sum + value, 0) / recoveries.length;
        });
        expect(Math.max(...meanRecovery) - Math.min(...meanRecovery)).toBeLessThanOrEqual(4);
      }
    }
  });
  it("generates the right number of fights for each supported size", () => {
    // Expected fight counts per group size (n choose 2): 3=3, 4=6, 5=10
    const cases: Array<[number, number]> = [
      [3, 3],
      [4, 6],
      [5, 10],
      [6, 6], // 2 groups of 3 → 3+3
      [8, 12], // 2 groups of 4 → 6+6
      [10, 20], // 2 groups of 5 → 10+10
    ];

    for (const [n, expected] of cases) {
      const { fights, groups } = generateGroupsTournament(makeCompetitors(n));
      expect(fights.length).toBe(expected);
      expect(groups.reduce((acc, g) => acc + g.competitors.length, 0)).toBe(n);
    }
  });

  it("every fight has a valid groupId and distinct red/blue", () => {
    const { fights } = generateGroupsTournament(makeCompetitors(8));
    for (const f of fights) {
      expect(f.groupId).toMatch(/^G\d+$/);
      expect(f.red.id).not.toBe(f.blue.id);
      expect(f.completed).toBe(false);
    }
  });

  it("throws for unsupported competitor count", () => {
    expect(() => generateGroupsTournament(makeCompetitors(2))).toThrow();
    expect(() => generateGroupsTournament(makeCompetitors(15))).toThrow();
  });

  it("serpentine seeding spreads consecutive entrants across groups", () => {
    // 6 competitors → sizes [3,3]; serpentine: G0=[c1,c4,c5] G1=[c2,c3,c6]
    const { groups } = generateGroupsTournament(makeCompetitors(6), "SERPENTINE");
    expect(groups[0].competitors.map((c) => c.id)).toEqual(["c1", "c4", "c5"]);
    expect(groups[1].competitors.map((c) => c.id)).toEqual(["c2", "c3", "c6"]);
  });
});

// ── generateEliminationBracket ────────────────────────────────────────────

describe("generateEliminationBracket", () => {
  it("creates a power-of-2 bracket and the right number of rounds", () => {
    const { matches } = generateEliminationBracket(makeCompetitors(8));
    // 8 comps → 4+2+1 = 7 matches
    expect(matches.length).toBe(7);
    const rounds = new Set(matches.map((m) => m.round));
    expect(rounds.size).toBe(3);
  });

  it("auto-advances byes in round 0 when bracket size > competitor count", () => {
    // 5 competitors → bracket of 8 with 3 byes
    const { matches } = generateEliminationBracket(makeCompetitors(5));
    const r0 = matches.filter((m) => m.round === 0);
    const byeMatches = r0.filter(
      (m) => (m.red.competitor === null) !== (m.blue.competitor === null),
    );
    // Every bye match should be auto-completed
    for (const m of byeMatches) {
      expect(m.completed).toBe(true);
      expect(m.winnerId).toBeDefined();
    }
  });

  it("links later rounds via fromMatchId", () => {
    const { matches } = generateEliminationBracket(makeCompetitors(4));
    const r1 = matches.find((m) => m.round === 1);
    expect(r1?.red.fromMatchId).toBeDefined();
    expect(r1?.blue.fromMatchId).toBeDefined();
  });
});

// ── generateDoubleBracket ─────────────────────────────────────────────────

describe("generateDoubleBracket", () => {
  it("splits competitors into two grids tagged A and B", () => {
    const { matches } = generateDoubleBracket(makeCompetitors(20));
    const a = matches.filter((m) => m.bracketGroup === "A");
    const b = matches.filter((m) => m.bracketGroup === "B");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });
});

// ── generateTiebreakFights ────────────────────────────────────────────────

describe("generateTiebreakFights", () => {
  it("returns 1 fight for 2 tied competitors", () => {
    const fights = generateTiebreakFights(makeCompetitors(2), "G1");
    expect(fights.length).toBe(1);
    expect(fights[0].isTiebreakExtra).toBe(true);
    expect(fights[0].groupId).toBe("G1");
  });

  it("returns a mini round-robin for 3-5 tied competitors", () => {
    expect(generateTiebreakFights(makeCompetitors(3), "G1").length).toBe(3);
    expect(generateTiebreakFights(makeCompetitors(4), "G1").length).toBe(6);
    expect(generateTiebreakFights(makeCompetitors(5), "G1").length).toBe(10);
  });

  it("throws for unsupported sizes", () => {
    expect(() => generateTiebreakFights(makeCompetitors(6), "G1")).toThrow();
  });

  it("returns empty array for less than 2 tied", () => {
    expect(generateTiebreakFights(makeCompetitors(1), "G1")).toEqual([]);
    expect(generateTiebreakFights([], "G1")).toEqual([]);
  });
});

// ── generateFinalFights ───────────────────────────────────────────────────

describe("generateFinalFights", () => {
  it("returns 1 fight for 2 group winners", () => {
    const fights = generateFinalFights(makeCompetitors(2));
    expect(fights.length).toBe(1);
    expect(fights[0].isFinalFight).toBe(true);
    expect(fights[0].groupId).toBe("FINAL");
  });

  it("returns 3 fights for 3 group winners", () => {
    const fights = generateFinalFights(makeCompetitors(3));
    expect(fights.length).toBe(3);
    expect(fights.every((f) => f.isFinalFight && f.groupId === "FINAL")).toBe(true);
  });
});

// ── getActiveBracketFights ────────────────────────────────────────────────

describe("getActiveBracketFights", () => {
  it("returns only the minimum-round matches with both competitors", () => {
    const { matches } = generateEliminationBracket(makeCompetitors(4));
    const active = getActiveBracketFights(matches, []);
    // R0 has 2 matches with both competitors
    expect(active.length).toBe(2);
    expect(active.every((f) => f.bracketRound === 0)).toBe(true);
  });

  it("skips matches already in fights[]", () => {
    const { matches } = generateEliminationBracket(makeCompetitors(4));
    const firstActive = getActiveBracketFights(matches, []);
    expect(firstActive.length).toBe(2);
    // Simulate only one of the two R0 fights already loaded
    const next = getActiveBracketFights(matches, [firstActive[0]]);
    // Should return the remaining R0 match (still same minimum round)
    expect(next.length).toBe(1);
    expect(next[0].bracketMatchId).toBe(firstActive[1].bracketMatchId);
  });
});
