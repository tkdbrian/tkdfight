import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEliminationBracket } from "@/lib/bracket";
import { BracketPage } from "@/pages/BracketPage";
import { StandingsPage } from "@/pages/StandingsPage";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const socket = vi.hoisted(() => ({
  connected: true,
  stateReady: true,
  state: { match: null, activeMatchLock: null },
  request: vi.fn(async () => null),
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => socket }));
vi.mock("canvas-confetti", () => ({ default: vi.fn() }));
const initial = useTournamentStore.getState();
function Location(): React.JSX.Element {
  const location = useLocation();
  return (
    <output data-testid="navigation">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}
afterEach(() => {
  cleanup();
  act(() => useTournamentStore.setState(initial, true));
  localStorage.clear();
  socket.request.mockClear();
});
describe("classification stays secondary to a concrete Combat entry", () => {
  it.each([
    "round-robin",
    "elimination",
  ] as const)("offers a prominent passive Combat action from %s", async (mode) => {
    const snapshot = recordedCategory();
    snapshot.config.mode = mode;
    snapshot.currentFightIndex = 0;
    snapshot.fights[0] = { ...snapshot.fights[0], completed: true, winner: "red" };
    useTournamentStore.setState(snapshot);
    await act(async () =>
      render(
        <MemoryRouter initialEntries={[mode === "elimination" ? "/bracket" : "/standings"]}>
          {mode === "elimination" ? <BracketPage /> : <StandingsPage />}
          <Location />
        </MemoryRouter>
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Ir a Combate" }));
    expect(JSON.parse(screen.getByTestId("navigation").textContent ?? "null")).toEqual({
      pathname: "/fight",
      state: {
        kind: "category-continue",
        categoryId: snapshot.config.id,
        fightId: snapshot.fights[1].id,
      },
    });
    expect(useTournamentStore.getState().fights).toEqual(snapshot.fights);
    expect(socket.request).not.toHaveBeenCalled();
  });
  it("explains explicit elimination round preparation without generating a queued fight", async () => {
    const snapshot = recordedCategory();
    snapshot.config.mode = "elimination";
    snapshot.bracketMatches = generateEliminationBracket(snapshot.competitors).matches;
    snapshot.fights = [];
    useTournamentStore.setState(snapshot);
    const before = JSON.stringify(snapshot.bracketMatches);
    await act(async () =>
      render(
        <MemoryRouter>
          <BracketPage />
        </MemoryRouter>
      )
    );
    expect(screen.getByText(/No hay un combate pendiente preparado/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ir a Combate" })).not.toBeInTheDocument();
    expect(useTournamentStore.getState().fights).toEqual([]);
    expect(JSON.stringify(useTournamentStore.getState().bracketMatches)).toBe(before);
  });
});
