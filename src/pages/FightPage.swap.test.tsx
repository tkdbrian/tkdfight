import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FightPage, withMatchContext } from "@/pages/FightPage";
import { useTournamentStore } from "@/store/tournament";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn(), request: vi.fn(), emit: vi.fn(), navigate: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));

const initial = useTournamentStore.getState();
const rules = baseline as RuleSetSparring;
const fight = {
  id: "swap-fight",
  red: { id: "red-id", name: "Alice", team: "A" },
  blue: { id: "blue-id", name: "Bob", team: "B" },
  groupId: "G1",
  completed: false,
};
const listeners = new Map<string, Array<(state: ServerState) => void>>();
const socket = {
  on: vi.fn((event: string, callback: (state: ServerState) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), callback]);
  }),
  off: vi.fn((event: string, callback: (state: ServerState) => void) => {
    listeners.set(event, (listeners.get(event) ?? []).filter((listener) => listener !== callback));
  }),
};
function serverState(): ServerState {
  return {
    rules,
    match: {
      id: fight.id, ringId: "T1", matchMode: "sparring", red: { ...fight.red }, blue: { ...fight.blue },
      preFight: { loadId: "load-one", revision: 0, started: false, timingKind: "regular" },
    },
    categoryId: "swap-category", matchState: createMatch(rules), matchPaused: false,
    resultConfirmed: false, judges: ["J1"], judgeVotes: {}, judgeTotals: {}, roundFlags: [],
    penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
    fallos: [], serverUrl: "",
  };
}
function setup(state = serverState(), connected = true): void {
  mocks.useSocket.mockReturnValue({ connected, stateReady: true, state, emit: mocks.emit,
    request: mocks.request, socket });
}
function swapped(state = serverState()): ServerState {
  const match = state.match;
  const preFight = match?.preFight;
  if (!match || !preFight) throw new Error("Test requires a loaded match");
  return {
    ...state,
    match: { ...match, red: match.blue, blue: match.red,
      preFight: { ...preFight, revision: preFight.revision + 1,
        swapCount: (preFight.swapCount ?? 0) + 1 } },
  };
}

beforeEach(() => {
  listeners.clear();
  mocks.request.mockReset().mockResolvedValue({ ok: true, result: null });
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
  Element.prototype.scrollIntoView = vi.fn();
  act(() => useTournamentStore.setState({ ...initial,
    config: { ...initial.config, id: "swap-category", matchType: "sparring", mode: "round-robin", ruleSet: rules },
    fights: [fight], currentFightIndex: 0, phase: "fighting",
  }));
  setup();
});
afterEach(() => {
  cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals();
  act(() => useTournamentStore.setState(initial));
});

describe("loaded sparring competitor swap", () => {
  it("accepts an already-aligned completed fight without mutating its result", () => {
    act(() => useTournamentStore.setState({ fights: [{ ...fight, completed: true, winner: "red" }] }));
    const store = useTournamentStore.getState();
    expect(store.reconcileFightColors("swap-category", fight.id, "red-id", "blue-id")).toBe(true);
    expect(store.reconcileFightColors("swap-category", fight.id, "blue-id", "red-id")).toBe(false);
    expect(useTournamentStore.getState().fights[0]).toMatchObject({
      red: { id: "red-id" }, blue: { id: "blue-id" }, winner: "red", completed: true,
    });
  });

  it("fences scoring commands only after an assignment swap", () => {
    expect(withMatchContext("mesa:flagVote", { vote: "red" }, "cat", "fight",
      { loadId: "load", revision: 3, swapCount: 1, started: true, timingKind: "regular" }))
      .toEqual({ vote: "red", categoryId: "cat", matchId: "fight",
        expectedLoadId: "load", expectedAssignmentRevision: 3 });
    expect(withMatchContext("mesa:flagVote", { vote: "red" }, "cat", "fight",
      { loadId: "load", revision: 3, swapCount: 0, started: true, timingKind: "regular" }))
      .toEqual({ vote: "red", categoryId: "cat", matchId: "fight" });
  });

  it("exchanges assignments only after canonical ACK and matching broadcast, leaving Start blocked meanwhile", async () => {
    let reply: (response: unknown) => void = () => {};
    mocks.request.mockImplementation((event: string) => event === "match:swapCompetitors"
      ? new Promise((resolve) => { reply = resolve; }) : Promise.resolve({ ok: true, result: null }));
    const view = render(<FightPage />);
    const button = await screen.findByRole("button", { name: "Intercambiar competidores" });
    expect(button).toBeEnabled();
    fireEvent.click(button); fireEvent.click(button);
    const calls = mocks.request.mock.calls.filter((call) => call[0] === "match:swapCompetitors");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ categoryId: "swap-category", matchId: fight.id,
      expectedLoadId: "load-one", expectedRevision: 0, expectedRedId: "red-id", expectedBlueId: "blue-id" });
    expect(screen.getAllByRole("button", { name: "Iniciar combate" })[0]).toBeDisabled();
    expect(useTournamentStore.getState().fights[0].red.id).toBe("red-id");
    const next = swapped();
    await act(async () => reply({ ok: true, match: next.match }));
    expect(useTournamentStore.getState().fights[0].red.id).toBe("red-id");
    await act(async () => { for (const listener of listeners.get("state:update") ?? []) listener(next); });
    setup(next); view.rerender(<FightPage />);
    await waitFor(() => expect(useTournamentStore.getState().fights[0].red.id).toBe("blue-id"));
    expect(useTournamentStore.getState().fights[0].blue.id).toBe("red-id");
    for (const layout of ["desktop", "mobile"]) {
      expect(screen.getByTestId(`red-station-${layout}`)).toHaveTextContent("Bob");
      expect(screen.getByTestId(`blue-station-${layout}`)).toHaveTextContent("Alice");
    }
    expect(screen.getAllByRole("button", { name: "Iniciar combate" })[0]).toBeEnabled();
    expect(mocks.emit).not.toHaveBeenCalledWith("match:start", expect.anything());
  });

  it("reconciles another tab's swap before Start and prevents duplicate local re-swap", async () => {
    const view = render(<FightPage />);
    const next = swapped(); setup(next); view.rerender(<FightPage />);
    await waitFor(() => expect(useTournamentStore.getState().fights[0].red.id).toBe("blue-id"));
    expect(screen.getAllByRole("button", { name: "Iniciar combate" })[0]).toBeEnabled();
    setup(next); view.rerender(<FightPage />);
    expect(useTournamentStore.getState().fights[0].red.id).toBe("blue-id");
  });

  it("keeps Start blocked on uncertain ACK or an unrecognized color assignment", async () => {
    mocks.request.mockImplementation((event: string) => event === "match:swapCompetitors"
      ? Promise.resolve(null) : Promise.resolve({ ok: true, result: null }));
    const view = render(<FightPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Intercambiar competidores" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Iniciar combate" })[0]).toBeDisabled());
    const unknown = serverState();
    if (!unknown.match) throw new Error("Test requires a loaded match");
    unknown.match.red.id = "unknown";
    setup(unknown); view.rerender(<FightPage />);
    expect(screen.getAllByRole("button", { name: "Iniciar combate" })[0]).toBeDisabled();
    expect(useTournamentStore.getState().fights[0].red.id).toBe("red-id");
  });

  it("recovers an uncertain swap when another tab starts the canonical swapped bout", async () => {
    mocks.request.mockImplementation((event: string) => event === "match:swapCompetitors"
      ? Promise.resolve(null) : Promise.resolve({ ok: true, result: null }));
    const view = render(<FightPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Intercambiar competidores" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("No llegó la confirmación"));
    expect(useTournamentStore.getState().fights[0].red.id).toBe("red-id");

    const started = swapped();
    if (!started.match?.preFight || !started.matchState) throw new Error("Test requires a loaded match");
    started.match.preFight.started = true;
    started.matchState = { ...started.matchState, phase: "round" };
    setup(started); view.rerender(<FightPage />);

    await waitFor(() => expect(useTournamentStore.getState().fights[0].red.id).toBe("blue-id"));
    expect(screen.queryByText(/Iniciar combate permanece bloqueado/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pausar" })[0]).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Intercambiar competidores" })).not.toBeInTheDocument();
  });

  it("ignores a delayed swap ACK after the started bout has been reconciled", async () => {
    let reply: (response: unknown) => void = () => {};
    mocks.request.mockImplementation((event: string) => event === "match:swapCompetitors"
      ? new Promise((resolve) => { reply = resolve; }) : Promise.resolve({ ok: true, result: null }));
    const view = render(<FightPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Intercambiar competidores" }));
    const started = swapped();
    if (!started.match?.preFight || !started.matchState) throw new Error("Test requires a loaded match");
    started.match.preFight.started = true;
    started.matchState = { ...started.matchState, phase: "round" };
    setup(started); view.rerender(<FightPage />);
    await waitFor(() => expect(useTournamentStore.getState().fights[0].red.id).toBe("blue-id"));
    await act(async () => reply({ ok: true, match: started.match }));
    expect(useTournamentStore.getState().fights[0].red.id).toBe("blue-id");
    expect(screen.getAllByRole("button", { name: "Pausar" })[0]).toBeEnabled();
  });

  it("uses durable result-get color IDs to map a confirmed result after reload", async () => {
    const state = serverState(); state.match = null; state.matchState = null;
    act(() => useTournamentStore.setState({
      config: { ...useTournamentStore.getState().config, mode: "elimination" },
    }));
    mocks.request.mockImplementation((event: string) => event === "match:result:get"
      ? Promise.resolve({ ok: true, redId: "blue-id", blueId: "red-id", result: {
          fightId: fight.id, categoryId: "swap-category", winner: "red", reason: "points",
          flagsRed: 3, flagsBlue: 1, warningsRed: 0, warningsBlue: 0,
          foulsRed: 0, foulsBlue: 0, status: "confirmed", revision: 1,
        } }) : Promise.resolve({ ok: true, result: null }));
    setup(state);
    render(<FightPage />);
    await waitFor(() => expect(useTournamentStore.getState().fights[0].completed).toBe(true));
    const recovered = useTournamentStore.getState().fights[0];
    expect(recovered.red.name).toBe("Bob");
    expect(recovered.blue.name).toBe("Alice");
    expect(recovered.winner).toBe("red");
  });

  it.each(["tul", "started", "continuation", "golden", "disconnected"])(
    "does not offer swap for %s", async (kind) => {
      const state = serverState();
      if (!state.match?.preFight) throw new Error("Test requires a loaded match");
      if (kind === "tul") state.match.matchMode = "tul";
      if (kind === "started") state.match.preFight.started = true;
      if (kind === "continuation") state.match.preFight.timingKind = "continuation";
      if (kind === "golden") state.match.goldenPoint = true;
      setup(state, kind !== "disconnected");
      if (kind === "tul") act(() => useTournamentStore.setState({ config: { ...useTournamentStore.getState().config, matchType: "tul" } }));
      render(<FightPage />);
      expect(screen.queryByRole("button", { name: "Intercambiar competidores" })).not.toBeInTheDocument();
    },
  );
});
