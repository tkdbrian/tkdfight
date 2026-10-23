import { afterEach, describe, expect, it } from "vitest";
import { generateDoubleBracket, generateEliminationBracket } from "@/lib/bracket";
import { useTournamentStore, type BracketMatch } from "./tournament";

const initial = useTournamentStore.getState();
afterEach(() => { useTournamentStore.setState(initial, true); localStorage.clear(); });
const competitors = Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, name: `Competidor ${i}` }));
function prepare(count: number): BracketMatch[] {
  const bracket = generateEliminationBracket(competitors.slice(0, count));
  useTournamentStore.setState({ bracketMatches: bracket.matches, bracketSeeds: bracket.seeds, fights: [] });
  return bracket.matches;
}

describe("safe first round reseeding with byes", () => {
  it.each([3, 5])("reassigns an automatic bye in a %i competitor bracket without stale advancement", (count) => {
    const matches = prepare(count);
    const bye = matches.find((m) => m.round === 0 && m.completed)!;
    const ordinary = matches.find((m) => m.round === 0 && !m.completed)!;
    const oldByeId = bye.red.competitor!.id;
    const newByeId = ordinary.red.competitor!.id;
    useTournamentStore.getState().swapBracketSlots(bye.id, "red", ordinary.id, "red");
    const state = useTournamentStore.getState();
    expect(state.bracketMatches.map((m) => m.id)).toEqual(matches.map((m) => m.id));
    expect(state.bracketMatches.find((m) => m.id === bye.id)?.winnerId).toBe(newByeId);
    const next = state.bracketMatches.find((m) => m.red.fromMatchId === bye.id || m.blue.fromMatchId === bye.id)!;
    expect(next.red.fromMatchId === bye.id ? next.red.competitor?.id : next.blue.competitor?.id).toBe(newByeId);
    expect(state.bracketMatches.filter((m) => m.round > 0).flatMap((m) => [m.red.competitor?.id, m.blue.competitor?.id])).not.toContain(oldByeId);
    expect(state.bracketSeeds[bye.position * 2]).toBe(newByeId);
    expect(state.bracketSeeds[ordinary.position * 2]).toBe(oldByeId);
  });
  it("moves the competitor into the empty side of its own bye", () => {
    const matches = prepare(3);
    const bye = matches.find((m) => m.round === 0 && m.completed)!;
    useTournamentStore.getState().swapBracketSlots(bye.id, "red", bye.id, "blue");
    const updated = useTournamentStore.getState().bracketMatches.find((m) => m.id === bye.id)!;
    expect(updated.red.competitor).toBeNull();
    expect(updated.blue.competitor?.id).toBe(bye.winnerId);
    expect(updated.winnerId).toBe(bye.winnerId);
  });
  it.each(["prepared", "completed", "linked", "later-round"])("rejects %s fights or slots without changing the graph", (reason) => {
    const matches = prepare(3);
    const first = matches[0];
    if (reason === "prepared") useTournamentStore.setState({ fights: [{ id: "queued", red: competitors[0], blue: competitors[1], completed: false, bracketMatchId: first.id }] });
    if (reason === "completed") useTournamentStore.setState({ bracketMatches: matches.map((m) => m.id === first.id ? { ...m, completed: true, winnerId: competitors[0].id } : m) });
    if (reason === "linked") useTournamentStore.setState({ bracketMatches: matches.map((m) => m.id === first.id ? { ...m, fightId: "server-fight" } : m) });
    const before = useTournamentStore.getState().bracketMatches;
    useTournamentStore.getState().swapBracketSlots(reason === "later-round" ? matches.at(-1)!.id : first.id, "red", first.id, "blue");
    expect(useTournamentStore.getState().bracketMatches).toEqual(before);
  });
  it("rejects moving competitors between independent A and B brackets", () => {
    const bracket = generateDoubleBracket(competitors);
    useTournamentStore.setState({ bracketMatches: bracket.matches, bracketSeeds: bracket.seeds, fights: [] });
    const a = bracket.matches.find((m) => m.bracketGroup === "A" && m.round === 0)!;
    const b = bracket.matches.find((m) => m.bracketGroup === "B" && m.round === 0)!;
    useTournamentStore.getState().swapBracketSlots(a.id, "red", b.id, "red");
    expect(useTournamentStore.getState().bracketMatches).toEqual(bracket.matches);
  });
  it("rejects a cross-match drop into an empty BYE branch or the same slot", () => {
    const matches = prepare(5);
    const byes = matches.filter((m) => m.round === 0 && m.completed);
    useTournamentStore.getState().swapBracketSlots(byes[0].id, "red", byes[1].id, "blue");
    expect(useTournamentStore.getState().bracketMatches).toEqual(matches);
    useTournamentStore.getState().swapBracketSlots(byes[0].id, "red", byes[0].id, "red");
    expect(useTournamentStore.getState().bracketMatches).toEqual(matches);
  });
  it("recalculates B seeds without changing A or duplicating any competitor", () => {
    const bracket = generateDoubleBracket(competitors);
    useTournamentStore.setState({ bracketMatches: bracket.matches, bracketSeeds: bracket.seeds, fights: [] });
    const [one, two] = bracket.matches.filter((m) => m.bracketGroup === "B" && m.round === 0);
    const originalA = bracket.matches.filter((m) => m.bracketGroup === "A");
    useTournamentStore.getState().swapBracketSlots(one.id, "red", two.id, "red");
    const state = useTournamentStore.getState();
    expect(state.bracketMatches.filter((m) => m.bracketGroup === "A")).toEqual(originalA);
    const ids = state.bracketSeeds.filter((id) => id !== null);
    expect(new Set(ids).size).toBe(17);
    expect(ids).toHaveLength(17);
    expect(state.bracketMatches.find((m) => m.id === one.id)?.red.competitor?.id).toBe(two.red.competitor!.id);
  });
});
