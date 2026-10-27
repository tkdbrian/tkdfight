import { describe, expect, it } from "vitest";
import type { RuleSetSparring } from "@/engine/types";
import { computePenaltyCountsForMatch } from "@/engine/judge-totals";
import { generateEliminationBracket, generateFinalFights,
  generateGroupsTournament, generateTiebreakFights } from "@/lib/bracket";
import { rankRoundRobinGroup, resolveFirstPlace } from "@/lib/round-robin-resolution";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { emptyDemoDeskState, reduceDemoDeskState } from "./reducer";
import { getDemoCategoryOutcome, getDemoPendingFights, getDemoRestAdvisory,
  getDemoRoundRobinActions } from "./selectors";
import type { DemoDeskCommand, DemoDeskState } from "./types";
import { isDemoDeskState } from "./validator";

function dispatch(state: DemoDeskState, command: DemoDeskCommand): DemoDeskState {
  const next = reduceDemoDeskState(state, command, new Date("2026-01-01T00:00:00.000Z"));
  expect(isDemoDeskState(next)).toBe(true);
  return next;
}

function setup(count: number, mode: "round-robin" | "elimination" = "round-robin",
  matchType: "sparring" | "tul" = "sparring"): DemoDeskState {
  let state = emptyDemoDeskState("event-1");
  state = dispatch(state, { type: "category/create", categoryId: "cat-1" });
  state = dispatch(state, { type: "category/configure", categoryId: "cat-1",
    patch: { categoryName: "Prueba", mode, matchType, ruleSet: baseline as RuleSetSparring } });
  for (let index = 0; index < count; index++) {
    state = dispatch(state, { type: "category/addCompetitor", categoryId: "cat-1",
      competitor: { name: `Competidor ${index + 1}` }, competitorId: `C${index + 1}` });
  }
  return dispatch(state, { type: "category/start", categoryId: "cat-1" });
}

function loadFirst(state: DemoDeskState): DemoDeskState {
  return dispatch(state, { type: "fight/load", categoryId: "cat-1",
    fightId: state.categories["cat-1"].fights[0].id });
}

function context(state: DemoDeskState) {
  const active = state.active!;
  return { categoryId: active.categoryId, fightId: active.fightId, loadId: active.loadId };
}

function voteAll(state: DemoDeskState, vote: "red" | "blue" | "draw"): DemoDeskState {
  for (let judge = 1; judge <= 4; judge++) {
    state = dispatch(state, { type: "fight/vote", ...context(state), judgeId: `J${judge}`, vote });
  }
  return state;
}

function confirmFlagFight(state: DemoDeskState, fightId: string,
  vote: "red" | "blue" | "draw"): DemoDeskState {
  state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId });
  state = dispatch(state, { type: "fight/start", ...context(state) });
  state = voteAll(state, vote);
  state = dispatch(state, { type: "fight/finishRound", ...context(state) });
  state = dispatch(state, { type: "fight/confirmRound", ...context(state) });
  return dispatch(state, { type: "fight/confirmResult", ...context(state) });
}

describe("browser-only desk sports parity", () => {
  it("loads the configured 3, 4 or 5 judges even when the rule set is absent or stale", () => {
    for (const judgesCount of [3, 4, 5]) {
      let state = emptyDemoDeskState(`judges-${judgesCount}`);
      state = dispatch(state, { type: "category/create", categoryId: "cat-1" });
      state = dispatch(state, { type: "category/configure", categoryId: "cat-1",
        patch: { categoryName: "Jueces", judgesCount,
          ruleSet: judgesCount === 4 ? null : baseline as RuleSetSparring } });
      for (let index = 1; index <= 3; index++) state = dispatch(state, {
        type: "category/addCompetitor", categoryId: "cat-1",
        competitor: { name: `Atleta ${index}` }, competitorId: `C${index}`,
      });
      state = dispatch(state, { type: "category/start", categoryId: "cat-1" });
      state = loadFirst(state);
      expect(state.active!.rules.judgesCount).toBe(judgesCount);
      state = dispatch(state, { type: "fight/start", ...context(state) });
      state = dispatch(state, { type: "fight/vote", ...context(state),
        judgeId: `J${judgesCount}`, vote: "red" });
      expect(state.active!.judgeVotes[`J${judgesCount}`]).toBe("red");
      expect(() => reduceDemoDeskState(state, { type: "fight/vote", ...context(state),
        judgeId: `J${judgesCount + 1}`, vote: "red" })).toThrow();
    }
  });

  it("inherits five judges when creating a category after one with no rule set", () => {
    let state = emptyDemoDeskState("inherited-judges");
    state = dispatch(state, { type: "category/create", categoryId: "previous" });
    state = dispatch(state, { type: "category/configure", categoryId: "previous",
      patch: { judgesCount: 5, ruleSet: null } });
    state = dispatch(state, { type: "category/create", categoryId: "cat-1" });
    expect(state.categories["cat-1"].config.judgesCount).toBe(5);
    expect(state.categories["cat-1"].config.ruleSet).toBeNull();
    state = dispatch(state, { type: "category/configure", categoryId: "cat-1",
      patch: { categoryName: "Heredada" } });
    for (let index = 1; index <= 3; index++) state = dispatch(state, {
      type: "category/addCompetitor", categoryId: "cat-1",
      competitor: { name: `Atleta ${index}` }, competitorId: `C${index}`,
    });
    state = loadFirst(dispatch(state, { type: "category/start", categoryId: "cat-1" }));
    expect(state.active!.rules.judgesCount).toBe(5);
  });

  it("generates the same groups and pairing order for all RR sizes 3–12", () => {
    for (let count = 3; count <= 12; count++) {
      const state = setup(count);
      const snapshot = state.categories["cat-1"];
      const expected = generateGroupsTournament(snapshot.competitors, "SERPENTINE", "rest-optimized");
      expect(snapshot.groups.map((group) => group.competitors.map((person) => person.id)))
        .toEqual(expected.groups.map((group) => group.competitors.map((person) => person.id)));
      expect(snapshot.fights.map((fight) => [fight.red.id, fight.blue.id, fight.groupId]))
        .toEqual(expected.fights.map((fight) => [fight.red.id, fight.blue.id, fight.groupId]));
      if (count >= 6) for (let index = 1; index < snapshot.fights.length; index++) {
        const previous = snapshot.fights[index - 1];
        const current = snapshot.fights[index];
        expect([previous.red.id, previous.blue.id]).not.toContain(current.red.id);
        expect([previous.red.id, previous.blue.id]).not.toContain(current.blue.id);
      }
    }
  });

  it("prepares only the shared resolver's official RR mini-playoff after a three-way tie", () => {
    let state = setup(3);
    const fights = state.categories["cat-1"].fights;
    state = confirmFlagFight(state, fights[0].id, "red");
    state = confirmFlagFight(state, fights[1].id, "blue");
    state = confirmFlagFight(state, fights[2].id, "red");
    const snapshot = state.categories["cat-1"];
    const rows = rankRoundRobinGroup("G1", snapshot.fights);
    const resolution = resolveFirstPlace("G1", rows, snapshot.fights,
      snapshot.groups[0].competitors.map((person) => person.id));
    expect(resolution.status).toBe("needed");
    expect(resolution.nextIds).toHaveLength(3);
    expect(getDemoRoundRobinActions(state, "cat-1").playoffs[0].canPrepare).toBe(true);
    state = dispatch(state, { type: "category/preparePlayoff", categoryId: "cat-1", groupId: "G1" });
    expect(getDemoRoundRobinActions(state, "cat-1").playoffs[0].canPrepare).toBe(false);
    const extras = state.categories["cat-1"].fights.slice(fights.length);
    const entrants = resolution.nextIds.map((id) => snapshot.competitors.find((person) => person.id === id)!);
    const expected = generateTiebreakFights(entrants, "G1");
    expect(extras.map((fight) => [fight.red.id, fight.blue.id]))
      .toEqual(expected.map((fight) => [fight.red.id, fight.blue.id]));
    expect(extras.every((fight) => fight.playoffKind === "mini" && !!fight.playoffBasis)).toBe(true);
    expect(() => reduceDemoDeskState(state, { type: "category/preparePlayoff",
      categoryId: "cat-1", groupId: "G1" })).toThrow();
  });

  it("prepares a final only after confirmed winners of every RR group", () => {
    let state = setup(6);
    const fixture = state.categories["cat-1"];
    for (const fight of fixture.fights) {
      const first = fixture.groups.find((group) => group.id === fight.groupId)!.competitors[0].id;
      state = confirmFlagFight(state, fight.id, fight.red.id === first ? "red"
        : fight.blue.id === first ? "blue" : "red");
    }
    const winners = state.categories["cat-1"].groups.map((group) => group.competitors[0]);
    expect(getDemoRoundRobinActions(state, "cat-1").canPrepareFinal).toBe(true);
    state = dispatch(state, { type: "category/prepareFinal", categoryId: "cat-1" });
    expect(getDemoRoundRobinActions(state, "cat-1").canPrepareFinal).toBe(false);
    const final = state.categories["cat-1"].fights.at(-1)!;
    const expected = generateFinalFights(winners)[0];
    expect([final.red.id, final.blue.id]).toEqual([expected.red.id, expected.blue.id]);
    expect(final.isFinalFight).toBe(true);
    expect(() => reduceDemoDeskState(state, { type: "category/prepareFinal", categoryId: "cat-1" })).toThrow();
  });

  it("interleaved 11-person groups produce the same three-winner final mini-fixture", () => {
    let state = setup(11);
    const fixture = state.categories["cat-1"];
    for (const fight of fixture.fights) {
      const first = fixture.groups.find((group) => group.id === fight.groupId)!.competitors[0].id;
      state = confirmFlagFight(state, fight.id, fight.red.id === first ? "red"
        : fight.blue.id === first ? "blue" : "red");
    }
    const winners = state.categories["cat-1"].groups.map((group) => group.competitors[0]);
    state = dispatch(state, { type: "category/prepareFinal", categoryId: "cat-1" });
    const finalFights = state.categories["cat-1"].fights.slice(fixture.fights.length);
    expect(finalFights).toHaveLength(3);
    expect(finalFights.map((fight) => [fight.red.id, fight.blue.id]))
      .toEqual(generateFinalFights(winners).map((fight) => [fight.red.id, fight.blue.id]));
  });

  it("uses resolver stages from a direct RR tie through timed extra to Golden Point", () => {
    let state = setup(3);
    const regular = state.categories["cat-1"].fights;
    state = confirmFlagFight(state, regular[0].id, "red");
    state = confirmFlagFight(state, regular[1].id, "red");
    state = confirmFlagFight(state, regular[2].id, "draw");
    // A and B each win against C and draw each other.
    expect(getDemoRoundRobinActions(state, "cat-1").playoffs[0].canPrepare).toBe(true);
    state = dispatch(state, { type: "category/preparePlayoff", categoryId: "cat-1", groupId: "G1" });
    const first = state.categories["cat-1"].fights.at(-1)!;
    expect(first.playoffKind).toBe("direct");
    state = confirmFlagFight(state, first.id, "draw");
    state = dispatch(state, { type: "category/preparePlayoff", categoryId: "cat-1", groupId: "G1" });
    const extra = state.categories["cat-1"].fights.at(-1)!;
    expect(extra.isTiebreakExtra).toBe(true);
    expect(() => reduceDemoDeskState(state, { type: "fight/continueDraw",
      categoryId: "cat-1", fightId: first.id })).toThrow();
    state = confirmFlagFight(state, extra.id, "draw");
    state = dispatch(state, { type: "category/preparePlayoff", categoryId: "cat-1", groupId: "G1" });
    const golden = state.categories["cat-1"].fights.at(-1)!;
    expect(golden.isGoldenPointFight).toBe(true);
    state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId: golden.id });
    for (let judge = 1; judge <= 3; judge++) state = dispatch(state, {
      type: "fight/goldenVote", ...context(state), judgeId: `J${judge}`,
      competitor: "blue", attempt: 1,
    });
    state = dispatch(state, { type: "fight/confirmGolden", ...context(state), attempt: 1 });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    expect(state.history.at(-1)?.winner).toBe("blue");
  });
  it("uses the existing RR5 fixture and records a swapped color winner for the actual athlete", () => {
    let state = setup(5);
    const category = state.categories["cat-1"];
    const expected = generateGroupsTournament(category.competitors, "SERPENTINE", "rest-optimized");
    expect(category.fights.map((fight) => [fight.red.id, fight.blue.id]))
      .toEqual(expected.fights.map((fight) => [fight.red.id, fight.blue.id]));
    state = loadFirst(state);
    const redId = state.active!.red.id;
    const blueId = state.active!.blue.id;
    state = dispatch(state, { type: "fight/swap", ...context(state),
      assignmentRevision: 0, expectedRedId: redId, expectedBlueId: blueId });
    expect(state.active!.red.id).toBe(blueId);
    expect(state.active!.blue.id).toBe(redId);
    expect(state.categories["cat-1"].fights[0].red.id).toBe(blueId);
    expect(() => reduceDemoDeskState(state, { type: "fight/swap", ...context(state),
      assignmentRevision: 0, expectedRedId: redId, expectedBlueId: blueId })).toThrow();
    state = dispatch(state, { type: "fight/start", ...context(state) });
    expect(() => reduceDemoDeskState(state, { type: "fight/swap", ...context(state),
      assignmentRevision: 1, expectedRedId: blueId, expectedBlueId: redId })).toThrow();
    state = voteAll(state, "red");
    state = dispatch(state, { type: "fight/finishRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ red: { id: blueId }, blue: { id: redId },
      winner: "red", flagsRed: 4, flagsBlue: 0 });
    expect(state.categories["cat-1"].fights[0]).toMatchObject({ red: { id: blueId },
      winner: "red", completed: true });
  });

  it("postpones only a never-started fight and keeps the fixture IDs", () => {
    let state = loadFirst(setup(5));
    const ids = state.categories["cat-1"].fights.map((fight) => fight.id);
    state = dispatch(state, { type: "fight/postpone", ...context(state) });
    expect(state.active).toBeNull();
    expect(state.categories["cat-1"].fights.slice(0, 2).map((fight) => fight.id))
      .toEqual([ids[1], ids[0]]);
    expect(new Set(state.categories["cat-1"].fights.map((fight) => fight.id))).toEqual(new Set(ids));
  });

  it("suggests a rested RR5 fight after postponement without reordering again", () => {
    let state = loadFirst(setup(5));
    const ids = state.categories["cat-1"].fights.map((fight) => fight.id);
    state = dispatch(state, { type: "fight/start", ...context(state) });
    state = voteAll(state, "red");
    state = dispatch(state, { type: "fight/finishRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId: ids[1] });
    state = dispatch(state, { type: "fight/postpone", ...context(state) });
    expect(state.categories["cat-1"].fights.map((fight) => fight.id).slice(0, 3))
      .toEqual([ids[0], ids[2], ids[1]]);
    expect(getDemoRestAdvisory(state, "cat-1", ids[2]))
      .toMatchObject({ kind: "suggest", alternativeFightId: ids[1] });
  });

  it("creates the existing elimination bracket and advances the confirmed winner", () => {
    let state = setup(4, "elimination");
    const category = state.categories["cat-1"];
    const bracket = generateEliminationBracket(category.competitors);
    expect(category.bracketMatches.map((match) => [match.round, match.position]))
      .toEqual(bracket.matches.map((match) => [match.round, match.position]));
    state = loadFirst(state);
    const winnerId = state.active!.red.id;
    state = dispatch(state, { type: "fight/start", ...context(state) });
    state = voteAll(state, "red");
    state = dispatch(state, { type: "fight/finishRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    expect(state.categories["cat-1"].bracketMatches.find((match) => match.id === category.fights[0].bracketMatchId))
      .toMatchObject({ completed: true, winnerId });
  });

  it("edits untouched elimination seed slots with the shared BYE-safe transform", () => {
    let state = setup(4, "elimination");
    const before = state.categories["cat-1"];
    const initialIds = before.fights.map((fight) => fight.id);
    const firstRound = before.bracketMatches.filter((match) => match.round === 0);
    const firstRed = firstRound[0].red.competitor?.id;
    const secondRed = firstRound[1].red.competitor?.id;
    state = dispatch(state, { type: "category/swapBracketSlots", categoryId: "cat-1",
      aMatchId: firstRound[0].id, aSlot: "red", bMatchId: firstRound[1].id, bSlot: "red" });
    const after = state.categories["cat-1"];
    expect(after.bracketMatches.find((match) => match.id === firstRound[0].id)?.red.competitor?.id)
      .toBe(secondRed);
    expect(after.bracketMatches.find((match) => match.id === firstRound[1].id)?.red.competitor?.id)
      .toBe(firstRed);
    expect(after.fights.some((fight) => initialIds.includes(fight.id))).toBe(false);
    state = loadFirst(state);
    expect(() => reduceDemoDeskState(state, { type: "category/swapBracketSlots",
      categoryId: "cat-1", aMatchId: firstRound[0].id, aSlot: "red",
      bMatchId: firstRound[1].id, bSlot: "red" })).toThrow();
  });

  it("archives and restarts a category without losing old results or identities", () => {
    let state = setup(3);
    const old = state.categories["cat-1"];
    state = confirmFlagFight(state, old.fights[0].id, "red");
    state = dispatch(state, { type: "category/restart", categoryId: "cat-1",
      mode: "archive", confirm: true });
    const newId = state.selectedCategoryId!;
    expect(newId).not.toBe("cat-1");
    expect(state.archives["cat-1"].fights[0].completed).toBe(true);
    expect(state.history[0].categoryId).toBe("cat-1");
    expect(state.categories[newId].config.categoryName).toBe(old.config.categoryName);
    expect(state.categories[newId].competitors.map((person) => person.id))
      .not.toEqual(old.competitors.map((person) => person.id));
    expect(state.categories[newId].fights.every((fight) => !fight.completed)).toBe(true);
    state = dispatch(state, { type: "category/delete", categoryId: newId, confirm: true });
    expect(state.categoryOrder).toEqual([]);
    expect(state.archives["cat-1"]).toBeDefined();
    expect(state.history).toHaveLength(1);
  });

  it("delete-and-restart discards only the source execution; guest fights stay outside standings", () => {
    let state = setup(3);
    state = dispatch(state, { type: "category/addGuestFight", categoryId: "cat-1",
      redName: "Invitado Rojo", blueName: "Invitado Azul",
      categoryName: "Exhibición", originRing: "Demo" });
    const guest = state.categories["cat-1"].fights.at(-1)!;
    expect(getDemoPendingFights(state, "cat-1").some((fight) => fight.id === guest.id)).toBe(true);
    expect(rankRoundRobinGroup(guest.groupId!, state.categories["cat-1"].fights)).toEqual([]);
    state = confirmFlagFight(state, guest.id, "red");
    state = dispatch(state, { type: "category/restart", categoryId: "cat-1",
      mode: "delete-and-restart", confirm: true });
    expect(state.archives).toEqual({});
    expect(state.history).toEqual([]);
    expect(state.categoryOrder).toHaveLength(1);
    expect(state.selectedCategoryId).not.toBe("cat-1");
  });

  it("a swapped elimination final resolves placement without moving structural bracket slots", () => {
    let state = loadFirst(setup(2, "elimination"));
    const structural = state.categories["cat-1"].bracketMatches[0];
    const redId = state.active!.red.id;
    const blueId = state.active!.blue.id;
    state = dispatch(state, { type: "fight/swap", ...context(state),
      assignmentRevision: 0, expectedRedId: redId, expectedBlueId: blueId });
    state = dispatch(state, { type: "fight/start", ...context(state) });
    state = voteAll(state, "red");
    state = dispatch(state, { type: "fight/finishRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmRound", ...context(state) });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    expect(state.categories["cat-1"].bracketMatches[0].red.competitor?.id)
      .toBe(structural.red.competitor?.id);
    expect(getDemoCategoryOutcome(state, "cat-1"))
      .toMatchObject({ status: "resolved", championId: blueId });
  });

  it("Tul requires a red/blue decision and preserves each table judge vote", () => {
    let state = loadFirst(setup(3, "round-robin", "tul"));
    state = dispatch(state, { type: "fight/start", ...context(state) });
    state = voteAll(state, "draw");
    expect(() => reduceDemoDeskState(state, { type: "fight/tulFinish", ...context(state) })).toThrow();
    state = voteAll(state, "blue");
    state = dispatch(state, { type: "fight/tulFinish", ...context(state) });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    expect(state.history[0]).toMatchObject({ winner: "blue", flagsRed: 0, flagsBlue: 4 });
  });

  it("corrects pending final flags and Tul votes before official confirmation", () => {
    let sparring = loadFirst(setup(3));
    sparring = dispatch(sparring, { type: "fight/start", ...context(sparring) });
    sparring = voteAll(sparring, "red");
    sparring = dispatch(sparring, { type: "fight/finishRound", ...context(sparring) });
    sparring = dispatch(sparring, { type: "fight/confirmRound", ...context(sparring) });
    expect(sparring.active!.state.result?.winner).toBe("red");
    sparring = dispatch(sparring, { type: "fight/undoRound", ...context(sparring) });
    expect(sparring.active!.state.phase).toBe("rest");
    expect(sparring.active!.judgeVotes).toEqual({ J1: "red", J2: "red", J3: "red", J4: "red" });
    sparring = voteAll(sparring, "blue");
    sparring = dispatch(sparring, { type: "fight/confirmRound", ...context(sparring) });
    sparring = dispatch(sparring, { type: "fight/confirmResult", ...context(sparring) });
    expect(sparring.history[0].winner).toBe("blue");

    let tul = loadFirst(setup(3, "round-robin", "tul"));
    tul = dispatch(tul, { type: "fight/start", ...context(tul) });
    tul = voteAll(tul, "red");
    tul = dispatch(tul, { type: "fight/tulRetry", ...context(tul) });
    expect(tul.active!.judgeVotes).toEqual({});
    tul = voteAll(tul, "red");
    tul = dispatch(tul, { type: "fight/tulFinish", ...context(tul) });
    tul = dispatch(tul, { type: "fight/tulUndoFinish", ...context(tul) });
    expect(tul.active!.judgeVotes).toEqual({ J1: "red", J2: "red", J3: "red", J4: "red" });
    tul = voteAll(tul, "blue");
    tul = dispatch(tul, { type: "fight/tulFinish", ...context(tul) });
    tul = dispatch(tul, { type: "fight/confirmResult", ...context(tul) });
    expect(tul.history[0].winner).toBe("blue");
  });

  it("points decision includes post-clock sanctions from the shared judge totals", () => {
    let state = setup(3);
    state = dispatch(state, { type: "category/select", categoryId: "cat-1" });
    // A configured points bout is the same engine as the portable score mode.
    state.categories["cat-1"].config.ruleSet = { ...baseline, judgingMode: "points" } as RuleSetSparring;
    state = loadFirst(state);
    state = dispatch(state, { type: "fight/start", ...context(state) });
    state = dispatch(state, { type: "fight/event", ...context(state),
      judgeId: "J1", competitor: "red", eventType: "pts_1" });
    state = dispatch(state, { type: "fight/finishRound", ...context(state) });
    expect(state.active!.state.phase).toBe("penalties");
    state = dispatch(state, { type: "fight/setSanction", ...context(state),
      competitor: "red", kind: "minus_point", expectedCount: 0, count: 1 });
    expect(computePenaltyCountsForMatch(state.active!.state).fouls.red).toBe(1);
    state = dispatch(state, { type: "fight/confirmPenalties", ...context(state) });
    expect(state.active!.state.result?.winner).toBe("draw");
  });

  it("Golden Point requires an explicit table confirmation", () => {
    let state = setup(2, "elimination");
    state.categories["cat-1"].fights[0].isGoldenPointFight = true;
    state = loadFirst(state);
    expect(state.active!.state.phase).toBe("golden_point");
    for (let judge = 1; judge <= 3; judge++) {
      state = dispatch(state, { type: "fight/goldenVote", ...context(state),
        judgeId: `J${judge}`, competitor: "blue", attempt: 1 });
    }
    expect(state.active!.state.result).toBeNull();
    state = dispatch(state, { type: "fight/confirmGolden", ...context(state), attempt: 1 });
    expect(state.active!.state.result).toMatchObject({ winner: "blue", reason: "golden_point" });
  });

  it("resets an active bout to clean prestart without trapping its sticky started marker", () => {
    let state = loadFirst(setup(3));
    const before = context(state);
    const pair = [state.active!.red.id, state.active!.blue.id];
    state = dispatch(state, { type: "fight/start", ...before });
    state = dispatch(state, { type: "fight/tick", ...before });
    state = dispatch(state, { type: "fight/vote", ...before, judgeId: "J1", vote: "red" });
    state = dispatch(state, { type: "fight/medical", ...before });
    expect(state.active!.paused).toBe(true);
    state = dispatch(state, { type: "fight/reset", ...before });
    expect(state.active).toMatchObject({ started: true, paused: false,
      judgeVotes: {}, roundFlags: [], tulPhase: "idle" });
    expect(state.active!.state).toMatchObject({ phase: "idle", currentRound: 0,
      timeLeft: state.active!.rules.rounds.duration_seconds, result: null });
    expect([state.active!.red.id, state.active!.blue.id]).toEqual(pair);
    expect(state.categories["cat-1"].fights[0].completed).toBe(false);
    expect(state.active!.loadId).not.toBe(before.loadId);
    expect(() => reduceDemoDeskState(state, { type: "fight/start", ...before })).toThrow();
    expect(() => reduceDemoDeskState(state, { type: "fight/swap", ...context(state),
      assignmentRevision: state.active!.assignmentRevision,
      expectedRedId: pair[0], expectedBlueId: pair[1] })).toThrow();
    state = dispatch(state, { type: "fight/start", ...context(state) });
    expect(state.active!.state.phase).toBe("round");
  });

  it("an untouched reset allows prestart swap; skip-to-flags cannot bypass a dirty idle state", () => {
    let state = loadFirst(setup(3));
    const oldContext = context(state);
    state = dispatch(state, { type: "fight/reset", ...oldContext });
    expect(state.active!.started).toBe(false);
    expect(() => reduceDemoDeskState(state, { type: "fight/start", ...oldContext })).toThrow();
    state = dispatch(state, { type: "fight/swap", ...context(state),
      assignmentRevision: 0, expectedRedId: state.active!.red.id,
      expectedBlueId: state.active!.blue.id });
    const dirty = structuredClone(state);
    dirty.active!.judgeVotes.J1 = "red";
    expect(() => reduceDemoDeskState(dirty, { type: "fight/skipToFlags", ...context(dirty) })).toThrow();
    state = dispatch(state, { type: "fight/skipToFlags", ...context(state) });
    expect(state.active!.state.phase).toBe("rest");
    expect(state.active!.started).toBe(true);
  });

  it("an elimination draw continues to a timed extra and then untimed Golden Point", () => {
    let state = loadFirst(setup(2, "elimination"));
    const original = state.active!.fightId;
    const completeDraw = (current: DemoDeskState): DemoDeskState => {
      current = dispatch(current, { type: "fight/start", ...context(current) });
      current = voteAll(current, "draw");
      current = dispatch(current, { type: "fight/finishRound", ...context(current) });
      current = dispatch(current, { type: "fight/confirmRound", ...context(current) });
      return dispatch(current, { type: "fight/confirmResult", ...context(current) });
    };
    state = completeDraw(state);
    state = dispatch(state, { type: "fight/continueDraw", categoryId: "cat-1", fightId: original });
    const extra = state.categories["cat-1"].fights.at(-1)!;
    expect(extra).toMatchObject({ continuationParentFightId: original,
      continuationStage: "timed-extra", isTiebreakExtra: true });
    state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId: extra.id });
    state = completeDraw(state);
    state = dispatch(state, { type: "fight/continueDraw", categoryId: "cat-1", fightId: extra.id });
    const golden = state.categories["cat-1"].fights.at(-1)!;
    expect(golden).toMatchObject({ continuationParentFightId: extra.id,
      continuationStage: "golden-point", isGoldenPointFight: true });
    state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId: golden.id });
    for (let judge = 1; judge <= 3; judge++) {
      state = dispatch(state, { type: "fight/goldenVote", ...context(state),
        judgeId: `J${judge}`, competitor: "red", attempt: 1 });
    }
    state = dispatch(state, { type: "fight/confirmGolden", ...context(state), attempt: 1 });
    state = dispatch(state, { type: "fight/confirmResult", ...context(state) });
    expect(state.categories["cat-1"].bracketMatches.at(-1)?.winnerId).toBe(golden.red.id);
    expect(state.history).toHaveLength(3);
  });

  it("keeps portable one-extra continuation for legacy 1/2/3 settings and either Golden toggle", () => {
    const completeDraw = (current: DemoDeskState): DemoDeskState => {
      current = dispatch(current, { type: "fight/start", ...context(current) });
      current = voteAll(current, "draw");
      current = dispatch(current, { type: "fight/finishRound", ...context(current) });
      current = dispatch(current, { type: "fight/confirmRound", ...context(current) });
      return dispatch(current, { type: "fight/confirmResult", ...context(current) });
    };
    for (const maxTiebreakers of [1, 2, 3]) for (const goldenEnabled of [false, true]) {
      let state = setup(2, "elimination");
      state.categories["cat-1"].config.maxTiebreakers = maxTiebreakers;
      state.categories["cat-1"].config.tiebreakerSeconds = 45;
      state.categories["cat-1"].config.ruleSet = { ...baseline,
        rounds: { ...baseline.rounds, golden_point: goldenEnabled, overtime_seconds: 90 } } as RuleSetSparring;
      state = loadFirst(state);
      const firstId = state.active!.fightId;
      state = completeDraw(state);
      state = dispatch(state, { type: "fight/continueDraw", categoryId: "cat-1", fightId: firstId });
      const extra = state.categories["cat-1"].fights.at(-1)!;
      expect(extra).toMatchObject({ continuationStage: "timed-extra", tiebreakerSeconds: 45 });
      state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId: extra.id });
      expect(state.active!.rules.rounds.duration_seconds).toBe(45);
      state = completeDraw(state);
      state = dispatch(state, { type: "fight/continueDraw", categoryId: "cat-1", fightId: extra.id });
      const golden = state.categories["cat-1"].fights.at(-1)!;
      expect(golden).toMatchObject({ continuationStage: "golden-point", isGoldenPointFight: true });
      state = dispatch(state, { type: "fight/load", categoryId: "cat-1", fightId: golden.id });
      expect(state.active!.state).toMatchObject({ phase: "golden_point", timeLeft: 0 });
    }
  });
});
