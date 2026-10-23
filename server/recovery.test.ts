import { describe, expect, it } from "vitest";
import baselineRules from "../src/rules/rules/rules_sparring_itf_baseline.json";
import { addMatchEvent, createMatch, startPhase } from "../src/engine/match-machine";
import type { RuleSetSparring } from "../src/engine/types";
import type { MatchSnapshotData } from "./db/index";
import { computePenaltyCounts } from "./helpers";
import { recoverIndividualFlagMatchState } from "./recovery";
import { state } from "./state";

const rules = baselineRules as RuleSetSparring;

describe("RR operational snapshot recovery", () => {
  it("restores recorded penalties instead of rebuilding an empty round", () => {
    const started = startPhase(createMatch(rules), rules);
    const withPenalty = addMatchEvent(started,
      { judgeId: "arbiter", competitor: "red", type: "minus_point" }, rules);
    const withWarning = addMatchEvent(withPenalty,
      { judgeId: "arbiter", competitor: "blue", type: "warning_minor" }, rules);
    const data: MatchSnapshotData = { match: {}, rules: {}, roundFlags: [], matchState: withWarning };
    expect(recoverIndividualFlagMatchState(data)).toEqual(withWarning);
    expect(recoverIndividualFlagMatchState(data)?.rounds[0]?.events).toMatchObject([
      { judgeId: "arbiter", competitor: "red", type: "minus_point" },
      { judgeId: "arbiter", competitor: "blue", type: "warning_minor" },
    ]);
    const previous = state.matchState;
    try {
      state.matchState = recoverIndividualFlagMatchState(data);
      expect(computePenaltyCounts()).toEqual({
        fouls: { red: 1, blue: 0 }, warnings: { red: 0, blue: 1 },
      });
    } finally {
      state.matchState = previous;
    }
  });

  it("fails closed for an older or malformed RR snapshot without event history", () => {
    expect(recoverIndividualFlagMatchState({ match: {}, rules: {}, roundFlags: [] })).toBeNull();
    expect(recoverIndividualFlagMatchState({
      match: {}, rules: {}, roundFlags: [],
      matchState: { ...createMatch(rules), rounds: [{}] } as never,
    })).toBeNull();
  });
});

describe('Tul phase recovery', () => {
  it('recovers reopened voting instead of idle or the obsolete winner', async () => {
    const recovery = await import('./recovery');
    const data: MatchSnapshotData = { match: { matchMode: 'tul' }, rules: {}, roundFlags: [],
      matchState: { ...createMatch(rules), phase: 'rest', result: null },
      judgeVotes: { J1: 'red', J2: 'blue' } };
    expect(recovery.recoverTulPhase(data)).toBe('voting');
    expect(recovery.recoverTulPhase({ ...data, matchState: { ...createMatch(rules),
      phase: 'finished', result: { winner: 'blue', reason: 'points' } } })).toBe('finished');
  });
});
