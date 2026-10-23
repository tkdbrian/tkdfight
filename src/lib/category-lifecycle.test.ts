import { describe, expect, it } from "vitest";
import { generateDoubleBracket, generateEliminationBracket } from "@/lib/bracket";
import {
  type CategoryPrimaryActionContext,
  createRestartReplacement,
  getCategoryPrimaryAction,
  resolveEliminationOutcome,
} from "@/lib/category-lifecycle";
import { recordedCategory } from "@/test/category-restart-fixtures";

describe("restart replacement", () => {
  it("creates a clean RR execution, preserving human configuration and order only", () => {
    const previous = recordedCategory(6);
    previous.fights[0] = { ...previous.fights[0], completed: true, winner: "red", flagsRed: 3 };
    previous.fights.push({ ...previous.fights[0], id: "old-playoff", isTiebreakExtra: true });
    const frozen = JSON.stringify(previous);
    const next = createRestartReplacement(previous);
    expect(next.config).toEqual({ ...previous.config, id: next.config.id });
    expect(next.config.id).not.toBe(previous.config.id);
    expect(next.competitors.map(({ id: _id, ...human }) => human)).toEqual(
      previous.competitors.map(({ id: _id, ...human }) => human)
    );
    expect(
      next.competitors.every((c) => !previous.competitors.some((old) => old.id === c.id))
    ).toBe(true);
    expect(next.groups.map((g) => g.id)).toEqual(["G1", "G2"]);
    expect(next.groups[0]).not.toBe(previous.groups[0]);
    expect(next.fights).toHaveLength(6);
    expect(
      next.fights.every(
        (f) => !f.completed && !f.winner && !f.isTiebreakExtra && f.flagsRed === undefined
      )
    ).toBe(true);
    expect(next.currentFightIndex).toBe(0);
    expect(JSON.stringify(previous)).toBe(frozen);
  });

  it.each([
    5, 17,
  ])("rebuilds elimination %i entrants without old advancement, keeping automatic byes", (count) => {
    const previous = recordedCategory(count);
    previous.config.mode = "elimination";
    const generated =
      count > 16
        ? generateDoubleBracket(previous.competitors)
        : generateEliminationBracket(previous.competitors);
    previous.bracketMatches = generated.matches;
    previous.bracketSeeds = generated.seeds;
    previous.bracketMatches[0].winnerId = previous.competitors[0].id;
    previous.fights = [
      {
        id: "old-final",
        red: previous.competitors[0],
        blue: previous.competitors[1],
        completed: true,
        winner: "red",
        groupId: "FINAL_AB",
        isFinalFight: true,
      },
    ];
    const next = createRestartReplacement(previous);
    expect(next.fights).toEqual([]);
    expect(next.groups).toEqual([]);
    expect(
      next.bracketMatches.every((m) => !previous.bracketMatches.some((old) => old.id === m.id))
    ).toBe(true);
    expect(new Set(next.bracketSeeds.filter(Boolean))).toEqual(
      new Set(next.competitors.map((c) => c.id))
    );
    expect(next.bracketMatches.some((m) => m.completed)).toBe(true);
    expect(
      next.bracketMatches.every(
        (m) => !m.winnerId || next.competitors.some((c) => c.id === m.winnerId)
      )
    ).toBe(true);
  });
});

describe("category primary action", () => {
  const context = (snapshot = recordedCategory()): CategoryPrimaryActionContext => ({
    snapshot,
    connected: true,
    stateReady: true,
    resultsVerified: true,
    serverState: { match: null, activeMatchLock: null },
  });

  it("continues stored RR even when phase is results or another category owns the tatami", () => {
    const input = context();
    input.serverState = {
      match: null,
      activeMatchLock: {
        fightId: "other-fight",
        categoryId: "other",
        resultStatus: "pending_confirmation",
      },
    };
    expect(getCategoryPrimaryAction(input)).toMatchObject({
      label: "Ir a Combate",
      route: "/fight",
      fightId: input.snapshot.fights[input.snapshot.currentFightIndex].id,
      kind: "continue",
    });
  });

  it("distinguishes new valid, invalid and offline start without blocking stored consultation", () => {
    const snapshot = recordedCategory();
    snapshot.fights = [];
    snapshot.groups = [];
    snapshot.phase = "setup";
    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({
      kind: "start",
      disabled: false,
    });
    snapshot.config.categoryName = "";
    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({
      kind: "start",
      disabled: true,
    });
    snapshot.config.categoryName = "Valid";
    expect(getCategoryPrimaryAction({ ...context(snapshot), connected: false })).toMatchObject({
      disabled: true,
    });
    expect(getCategoryPrimaryAction({ ...context(), connected: false })).toMatchObject({
      kind: "continue",
      disabled: false,
    });
  });

  it("preserves a selected pending bout but skips a completed selection using stored queue order", () => {
    const snapshot = recordedCategory();
    snapshot.currentFightIndex = 1;
    expect(getCategoryPrimaryAction(context(snapshot)).fightId).toBe(snapshot.fights[1].id);
    snapshot.fights[1] = { ...snapshot.fights[1], completed: true, winner: "red" };
    expect(getCategoryPrimaryAction(context(snapshot)).fightId).toBe(snapshot.fights[0].id);
    snapshot.fights[0] = { ...snapshot.fights[0], completed: true, winner: "red" };
    expect(getCategoryPrimaryAction(context(snapshot)).fightId).toBe(snapshot.fights[2].id);
  });

  it("leaves invalid old playoffs for explicit review and never generates empty elimination rounds", () => {
    const snapshot = recordedCategory();
    snapshot.fights = snapshot.fights.map((fight) => ({ ...fight, completed: true, winner: "draw" }));
    snapshot.fights.push({ ...snapshot.fights[0], id: "premature-extra", completed: false, winner: undefined, isTiebreakExtra: true });
    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({ route: "/standings", reason: expect.any(String) });
    snapshot.config.mode = "elimination";
    snapshot.bracketMatches = generateEliminationBracket(snapshot.competitors).matches;
    snapshot.fights = [];
    const before = JSON.stringify(snapshot);
    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({ route: "/bracket", reason: expect.any(String) });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it.each([
    "active",
    "pending_confirmation",
  ])("prioritizes own %s lock over local completed outcome", (resultStatus) => {
    const input = context();
    input.serverState = {
      match: null,
      activeMatchLock: {
        fightId: input.snapshot.fights[0].id,
        categoryId: input.snapshot.config.id,
        resultStatus,
      },
    };
    expect(getCategoryPrimaryAction(input)).toMatchObject({
      kind: resultStatus === "pending_confirmation" ? "review" : "fight",
      route: "/fight",
    });
  });

  it("does not call a completed RR regular queue finished before its cross-group final", () => {
    const snapshot = recordedCategory(6);
    snapshot.fights = snapshot.fights.map((f) => ({ ...f, completed: true, winner: "red" }));
    expect(getCategoryPrimaryAction(context(snapshot)).kind).toBe("continue");
  });

  it("shows results only for a resolved RR outcome and not an unresolved circular tie", () => {
    const snapshot = recordedCategory();
    snapshot.fights = snapshot.fights.map((f) => ({
      ...f,
      completed: true,
      winner: f.red.id === "entrant-0" || f.blue.id !== "entrant-0" ? "red" : "blue",
    }));
    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({
      kind: "results",
      route: "/results",
    });
    snapshot.fights = snapshot.fights.map((f) => ({ ...f, winner: "draw" }));
    expect(getCategoryPrimaryAction(context(snapshot)).kind).toBe("continue");
  });

  it("keeps a local champion provisional until its existing server confirmations are verified", () => {
    const snapshot = recordedCategory();
    snapshot.fights = snapshot.fights.map((f) => ({
      ...f,
      completed: true,
      winner: f.red.id === "entrant-0" || f.blue.id !== "entrant-0" ? "red" : "blue",
    }));
    expect(getCategoryPrimaryAction({ ...context(snapshot), resultsVerified: false }).kind).toBe(
      "continue"
    );
    expect(getCategoryPrimaryAction({ ...context(snapshot), connected: false }).kind).toBe(
      "continue"
    );
    expect(getCategoryPrimaryAction({ ...context(snapshot), stateReady: false }).kind).toBe(
      "continue"
    );
  });

  it("requires decisive FINAL_AB after both double-bracket champions", () => {
    const snapshot = recordedCategory(17);
    snapshot.config.mode = "elimination";
    const generated = generateDoubleBracket(snapshot.competitors);
    let matches = generated.matches;
    for (const original of generated.matches) {
      const current = matches.find((match) => match.id === original.id);
      const winner = current?.red.competitor ?? current?.blue.competitor;
      if (!current || !winner) throw new Error("Invalid bracket fixture");
      matches = matches.map((match) => {
        if (match.id === current.id) return { ...match, completed: true, winnerId: winner.id };
        if (match.red.fromMatchId === current.id)
          return { ...match, red: { ...match.red, competitor: winner } };
        if (match.blue.fromMatchId === current.id)
          return { ...match, blue: { ...match.blue, competitor: winner } };
        return match;
      });
    }
    snapshot.bracketMatches = matches;
    const red = snapshot.competitors.find((competitor) => competitor.id ===
      matches.filter((match) => match.bracketGroup === "A").at(-1)?.winnerId);
    const blue = snapshot.competitors.find((competitor) => competitor.id ===
      matches.filter((match) => match.bracketGroup === "B").at(-1)?.winnerId);
    if (!red || !blue) throw new Error("Missing group finalists");
    snapshot.fights = matches.flatMap((match) => {
      if (!match.red.competitor || !match.blue.competitor) return [];
      return [{ id: `bracket-${match.id}`, red: match.red.competitor,
        blue: match.blue.competitor, bracketMatchId: match.id, completed: true,
        winner: match.winnerId === match.red.competitor.id ? "red" as const : "blue" as const }];
    });
    expect(getCategoryPrimaryAction(context(snapshot)).kind).toBe("continue");
    snapshot.fights.push(
      {
        id: "ab",
        red,
        blue,
        completed: true,
        winner: "draw",
        isFinalFight: true,
        groupId: "FINAL_AB",
      },
    );
    expect(getCategoryPrimaryAction(context(snapshot)).kind).toBe("continue");
    snapshot.fights[snapshot.fights.length - 1].winner = "red";
    expect(getCategoryPrimaryAction(context(snapshot)).kind).toBe("results");
  });
});

describe("elimination outcome authority", () => {
  it("keeps a completed semifinal pending while the final remains unplayed", () => {
    const snapshot = recordedCategory(4);
    snapshot.config.mode = "elimination";
    snapshot.bracketMatches = generateEliminationBracket(snapshot.competitors).matches;
    snapshot.bracketMatches[0] = {
      ...snapshot.bracketMatches[0], completed: true,
      winnerId: snapshot.bracketMatches[0].red.competitor?.id,
    };
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({ status: "pending",
      championId: null, runnerUpId: null });
  });

  it("resolves a complete simple final and reports its durable result dependency", () => {
    const snapshot = recordedCategory(3);
    snapshot.config.mode = "elimination";
    snapshot.competitors = snapshot.competitors.slice(0, 2);
    snapshot.bracketMatches = generateEliminationBracket(snapshot.competitors).matches;
    const final = snapshot.bracketMatches[0];
    snapshot.bracketMatches[0] = { ...final, completed: true,
      winnerId: snapshot.competitors[0].id };
    snapshot.fights = [{ id: "simple-final", red: snapshot.competitors[0],
      blue: snapshot.competitors[1], bracketMatchId: final.id, completed: true,
      winner: "red", isFinalFight: true }];
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({ status: "resolved",
      championId: snapshot.competitors[0].id, runnerUpId: snapshot.competitors[1].id,
      decisiveFightId: "simple-final", requiredResultIds: ["simple-final"] });
  });

  it("requires exact timed-extra to golden-point lineage before awarding gold", () => {
    const snapshot = recordedCategory(3);
    snapshot.config.mode = "elimination";
    snapshot.competitors = snapshot.competitors.slice(0, 2);
    const [red, blue] = snapshot.competitors;
    const final = generateEliminationBracket(snapshot.competitors).matches[0];
    snapshot.bracketMatches = [{ ...final, completed: true, winnerId: blue.id }];
    const original = { id: "original", red, blue, bracketMatchId: final.id,
      completed: true, winner: "draw" as const, isFinalFight: true };
    const extra = { ...original, id: "extra", isTiebreakExtra: true,
      continuationParentFightId: original.id, continuationStage: "timed-extra" as const };
    const gp = { ...original, id: "gp", winner: "blue" as const,
      isGoldenPointFight: true, continuationParentFightId: extra.id,
      continuationStage: "golden-point" as const };
    snapshot.fights = [original, extra];
    expect(resolveEliminationOutcome(snapshot).status).toBe("pending");
    snapshot.fights.push({ ...gp, continuationParentFightId: "other" });
    expect(resolveEliminationOutcome(snapshot).status).toBe("review");
    snapshot.fights[2] = gp;
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({ status: "resolved",
      championId: blue.id, runnerUpId: red.id, decisiveFightId: gp.id,
      requiredResultIds: [original.id, extra.id, gp.id] });
  });

  it("requires review rather than guessing between duplicate historical extras", () => {
    const snapshot = recordedCategory(3);
    snapshot.config.mode = "elimination";
    snapshot.competitors = snapshot.competitors.slice(0, 2);
    const [red, blue] = snapshot.competitors;
    const final = generateEliminationBracket(snapshot.competitors).matches[0];
    snapshot.bracketMatches = [{ ...final, completed: true, winnerId: red.id }];
    const original = { id: "original", red, blue, bracketMatchId: final.id,
      completed: true, winner: "draw" as const, isFinalFight: true };
    snapshot.fights = [original, ...["a", "b"].map((id) => ({ ...original, id,
      isTiebreakExtra: true, winner: "red" as const }))];
    expect(resolveEliminationOutcome(snapshot)).toMatchObject({ status: "review",
      championId: null });
  });

  it("reviews an invalid semifinal lineage even when a final fight looks decisive", () => {
    const snapshot = recordedCategory(4);
    snapshot.config.mode = "elimination";
    const matches = generateEliminationBracket(snapshot.competitors).matches;
    const [a, , c] = snapshot.competitors;
    snapshot.bracketMatches = [
      { ...matches[0], completed: true, winnerId: "unknown-athlete" },
      { ...matches[1], completed: true, winnerId: c.id },
      { ...matches[2], completed: true, winnerId: a.id,
        red: { ...matches[2].red, competitor: a },
        blue: { ...matches[2].blue, competitor: c } },
    ];
    snapshot.fights = [{ id: "final", red: a, blue: c, completed: true,
      winner: "red", bracketMatchId: matches[2].id, isFinalFight: true }];
    expect(resolveEliminationOutcome(snapshot).status).toBe("review");
  });

  it("reviews a completed bracket with a missing contested semifinal result", () => {
    const snapshot = recordedCategory(4);
    snapshot.config.mode = "elimination";
    const generated = generateEliminationBracket(snapshot.competitors);
    let matches = generated.matches;
    for (const original of generated.matches) {
      const current = matches.find((match) => match.id === original.id);
      const winner = current?.red.competitor ?? current?.blue.competitor;
      if (!current || !winner) throw new Error("Invalid bracket fixture");
      matches = matches.map((match) => {
        if (match.id === current.id) return { ...match, completed: true, winnerId: winner.id };
        if (match.red.fromMatchId === current.id)
          return { ...match, red: { ...match.red, competitor: winner } };
        if (match.blue.fromMatchId === current.id)
          return { ...match, blue: { ...match.blue, competitor: winner } };
        return match;
      });
    }
    snapshot.bracketMatches = matches;
    const final = matches.at(-1);
    if (!final?.red.competitor || !final.blue.competitor)
      throw new Error("Missing final contestants");
    snapshot.fights = [{ id: "final-only", red: final.red.competitor,
      blue: final.blue.competitor, bracketMatchId: final.id,
      completed: true, winner: "red", isFinalFight: true }];
    expect(resolveEliminationOutcome(snapshot).status).toBe("review");
  });
});

for (const [mode, count] of [["elimination", 0], ["elimination", 1], ["round-robin", 0], ["round-robin", 1], ["round-robin", 2]] as const) {
  it(`restarts ${mode} with ${count} current entrants as an untouched-history setup draft`, () => {
    const previous = recordedCategory(4);
    previous.config.mode = mode;
    previous.competitors = previous.competitors.slice(0, count);
    const before = structuredClone(previous);
    const next = createRestartReplacement(previous);
    expect(next).toMatchObject({ phase: "setup", setupStarted: false, currentFightIndex: 0,
      fights: [], groups: [], bracketMatches: [], bracketSeeds: [] });
    expect(next.competitors).toHaveLength(count);
    expect(next.config).toEqual({ ...previous.config, id: next.config.id });
    expect(next.config.id).not.toBe(previous.config.id);
    expect(next.competitors.map(({ id: _id, ...entry }) => entry)).toEqual(previous.competitors.map(({ id: _id, ...entry }) => entry));
    expect(next.competitors.every((entry) => !previous.competitors.some((old) => old.id === entry.id))).toBe(true);
    expect(previous).toEqual(before);
    expect(getCategoryPrimaryAction({ snapshot: next, connected: true, stateReady: true, serverState: {} })).toMatchObject({ kind: "start", disabled: true });
  });
}
