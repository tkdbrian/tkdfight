import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEliminationBracket } from "@/lib/bracket";
import { useTournamentStore } from "@/store/tournament";
import { BracketPage } from "./BracketPage";

const socket = vi.hoisted(() => ({ connected: true, stateReady: true,
  state: { match: null, activeMatchLock: null as null | { categoryId: string; matchId: string } },
  request: vi.fn(async () => null) }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => socket }));
const initial = useTournamentStore.getState();
afterEach(() => { cleanup(); act(() => useTournamentStore.setState(initial, true)); localStorage.clear();
  socket.connected = true; socket.stateReady = true; socket.state.activeMatchLock = null; });

describe("bracket reseeding operating safety", () => {
  it.each(["ready", "own-loaded", "other-loaded", "unknown", "prepared"])("handles %s without changing fights or sending commands", async (mode) => {
    const competitors = ["Pedro", "Juan", "Cris"].map((name) => ({ id: name, name }));
    const bracket = generateEliminationBracket(competitors);
    useTournamentStore.setState({ config: { ...initial.config, id: "selected", mode: "elimination" }, phase: "fighting",
      competitors, bracketMatches: bracket.matches, bracketSeeds: bracket.seeds, fights: [] });
    if (mode === "own-loaded" || mode === "other-loaded") socket.state.activeMatchLock = {
      categoryId: mode === "own-loaded" ? "selected" : "other", matchId: "loaded" };
    if (mode === "unknown") socket.stateReady = false;
    if (mode === "prepared") useTournamentStore.setState({ fights: [{ id: "prepared", red: competitors[0], blue: competitors[1], bracketMatchId: bracket.matches[0].id, completed: false }] });
    const before = useTournamentStore.getState();
    const { container } = await act(async () => render(<MemoryRouter><BracketPage /></MemoryRouter>));
    expect(container.querySelectorAll('rect[fill="transparent"]')).toHaveLength(mode === "ready" || mode === "other-loaded" ? 4 : 0);
    if (mode === "prepared") expect(screen.getByText(/Posiciones bloqueadas: ya hay combates/)).toBeInTheDocument();
    expect(useTournamentStore.getState().fights).toEqual(before.fights);
    expect(useTournamentStore.getState().bracketMatches).toEqual(before.bracketMatches);
    expect(socket.request).not.toHaveBeenCalled();
  });
});
