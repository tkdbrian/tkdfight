import { describe, expect, it } from "vitest";
import baseline from "../rules/rules/rules_sparring_itf_baseline.json";
import {
  addMatchEvent,
  createGoldenPointMatch,
  createMatch,
  endPhase,
  getSanctionCount,
  setSanctionCount,
  startPhase,
} from "./match-machine";
import type { RuleSetSparring } from "./types";

const rules = { ...baseline, rounds: { ...baseline.rounds, count: 1 } } as RuleSetSparring;

describe("post-clock table-chief sanction correction", () => {
  it("records and reverses warnings and direct minus points after the final clock", () => {
    const expired = endPhase(startPhase(createMatch(rules), rules), rules);
    expect(expired).toMatchObject({ phase: "rest", timeLeft: 0 });
    let state = setSanctionCount(expired, "red", "warning", 1, rules);
    state = setSanctionCount(state, "red", "minus_point", 1, rules);
    state = setSanctionCount(state, "blue", "warning", 1, rules);
    state = setSanctionCount(state, "blue", "minus_point", 1, rules);
    expect(getSanctionCount(state, "red", "warning")).toBe(1);
    expect(getSanctionCount(state, "blue", "minus_point")).toBe(1);
    expect(state.rounds[0].totals).toMatchObject({ red: -1, blue: -1 });
    state = setSanctionCount(state, "red", "warning", 0, rules);
    state = setSanctionCount(state, "red", "minus_point", 0, rules);
    expect(getSanctionCount(state, "red", "warning")).toBe(0);
    expect(getSanctionCount(state, "red", "minus_point")).toBe(0);
    expect(state.rounds[0].totals.red).toBe(0);
    expect(expired.rounds[0].events).toEqual([]);
  });

  it("preserves a decided winner and refuses idle, running and Golden Point edits", () => {
    const idle = createMatch(rules);
    const running = startPhase(idle, rules);
    const finished = { ...endPhase(running, rules), phase: "finished" as const,
      result: { winner: "red" as const, reason: "points" as const } };
    const adjusted = setSanctionCount(finished, "blue", "warning", 1, rules);
    expect(adjusted.result).toEqual(finished.result);
    expect(getSanctionCount(adjusted, "blue", "warning")).toBe(1);
    expect(setSanctionCount(idle, "red", "warning", 1, rules)).toBe(idle);
    expect(setSanctionCount(running, "red", "warning", 1, rules)).toBe(running);
    const golden = createGoldenPointMatch(rules);
    expect(setSanctionCount(golden, "red", "warning", 1, rules)).toBe(golden);
  });

  it("reverses the original scoring value when removing a serious warning", () => {
    const running = addMatchEvent(startPhase(createMatch(rules), rules),
      { judgeId: "arbiter", competitor: "red", type: "warning_serious" }, rules);
    const expired = endPhase(running, rules);
    expect(getSanctionCount(expired, "red", "warning")).toBe(1);
    expect(expired.rounds[0].totals.red).toBe(-2);
    const corrected = setSanctionCount(expired, "red", "warning", 0, rules);
    expect(getSanctionCount(corrected, "red", "warning")).toBe(0);
    expect(corrected.rounds[0].totals.red).toBe(0);
    expect(corrected.rounds[0].events.at(-1)).toMatchObject({
      type: "remove_warning_serious", competitor: "red", value: 2,
    });
  });

  it("keeps ordinary direct minus points distinct from an explicit disqualification", () => {
    const strictRules = { ...rules, fouls_for_dq: 2 };
    const expired = endPhase(startPhase(createMatch(strictRules), strictRules), strictRules);
    const adjusted = setSanctionCount(expired, "red", "minus_point", 3, strictRules);
    expect(getSanctionCount(adjusted, "red", "minus_point")).toBe(3);
    expect(adjusted.rounds[0].fouls.red).toBe(0);
    expect(adjusted.result).toBeNull();
  });
});
