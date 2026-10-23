import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import { FightPageRoute } from "@/pages/FightPageRoute";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn(), emit: vi.fn(), request: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
const initial = useTournamentStore.getState();
const snapshot = recordedCategory();
const target = snapshot.fights[0];
const other = snapshot.fights[1];
const intent = { kind: "category-continue", categoryId: snapshot.config.id, fightId: target.id };
function HistoryButton(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/fight", { state: intent })}>
      Nueva entrada guardada
    </button>
  );
}
beforeEach(() => {
  useTournamentStore.setState({ ...snapshot, currentFightIndex: 1 });
  mocks.useSocket.mockReturnValue({
    connected: true,
    stateReady: true,
    state: { match: null, activeMatchLock: null },
    request: mocks.request,
    emit: mocks.emit,
    socket: null,
  });
  vi.stubGlobal("fetch", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.emit.mockReset();
  mocks.request.mockReset();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});
describe("validated Combat history entry selection", () => {
  it("honors the saved target once per location entry while allowing passive local browsing", async () => {
    await act(async () =>
      render(
        <MemoryRouter initialEntries={[{ pathname: "/fight", state: intent }]}>
          <FightPageRoute />
          <HistoryButton />
        </MemoryRouter>
      )
    );
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    fireEvent.click(screen.getByTestId(`fight-progress-${other.id}`));
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Nueva entrada guardada" }));
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("prioritizes an authoritative own loaded bout above a saved earlier target", async () => {
    const rules = baseline as RuleSetSparring;
    mocks.useSocket.mockReturnValue({
      connected: true,
      stateReady: true,
      state: {
        categoryId: snapshot.config.id,
        match: { id: other.id, red: other.red, blue: other.blue, ringId: "TEST" },
        matchState: { ...createMatch(rules), phase: "round", timeLeft: 41 },
        resultConfirmed: false,
        rules,
        judges: [],
        judgeVotes: {},
        judgeTotals: {},
        penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
        roundFlags: [],
      },
      request: mocks.request,
      emit: mocks.emit,
      socket: null,
    });
    useTournamentStore.setState({ currentFightIndex: 2 });
    await act(async () =>
      render(
        <MemoryRouter initialEntries={[{ pathname: "/fight", state: intent }]}>
          <FightPageRoute />
        </MemoryRouter>
      )
    );
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(screen.getAllByText("0:41").length).toBeGreaterThan(0);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
