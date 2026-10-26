import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("shows operative swapped colors in detail without reseeding the bracket", async () => {
    const competitors = ["Alice", "Bob"].map((name) => ({ id: name, name }));
    const bracket = generateEliminationBracket(competitors);
    const match = bracket.matches.find((entry) => entry.red.competitor && entry.blue.competitor);
    if (!match?.red.competitor || !match.blue.competitor) throw new Error("Test requires a full match");
    const red = match.red.competitor;
    const blue = match.blue.competitor;
    useTournamentStore.setState({
      config: { ...initial.config, id: "selected", mode: "elimination" }, phase: "fighting",
      competitors, bracketMatches: bracket.matches, bracketSeeds: bracket.seeds,
      fights: [{ id: "prepared", red: blue, blue: red, bracketMatchId: match.id, completed: false }],
    });
    const { container } = await act(async () => render(<MemoryRouter><BracketPage /></MemoryRouter>));
    const matchNode = container.querySelector("svg g.cursor-pointer");
    if (!matchNode) throw new Error("Expected selectable match");
    fireEvent.click(matchNode);
    expect(screen.getByText(/Colores operativos del combate intercambiados/)).toBeInTheDocument();
    expect(useTournamentStore.getState().bracketMatches).toEqual(bracket.matches);
  });

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
