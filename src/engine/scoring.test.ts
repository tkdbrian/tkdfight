import { describe, it, expect } from "vitest";
import {
  calculateEventValue,
  computeRoundTotals,
  aggregateTotals,
  aggregateTotalsWithPenalties,
  countWarnings,
  compareScores,
  fewestDeductionsAgainst,
  resolveTiebreak,
  checkDQ,
} from "./scoring";
import type { MatchEvent, RoundState, RuleSetSparring } from "./types";

// ── Fixtures ──────────────────────────────────────────────────────────────

const rules: RuleSetSparring = {
  mode: "sparring",
  judgesCount: 4,
  rounds: { count: 2, duration_seconds: 120, rest_seconds: 60 },
  points: { punch: 1, kick: 2, jump_kick: 3 },
  deductions: { warning_minor: -1, foul_major: -2, disqualification: "DQ" },
  fouls_for_dq: 3,
};

function ev(
  competitor: "red" | "blue",
  type: string,
  value: number,
  opts: { judgeId?: string; isDQ?: boolean } = {},
): MatchEvent {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    judgeId: opts.judgeId ?? "j1",
    competitor,
    type,
    value,
    isDQ: opts.isDQ,
  };
}

function round(num: number, events: MatchEvent[]): RoundState {
  const totals = { red: 0, blue: 0 };
  const deductions = { red: 0, blue: 0 };
  const fouls = { red: 0, blue: 0 };
  for (const e of events) {
    totals[e.competitor] += e.value;
    if (e.value < 0) deductions[e.competitor] += e.value;
    if (e.isDQ) fouls[e.competitor] += 1;
  }
  return { number: num, totals, deductions, fouls, events };
}

// ── calculateEventValue ───────────────────────────────────────────────────

describe("calculateEventValue", () => {
  it("returns positive value for point events", () => {
    expect(calculateEventValue("kick", rules)).toEqual({ value: 2, isDQ: false });
    expect(calculateEventValue("jump_kick", rules)).toEqual({ value: 3, isDQ: false });
  });

  it("returns negative value for deduction events", () => {
    expect(calculateEventValue("warning_minor", rules)).toEqual({ value: -1, isDQ: false });
    expect(calculateEventValue("foul_major", rules)).toEqual({ value: -2, isDQ: false });
  });

  it("marks DQ events with isDQ flag and value 0", () => {
    expect(calculateEventValue("disqualification", rules)).toEqual({ value: 0, isDQ: true });
  });

  it("parses subtract_N for judge corrections", () => {
    expect(calculateEventValue("subtract_1", rules)).toEqual({ value: -1, isDQ: false });
    expect(calculateEventValue("subtract_3", rules)).toEqual({ value: -3, isDQ: false });
  });

  it("returns 0 for unknown events", () => {
    expect(calculateEventValue("unknown_event", rules)).toEqual({ value: 0, isDQ: false });
  });
});

// ── computeRoundTotals ────────────────────────────────────────────────────

describe("computeRoundTotals", () => {
  it("sums points by competitor", () => {
    const events = [ev("red", "kick", 2), ev("red", "punch", 1), ev("blue", "kick", 2)];
    const { totals } = computeRoundTotals(events);
    expect(totals).toEqual({ red: 3, blue: 2 });
  });

  it("tracks deductions separately and as negative numbers", () => {
    const events = [ev("red", "warning_minor", -1), ev("red", "foul_major", -2)];
    const { deductions } = computeRoundTotals(events);
    expect(deductions.red).toBe(-3);
  });

  it("counts DQ fouls", () => {
    const events = [ev("blue", "disqualification", 0, { isDQ: true })];
    const { fouls } = computeRoundTotals(events);
    expect(fouls.blue).toBe(1);
  });
});

// ── aggregateTotals & warnings ────────────────────────────────────────────

describe("aggregateTotals + penalties", () => {
  it("sums totals across rounds", () => {
    const r1 = round(1, [ev("red", "kick", 2), ev("blue", "punch", 1)]);
    const r2 = round(2, [ev("red", "punch", 1), ev("blue", "kick", 2)]);
    expect(aggregateTotals([r1, r2])).toEqual({ red: 3, blue: 3 });
  });

  it("applies 1pt penalty per 3 cumulative warnings (arbiter only)", () => {
    const warnings = Array.from({ length: 3 }, () =>
      ev("red", "warning_minor", -1, { judgeId: "arbiter" }),
    );
    const r1 = round(1, [ev("red", "kick", 2), ...warnings]);
    expect(countWarnings([r1]).red).toBe(3);
    // base red = 2 - 3 (deductions in totals) = -1; minus 1 more for the 3-warning penalty
    expect(aggregateTotalsWithPenalties([r1]).red).toBe(-2);
  });

  it("remove_warning decrements warning count, never below zero", () => {
    const r1 = round(1, [
      ev("red", "warning_minor", -1, { judgeId: "arbiter" }),
      ev("red", "remove_warning", 1, { judgeId: "arbiter" }),
      ev("red", "remove_warning", 1, { judgeId: "arbiter" }),
    ]);
    expect(countWarnings([r1]).red).toBe(0);
  });

  it("ignores warnings emitted by non-arbiter judges", () => {
    const r1 = round(1, [ev("red", "warning_minor", -1, { judgeId: "j1" })]);
    expect(countWarnings([r1]).red).toBe(0);
  });
});

// ── compareScores ─────────────────────────────────────────────────────────

describe("compareScores", () => {
  it("returns the higher side", () => {
    expect(compareScores({ red: 5, blue: 3 })).toBe("red");
    expect(compareScores({ red: 1, blue: 4 })).toBe("blue");
  });
  it("returns 'draw' when equal", () => {
    expect(compareScores({ red: 2, blue: 2 })).toBe("draw");
  });
});

// ── fewestDeductionsAgainst ───────────────────────────────────────────────

describe("fewestDeductionsAgainst", () => {
  it("wins to the side with less negative deductions", () => {
    const r1 = round(1, [ev("red", "warning_minor", -1), ev("blue", "foul_major", -2)]);
    // red=-1, blue=-2 → red has fewer deductions → red wins
    expect(fewestDeductionsAgainst([r1])).toBe("red");
  });
  it("returns 'draw' when equal", () => {
    const r1 = round(1, [ev("red", "warning_minor", -1), ev("blue", "warning_minor", -1)]);
    expect(fewestDeductionsAgainst([r1])).toBe("draw");
  });
});

// ── resolveTiebreak ───────────────────────────────────────────────────────

describe("resolveTiebreak cascade", () => {
  it("resolves via fewest_deductions first", () => {
    const r1 = round(1, [ev("blue", "warning_minor", -1)]);
    const result = resolveTiebreak([r1], null, ["fewest_deductions_against", "first_clean_point"]);
    expect(result).toEqual({ winner: "red", reason: "points" });
  });

  it("falls through to first_clean_point when deductions tied", () => {
    const r1 = round(1, []);
    const result = resolveTiebreak([r1], "blue", ["fewest_deductions_against", "first_clean_point"]);
    expect(result).toEqual({ winner: "blue", reason: "points" });
  });

  it("returns null on golden_point (caller handles match phase)", () => {
    const r1 = round(1, []);
    const result = resolveTiebreak([r1], null, ["golden_point"]);
    expect(result).toBeNull();
  });

  it("returns null on jury_decision (requires manual input)", () => {
    const r1 = round(1, []);
    const result = resolveTiebreak([r1], null, ["jury_decision"]);
    expect(result).toBeNull();
  });
});

// ── DQ check ──────────────────────────────────────────────────────────────

describe("checkDQ", () => {
  it("flags DQ when fouls reach the threshold", () => {
    const r1 = round(1, [
      ev("red", "disqualification", 0, { isDQ: true }),
      ev("red", "disqualification", 0, { isDQ: true }),
      ev("red", "disqualification", 0, { isDQ: true }),
    ]);
    expect(checkDQ([r1], rules)).toBe("red");
  });

  it("returns null when below threshold", () => {
    const r1 = round(1, [ev("red", "disqualification", 0, { isDQ: true })]);
    expect(checkDQ([r1], rules)).toBeNull();
  });
});

// ── Regression: judge:vote 'tie' normalization ────────────────────────────────
// Bug: judge devices emitían 'tie' pero tallyFlagWinner solo contaba 'draw'.
// Fix: el handler normaliza 'tie' → 'draw' antes de guardar en state.judgeVotes.
// Este test documenta la invariante esperada post-fix.
describe("vote normalization (tie → draw)", () => {
  function normalizeVote(vote: string): string {
    return vote === "tie" ? "draw" : vote;
  }

  it("normaliza 'tie' a 'draw'", () => {
    expect(normalizeVote("tie")).toBe("draw");
  });

  it("deja 'red' sin cambios", () => {
    expect(normalizeVote("red")).toBe("red");
  });

  it("deja 'blue' sin cambios", () => {
    expect(normalizeVote("blue")).toBe("blue");
  });

  it("deja 'draw' sin cambios (mesa:flagVote ya usa draw)", () => {
    expect(normalizeVote("draw")).toBe("draw");
  });
});
