import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import { FightPage } from "@/pages/FightPage";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import { type FightEntry, useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({
  useSocket: vi.fn(),
  emit: vi.fn(),
  request: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));

const initialStore = useTournamentStore.getState();
const rules = itfRules as RuleSetSparring;
const categoryId = "review-category";
const completed: FightEntry = {
  id: "completed-A",
  red: { id: "a", name: "Anterior rojo" },
  blue: { id: "b", name: "Anterior azul" },
  groupId: "G1",
  completed: true,
  winner: "red",
  flagsRed: 3,
  flagsBlue: 1,
  warningsRed: 2,
  warningsBlue: 1,
  foulsRed: 1,
  foulsBlue: 0,
};
const nextFight: FightEntry = {
  id: "next-B",
  red: { id: "c", name: "Actual rojo" },
  blue: { id: "d", name: "Actual azul" },
  groupId: "G1",
  completed: false,
};

function serverState(fight: FightEntry, phase: "idle" | "round" | "finished" = "round"): ServerState {
  return {
    rules,
    categoryId,
    match: { id: fight.id, ringId: "TEST", red: fight.red, blue: fight.blue },
    matchState: { ...createMatch(rules), phase, timeLeft: phase === "finished" ? 0 : 47 },
    matchPaused: false,
    resultConfirmed: phase === "finished",
    judges: [],
    judgeVotes: {},
    judgeTotals: {},
    penaltyCounts: { warnings: { red: 0, blue: 5 }, fouls: { red: 0, blue: 2 } },
    fallos: [],
    roundFlags: [],
    serverUrl: "",
  };
}

function useServerState(state: ServerState): void {
  mocks.useSocket.mockReturnValue({
    connected: true,
    stateReady: true,
    state,
    emit: mocks.emit,
    request: mocks.request,
    socket: { on: vi.fn(), off: vi.fn() },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
  Element.prototype.scrollIntoView = vi.fn();
  mocks.request.mockImplementation(async (event: string, input: { matchId?: string }) => {
    if (event === "match:result:get" && input.matchId === completed.id) {
      return { ok: true, result: {
        fightId: completed.id, categoryId, status: "confirmed", winner: "red", reason: "flags",
        flagsRed: 3, flagsBlue: 1, warningsRed: 2, warningsBlue: 1, foulsRed: 1, foulsBlue: 0,
      } };
    }
    return { ok: true, result: null };
  });
  act(() => useTournamentStore.setState({
    ...initialStore,
    config: { ...initialStore.config, id: categoryId, mode: "round-robin", ruleSet: rules },
    fights: [completed, nextFight],
    currentFightIndex: 1,
    phase: "fighting",
  }));
});

afterEach(() => {
  cleanup();
  act(() => useTournamentStore.setState(initialStore));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("consultar combates anteriores sin cambiar el combate operativo", () => {
  it.each(["idle", "round"] as const)("keeps completed A selected while B is %s and repeated state updates arrive", async (phase) => {
    useServerState(serverState(nextFight, phase));
    const view = render(<FightPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: phase === "idle" ? "Iniciar combate" : "Pausar" }).length).toBeGreaterThan(0));
    mocks.request.mockClear();
    mocks.emit.mockClear();

    fireEvent.click(screen.getByTestId(`fight-progress-${completed.id}`));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(screen.getAllByText("Resultado").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Pausar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Iniciar combate" })).toBeNull();
    expect(screen.queryByText("⚠ 5 adv")).toBeNull();
    expect(screen.getByText("⚠ 2 adv")).toBeInTheDocument();

    for (const timeLeft of [46, 45, 44]) {
      useServerState({ ...serverState(nextFight, phase), matchState: { ...createMatch(rules), phase, timeLeft } });
      view.rerender(<FightPage />);
      await act(async () => {});
      expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    }
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: /Rehacer combate/ }).every((button) => button.hasAttribute("disabled"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Volver al combate activo" }));
    await waitFor(() => expect(useTournamentStore.getState().currentFightIndex).toBe(1));
    await waitFor(() => expect(screen.getAllByRole("button", { name: phase === "idle" ? "Iniciar combate" : "Pausar" }).length).toBeGreaterThan(0));
    expect(screen.getAllByText("0:44").length).toBeGreaterThan(0);
    expect(mocks.emit).not.toHaveBeenCalled();
  }, 15_000); // Full-page render plus several broadcasts can contend with the complete parallel suite.

  it("does not leak the previously confirmed server match into the next unloaded bout", async () => {
    useServerState(serverState(completed, "finished"));
    render(<FightPage />);
    await act(async () => {});
    expect(screen.queryAllByText("Terminado")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Cargar combate" })).toHaveLength(2);
    expect(screen.queryByText("⚠ 5 adv")).toBeNull();
    mocks.request.mockClear();
    fireEvent.click(screen.getByTestId(`fight-progress-${completed.id}`));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Volver al combate activo" })).toBeNull();
  });

  it("can review A while B awaits result confirmation without confirming B on navigation", async () => {
    const pending = serverState(nextFight, "finished");
    pending.resultConfirmed = false;
    pending.matchState = { ...createMatch(rules), phase: "finished", result: { winner: "blue", reason: "points" } };
    useServerState(pending);
    render(<FightPage />);
    await act(async () => {});
    mocks.request.mockClear();
    fireEvent.click(screen.getByTestId(`fight-progress-${completed.id}`));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(screen.getAllByText("Resultado").length).toBeGreaterThan(0);
    expect(screen.getByText("⚠ 2 adv")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Siguiente pelea/ })).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ir al combate pendiente" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Siguiente pelea/ }).length).toBeGreaterThan(0));
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("still recovers a confirmed result missing locally after initial mount", async () => {
    act(() => useTournamentStore.setState({
      fights: [{ ...completed, completed: false, winner: undefined }, nextFight],
      currentFightIndex: 0,
    }));
    useServerState(serverState(completed, "finished"));
    render(<FightPage />);
    await waitFor(() => expect(useTournamentStore.getState().fights[0].completed).toBe(true));
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(mocks.request).toHaveBeenCalledWith("match:result:get", { categoryId, matchId: completed.id });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("does not auto-advance a late recovery response after A becomes completed locally", async () => {
    let resolveResult: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(() => new Promise((resolve) => { resolveResult = resolve; }));
    act(() => useTournamentStore.setState({
      fights: [{ ...completed, completed: false, winner: undefined }, nextFight],
      currentFightIndex: 0,
    }));
    useServerState(serverState(completed, "finished"));
    render(<FightPage />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:result:get", { categoryId, matchId: completed.id }));
    act(() => useTournamentStore.setState({ fights: [completed, nextFight] }));
    await act(async () => resolveResult({ ok: true, result: {
      fightId: completed.id, categoryId, status: "confirmed", winner: "red", reason: "flags",
      flagsRed: 3, flagsBlue: 1, warningsRed: 2, warningsBlue: 1, foulsRed: 1, foulsBlue: 0,
    } }));
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(screen.getAllByText("Resultado").length).toBeGreaterThan(0);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("recovers an unapplied confirmed result again on reconnect after manual navigation", async () => {
    act(() => useTournamentStore.setState({ fights: [{ ...completed, completed: false, winner: undefined }, nextFight] }));
    useServerState(serverState(nextFight));
    const view = render(<FightPage />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId(`fight-progress-${completed.id}`));
    await act(async () => {});
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
    mocks.useSocket.mockReturnValue({ ...mocks.useSocket(), connected: false });
    view.rerender(<FightPage />);
    await act(async () => {});
    useServerState(serverState(completed, "finished"));
    view.rerender(<FightPage />);
    await waitFor(() => expect(useTournamentStore.getState().fights[0].completed).toBe(true));
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps completed results readable offline and ignores another category's state", async () => {
    useServerState({ ...serverState(nextFight), categoryId: "other-category" });
    const view = render(<FightPage />);
    fireEvent.click(screen.getByTestId(`fight-progress-${completed.id}`));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(screen.queryByRole("button", { name: "Volver al combate activo" })).toBeNull();
    mocks.useSocket.mockReturnValue({ ...mocks.useSocket(), connected: false });
    view.rerender(<FightPage />);
    await act(async () => {});
    expect(screen.getAllByText("Resultado").length).toBeGreaterThan(0);
    expect(screen.getByText("⚠ 2 adv")).toBeInTheDocument();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("does not auto-load a pending extra bout just because the user selects it", async () => {
    act(() => useTournamentStore.setState({
      config: { ...useTournamentStore.getState().config, mode: "elimination" },
      fights: [completed, nextFight, { ...nextFight, id: "extra", isTiebreakExtra: true }],
    }));
    useServerState(serverState(nextFight));
    render(<FightPage />);
    await act(async () => {});
    mocks.request.mockClear();
    mocks.emit.mockClear();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    fireEvent.click(screen.getByTestId("fight-progress-extra"));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(2);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["locked", "disconnected", "unknown"])("does not reset a reviewed result if confirmation became %s", async (condition) => {
    act(() => useTournamentStore.setState({ currentFightIndex: 0 }));
    useServerState(serverState(completed, "finished"));
    const view = render(<FightPage />);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: /Rehacer combate/ })[0]);
    expect(screen.getAllByRole("button", { name: "Sí, resetear" })[0]).not.toBeDisabled();

    if (condition === "locked") useServerState(serverState(nextFight));
    else mocks.useSocket.mockReturnValue({
      ...mocks.useSocket(),
      connected: condition !== "disconnected",
      stateReady: condition !== "unknown",
    });
    view.rerender(<FightPage />);
    mocks.request.mockClear();
    mocks.emit.mockClear();
    for (const button of screen.getAllByRole("button", { name: "Sí, resetear" })) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    await act(async () => {});
    expect(useTournamentStore.getState().fights[0]).toEqual(completed);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it.each(["sync-409", "load-rejected"])("preserves a completed result when redo is rejected at %s", async (rejection) => {
    act(() => useTournamentStore.setState({ currentFightIndex: 0 }));
    useServerState(serverState(completed, "finished"));
    vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
      ok: rejection !== "sync-409" || input !== "/api/ring/sync-fights",
      status: input === "/api/ring/sync-fights" && rejection === "sync-409" ? 409 : 200,
      json: async () => input === "/api/ring/status"
        ? { activeMatchLock: null }
        : input === "/api/ring/sync-fights" ? { error: "conflict" } : [],
    })));
    mocks.request.mockResolvedValue({ ok: false, code: "fight_already_completed", error: "Resultado ya confirmado" });
    render(<FightPage />);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: /Rehacer combate/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Sí, resetear" })[0]);
    await act(async () => {});
    expect(useTournamentStore.getState().fights[0]).toEqual(completed);
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(useTournamentStore.getState().categoryOperationReason).toBeNull();
    if (rejection === "load-rejected") expect(mocks.request).toHaveBeenCalledWith("match:load", expect.anything());
    else expect(mocks.request).not.toHaveBeenCalled();
  });
});

describe("etiqueta del fallo sin cambiar los banderines ni la clasificación", () => {
  it.each([
    { mode: "round-robin", reason: "points", expected: "Banderines de los jueces" },
    { mode: "elimination", reason: "points", expected: "Puntos" },
    { mode: "round-robin", reason: "golden_point", expected: "Punto de oro" },
    { mode: "elimination", reason: "golden_point", expected: "Punto de oro" },
  ] as const)("shows $expected for $mode/$reason without changing the 0–4 result", async ({ mode, reason, expected }) => {
    act(() => useTournamentStore.setState({ config: { ...useTournamentStore.getState().config, mode } }));
    useServerState(serverState(nextFight));
    const view = render(<FightPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Pausar" }).length).toBeGreaterThan(0));
    const finished = serverState(nextFight, "finished");
    finished.resultConfirmed = false;
    finished.roundFlags = [{ red: 0, blue: 4, winner: "blue" }];
    finished.matchState = {
      ...createMatch(rules), phase: "finished", result: { winner: "blue", reason },
      ...(reason === "golden_point" ? { goldenPoint: {
        attempt: 1, votes: { J1: "blue", J2: "blue", J3: "blue", J4: "blue" },
      } } : {}),
    };
    useServerState(finished);
    view.rerender(<FightPage />);
    const overlay = await screen.findByRole("dialog", { name: "Resultado del combate" });
    expect(within(overlay).getByText(expected, { exact: true })).toBeInTheDocument();
    expect(overlay).toHaveTextContent(/🔴 0\s*—\s*4 🔵/);
    expect(useTournamentStore.getState().fights).toEqual([completed, nextFight]);
    expect(mocks.emit).not.toHaveBeenCalled();
  }, 15_000);
});

describe("identificar el combate que bloquea una nueva carga", () => {
  const waiting = { ...nextFight, id: "waiting-C", red: { id: "e", name: "Espera rojo" },
    blue: { id: "f", name: "Espera azul" } };
  function pendingState(): ServerState {
    return { ...serverState(nextFight, "finished"), resultConfirmed: false,
      activeMatchLock: { categoryId, fightId: nextFight.id, tournamentId: 1, resultStatus: "pending_confirmation" },
      matchState: { ...createMatch(rules), phase: "finished", result: { winner: "red", reason: "points" } } };
  }
  function viewWaiting(): void {
    act(() => useTournamentStore.setState({ fights: [completed, nextFight, waiting], currentFightIndex: 2 }));
  }

  it("shows the pending fight number and names, disables both loads and returns locally without commands", async () => {
    viewWaiting(); useServerState(pendingState());
    render(<FightPage />);
    const notice = screen.getByTestId("fight-review-notice");
    expect(notice).toHaveTextContent("Falta confirmar el combate 2: Actual rojo vs. Actual azul");
    expect(notice).not.toHaveTextContent(nextFight.id);
    for (const load of screen.getAllByRole("button", { name: "Cargar combate" })) {
      expect(load).toBeDisabled(); fireEvent.click(load);
    }
    mocks.request.mockClear(); mocks.emit.mockClear();
    fireEvent.click(within(notice).getByRole("button", { name: "Ir al combate pendiente" }));
    await waitFor(() => expect(useTournamentStore.getState().currentFightIndex).toBe(1));
    expect(screen.getAllByRole("button", { name: /Siguiente pelea/ }).length).toBeGreaterThan(0);
    expect(useTournamentStore.getState().fights[1].completed).toBe(false);
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("distinguishes an active fight from a result awaiting confirmation", () => {
    viewWaiting(); useServerState(serverState(nextFight));
    render(<FightPage />);
    const notice = screen.getByTestId("fight-review-notice");
    expect(notice).toHaveTextContent("El combate 2: Actual rojo vs. Actual azul sigue cargado");
    expect(notice).not.toHaveTextContent("Falta confirmar");
    expect(within(notice).getByRole("button", { name: "Volver al combate activo" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cargar combate" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it.each(["missing-local", "other-category"])("never guesses a local fight when the lock is %s", (condition) => {
    viewWaiting();
    const pending = pendingState();
    if (condition === "missing-local") {
      pending.match = { ...pending.match!, id: "missing-fight" };
      pending.activeMatchLock = { ...pending.activeMatchLock!, fightId: "missing-fight" };
    } else {
      pending.categoryId = "other-category";
      pending.activeMatchLock = { ...pending.activeMatchLock!, categoryId: "other-category" };
    }
    useServerState(pending); render(<FightPage />);
    const notice = screen.getByTestId("fight-review-notice");
    expect(notice).toHaveTextContent(/Actual rojo vs\. Actual azul/);
    expect(within(notice).queryByRole("button", { name: "Ir al combate pendiente" })).toBeNull();
    expect(notice).toHaveTextContent(/categoría|llave local/);
    expect(screen.getAllByRole("button", { name: "Cargar combate" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(useTournamentStore.getState().currentFightIndex).toBe(2);
  });

  it("allows only local return while disconnected without enabling another load", async () => {
    viewWaiting(); useServerState(pendingState());
    mocks.useSocket.mockReturnValue({ ...mocks.useSocket(), connected: false });
    render(<FightPage />);
    expect(screen.getByTestId("fight-review-notice")).toHaveTextContent(/sin conexión/i);
    expect(screen.getAllByRole("button", { name: "Cargar combate" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ir al combate pendiente" }));
    await waitFor(() => expect(useTournamentStore.getState().currentFightIndex).toBe(1));
    expect(mocks.emit).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });

  it("uses refused-load metadata for a race but ignores a late refusal after local navigation", async () => {
    viewWaiting();
    const idle = serverState(waiting, "idle"); idle.match = null; idle.matchState = null;
    useServerState(idle);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ activeMatchLock: null }) })));
    let resolveLoad: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(async (event: string) => event === "match:load"
      ? new Promise((resolve) => { resolveLoad = resolve; }) : { ok: true, result: null });
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:load", expect.anything()));
    fireEvent.click(screen.getByTestId(`fight-progress-${completed.id}`));
    await act(async () => resolveLoad({ ok: false, code: "match_in_progress",
      blockedFightId: nextFight.id, blockedCategoryId: categoryId, pendingConfirmation: true,
      blockedRedName: nextFight.red.name, blockedBlueName: nextFight.blue.name,
      error: "Falta confirmar el resultado de Actual rojo vs. Actual azul." }));
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(screen.queryByTestId("fight-review-notice")).toBeNull();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("shows actionable refused-load metadata until a newer broadcast releases the lock", async () => {
    viewWaiting();
    const idle = serverState(waiting, "idle"); idle.match = null; idle.matchState = null;
    useServerState(idle);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ activeMatchLock: null }) })));
    mocks.request.mockImplementation(async (event: string) => event === "match:load"
      ? { ok: false, code: "match_in_progress", blockedFightId: nextFight.id, blockedCategoryId: categoryId,
        pendingConfirmation: true, blockedRedName: nextFight.red.name, blockedBlueName: nextFight.blue.name }
      : { ok: true, result: null });
    const view = render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    const notice = await screen.findByTestId("fight-review-notice");
    expect(notice).toHaveTextContent("Falta confirmar el combate 2: Actual rojo vs. Actual azul");
    expect(within(notice).getByRole("button", { name: "Ir al combate pendiente" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cargar combate" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    useServerState({ ...idle }); view.rerender(<FightPage />);
    await waitFor(() => expect(screen.queryByTestId("fight-review-notice")).toBeNull());
    expect(screen.getAllByRole("button", { name: "Cargar combate" }).every((button) => !button.hasAttribute("disabled"))).toBe(true);
    expect(useTournamentStore.getState().currentFightIndex).toBe(2);
  });

  it("stops a same-category status race before synchronizing or loading another fight", async () => {
    viewWaiting();
    const idle = serverState(waiting, "idle"); idle.match = null; idle.matchState = null;
    useServerState(idle);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200,
      json: async () => url === "/api/ring/status" ? { activeMatchLock: {
        fightId: nextFight.id, categoryId, resultStatus: "pending_confirmation" } } : [] })));
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    await screen.findByRole("button", { name: "Ir al combate pendiente" });
    expect(screen.getByTestId("fight-review-notice")).toHaveTextContent("Falta confirmar el combate 2");
    expect(fetch).not.toHaveBeenCalledWith("/api/ring/sync-fights", expect.anything());
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
    expect(useTournamentStore.getState().currentFightIndex).toBe(2);
  });
});
