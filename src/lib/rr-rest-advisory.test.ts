import { describe, expect, it } from "vitest";
import { findRoundRobinRestAdvisory, parseLastConfirmedRestReply } from "@/lib/rr-rest-advisory";
import type { FightEntry } from "@/store/tournament";

function bout(id: string, red: string, blue: string, extra = false): FightEntry {
  return {
    id,
    red: { id: red, name: red, team: "" },
    blue: { id: blue, name: blue, team: "" },
    groupId: "G1",
    completed: false,
    ...(extra ? { isTiebreakExtra: true, playoffBasis: "valid" } : {}),
  };
}

const last = {
  fightId: "ab",
  categoryId: "category",
  redId: "A",
  blueId: "B",
  confirmedAt: "2026-10-26T12:00:00.000Z",
};

describe("round-robin rest advisory", () => {
  it("suggests the earliest eligible disjoint bout without changing postponed order", () => {
    const fights = [bout("ab", "A", "B"), bout("ae", "A", "E"), bout("cd", "C", "D")];
    fights[0] = { ...fights[0], completed: true };
    const before = fights.map((fight) => fight.id);
    expect(findRoundRobinRestAdvisory(fights, "ae", last)).toEqual({
      kind: "suggest",
      alternativeFightId: "cd",
      alternativeIndex: 2,
    });
    expect(fights.map((fight) => fight.id)).toEqual(before);
  });

  it("reports unavoidable rest when a three- or four-person queue has no disjoint bout", () => {
    const fights = [bout("ab", "A", "B"), bout("ac", "A", "C"), bout("bc", "B", "C")];
    expect(findRoundRobinRestAdvisory(fights, "ac", last)).toEqual({ kind: "unavoidable" });
    expect(findRoundRobinRestAdvisory([...fights, bout("ad", "A", "D")], "ac", last)).toEqual({
      kind: "unavoidable",
    });
  });

  it("does not suggest a playoff ahead of unfinished regular groups", () => {
    const fights = [bout("ab", "A", "B"), bout("ac", "A", "C"), bout("extra", "D", "E", true)];
    expect(findRoundRobinRestAdvisory(fights, "ac", last, () => true)).toEqual({
      kind: "unavoidable",
    });
  });

  it("requires authorized playoffs once regular fights finish", () => {
    const fights = [
      { ...bout("ab", "A", "B"), completed: true },
      bout("ac", "A", "C"),
      bout("extra", "D", "E", true),
    ];
    expect(findRoundRobinRestAdvisory(fights, "ac", last, () => false)).toEqual({
      kind: "unavoidable",
    });
    fights[1] = { ...fights[1], completed: true };
    expect(findRoundRobinRestAdvisory(fights, "extra", last, () => true)).toEqual({ kind: "none" });
  });

  it("can suggest an authorized disjoint playoff only across the finished regular boundary", () => {
    const fights = [
      { ...bout("ab", "A", "B"), completed: true },
      bout("extra-one", "A", "C", true),
      bout("extra-two", "D", "E", true),
    ];
    expect(findRoundRobinRestAdvisory(fights, "extra-one", last, () => false)).toEqual({
      kind: "unavoidable",
    });
    expect(findRoundRobinRestAdvisory(fights, "extra-one", last, () => true)).toEqual({
      kind: "suggest",
      alternativeFightId: "extra-two",
      alternativeIndex: 2,
    });
  });

  it("rejects uncertain or malformed last-result replies", () => {
    expect(parseLastConfirmedRestReply({ ok: true, last, ambiguous: false })).toEqual({
      kind: "known",
      last,
    });
    expect(parseLastConfirmedRestReply({ ok: true, last: null, ambiguous: true })).toEqual({
      kind: "ambiguous",
    });
    expect(parseLastConfirmedRestReply({ ok: true, last: null, ambiguous: false })).toEqual({
      kind: "known",
      last: null,
    });
    expect(
      parseLastConfirmedRestReply({ ok: true, last: { ...last, redId: null }, ambiguous: false })
    ).toEqual({ kind: "unavailable" });
    expect(parseLastConfirmedRestReply({ ok: false })).toEqual({ kind: "unavailable" });
  });
});
