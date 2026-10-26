import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import { FightPage } from "@/pages/FightPage";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { type FightEntry, useTournamentStore } from "@/store/tournament";
import { useCategoryDeletionState } from "@/store/category-deletion-state";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn(), emit: vi.fn(), request: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
const initial = useTournamentStore.getState();
const rules = baseline as RuleSetSparring;
const categoryId = "passive-category";
const pending: FightEntry = {
  id: "pending",
  red: { id: "a", name: "Ana" },
  blue: { id: "b", name: "Bruno" },
  completed: false,
  groupId: "G1",
};
const imported: FightEntry = { ...pending, id: "imported", importedFrom: "T2" };
const intent = { kind: "category-continue", categoryId, fightId: pending.id };
let connected = true;
let ready = true;
let state: ServerState;
const socket = { on: vi.fn(), off: vi.fn(), emit: vi.fn() };
function emptyState(): ServerState {
  return {
    rules: null,
    match: null,
    matchState: null,
    matchPaused: false,
    judges: [],
    judgeVotes: {},
    judgeTotals: {},
    penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
    fallos: [],
    roundFlags: [],
    serverUrl: "",
  };
}
function ownState(phase: "idle" | "round" | "finished" = "round"): ServerState {
  return {
    ...emptyState(),
    rules,
    categoryId,
    match: { id: pending.id, ringId: "TEST", red: pending.red, blue: pending.blue },
    resultConfirmed: false,
    matchState: {
      ...createMatch(rules),
      phase,
      timeLeft: 47,
      ...(phase === "finished" ? { result: { winner: "red" as const, reason: "points" } } : {}),
    },
  };
}
function Route(): React.JSX.Element {
  return <output data-testid="route">{useLocation().pathname}</output>;
}
function mount(entry: unknown = intent): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/fight"]}>
      <FightPage navigationIntent={entry} />
      <Route />
    </MemoryRouter>
  );
}
beforeEach(() => {
  connected = true;
  ready = true;
  state = emptyState();
  mocks.useSocket.mockImplementation(() => ({
    connected,
    stateReady: ready,
    state,
    request: mocks.request,
    emit: mocks.emit,
    socket,
  }));
  mocks.request.mockResolvedValue({ ok: true, result: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify([{ fight: { ...imported, categoryId, sourceRing: "T3" } }]))
    )
  );
  Element.prototype.scrollIntoView = vi.fn();
  useTournamentStore.setState({
    ...initial,
    config: {
      ...initial.config,
      id: categoryId,
      mode: "round-robin",
      ruleSet: rules,
      matchType: "sparring",
    },
    competitors: [pending.red, pending.blue],
    fights: [pending, imported],
    currentFightIndex: 0,
    phase: "fighting",
  });
});
afterEach(() => {
  cleanup();
  useCategoryDeletionState.setState({ pending: false, recoveryRequired: false, message: null, observed: [] });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.request.mockReset();
  mocks.emit.mockReset();
  socket.on.mockReset();
  socket.off.mockReset();
  socket.emit.mockReset();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("passive continuation into Combat", () => {
  it("keeps visible controls and latest command forwarding readonly during deletion recovery", async () => {
    state = ownState("round");
    mount();
    await act(async () => {});
    const pause = screen.getAllByRole("button", { name: /Pausar/ })[0];
    if (!pause) throw new Error("Missing pause control");
    expect(pause).toBeEnabled();
    act(() => useCategoryDeletionState.setState({ recoveryRequired: true }));
    expect(pause).toBeDisabled();
    fireEvent.click(pause);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("preserves imported records and local progress without mount synchronization or result application", async () => {
    mocks.request.mockResolvedValue({
      ok: true,
      result: {
        fightId: pending.id,
        categoryId,
        status: "confirmed",
        winner: "red",
        reason: "points",
        flagsRed: 3,
        flagsBlue: 0,
        warningsRed: 0,
        warningsBlue: 0,
        foulsRed: 0,
        foulsBlue: 0,
      },
    });
    const before = localStorage.getItem("tkd-tournament");
    await act(async () => {
      mount();
    });
    expect(useTournamentStore.getState().fights).toEqual([pending, imported]);
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(localStorage.getItem("tkd-tournament")).toBe(before);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("route")).toHaveTextContent("/fight");
  });

  it("does not load pending GP/extra bouts on mount, browsing or reconnect", async () => {
    const extra = { ...pending, id: "extra", isTiebreakExtra: true };
    useTournamentStore.setState({
      config: { ...useTournamentStore.getState().config, mode: "elimination" },
      fights: [extra, { ...pending, id: "golden", isGoldenPointFight: true }],
      currentFightIndex: 0,
    });
    const entry = { ...intent, fightId: extra.id };
    const view = mount(entry);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("fight-progress-golden"));
    connected = false;
    ready = false;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={entry} />
        <Route />
      </MemoryRouter>
    );
    await act(async () => {});
    connected = true;
    ready = true;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={entry} />
        <Route />
      </MemoryRouter>
    );
    await act(async () => {});
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
  });

  it("rehydrates an own running bout without reset, and explicit pause stays one normal command", async () => {
    state = ownState();
    await act(async () => {
      mount();
    });
    expect(screen.getAllByText("0:47").length).toBeGreaterThan(0);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Pausar" })[0]);
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith(
      "match:pause",
      expect.objectContaining({ categoryId, matchId: pending.id })
    );
  });

  it("shows the authoritative own pending result even when the local record already says completed", async () => {
    useTournamentStore.setState({
      fights: [{ ...pending, completed: true, winner: "blue" }, imported],
    });
    state = ownState("finished");
    await act(async () => {
      mount();
    });
    expect(
      screen.getAllByRole("button", { name: /Siguiente pelea|Revisar|Confirmar resultado/ }).length
    ).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: /Rehacer combate/ })).toHaveLength(0);
    expect(useTournamentStore.getState().fights[0].winner).toBe("blue");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps explicit Cargar and Iniciar as the normal two actions, never starting a clock during loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
        String(input).includes("last-confirmed")
          ? { ok: true, last: null, ambiguous: false }
          : { activeMatchLock: null }
      )))
    );
    socket.on.mockImplementation((event: string, listener: (value: ServerState) => void) => {
      if (event === "state:update" && state.match?.id === pending.id) listener(state);
    });
    mocks.request.mockImplementation(async (event: string) => {
      if (event === "match:load") {
        state = ownState("idle");
        return { ok: true };
      }
      return { ok: true, result: null };
    });
    const view = mount();
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    });
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("match:load", expect.anything())
    );
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Iniciar combate" })[0]).toBeEnabled()
    );
    expect(mocks.emit).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Iniciar combate" })[0]);
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith("match:start", {
      categoryId,
      matchId: pending.id,
    });
  });

  it("presents pending own result correction immediately and explicit confirmation uses the existing save flow", async () => {
    state = { ...ownState("finished"), resultRevision: 4 };
    const result = {
      fightId: pending.id,
      categoryId,
      status: "confirmed",
      winner: "red",
      reason: "points",
      flagsRed: 3,
      flagsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    };
    mocks.request.mockImplementation(async (event: string) =>
      event === "match:saveFallo" ? { ok: true, result } : { ok: true, result: null }
    );
    await act(async () => {
      mount();
    });
    const review = screen.getByRole("dialog", { name: "Resultado del combate" });
    expect(within(review).getByRole("button", { name: /Corregir banderines/ })).toBeEnabled();
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.click(within(review).getByRole("button", { name: /Confirmar resultado/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
    });
    await waitFor(() => expect(useTournamentStore.getState().fights[0].completed).toBe(true));
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(mocks.request).toHaveBeenCalledWith("match:saveFallo", {
      categoryId,
      matchId: pending.id,
      expectedRevision: 4,
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps explicit Corregir banderines on the existing acknowledged correction flow", async () => {
    state = { ...ownState("finished"), resultRevision: 2 };
    const listeners = new Set<(value: ServerState) => void>();
    socket.on.mockImplementation((event: string, listener: (value: ServerState) => void) => {
      if (event === "state:update") listeners.add(listener);
    });
    socket.off.mockImplementation((event: string, listener: (value: ServerState) => void) => {
      if (event === "state:update") listeners.delete(listener);
    });
    mocks.request.mockImplementation(async (event: string) => {
      if (event !== "mesa:undoRound") return { ok: true, result: null };
      state = {
        ...ownState(),
        resultRevision: 3,
        matchState: { ...createMatch(rules), phase: "rest", timeLeft: 0, result: null },
      };
      for (const listener of listeners) listener(state);
      return { ok: true, revision: 3 };
    });
    const view = mount();
    await act(async () => {});
    const review = screen.getByRole("dialog", { name: "Resultado del combate" });
    await act(async () => {
      fireEvent.click(within(review).getByRole("button", { name: /Corregir banderines/ }));
    });
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Resultado del combate" })
      ).not.toBeInTheDocument()
    );
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith("mesa:undoRound", {
      categoryId,
      matchId: pending.id,
      expectedRevision: 2,
    });
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
    const panel = screen.getByText("J1").parentElement;
    if (!panel) throw new Error("Missing judge panel");
    fireEvent.click(within(panel).getByRole("button", { name: /Rojo/ }));
    expect(mocks.emit).toHaveBeenCalledWith("mesa:flagVote", {
      categoryId,
      matchId: pending.id,
      judgeId: "J1",
      vote: "red",
    });
  });

  it("checks fresh connection again after an in-flight status read before forwarding any load mutation", async () => {
    let release: (value: Response) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal("fetch", fetcher);
    const view = mount();
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    connected = false;
    ready = false;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    await act(async () => {
      release(new Response(JSON.stringify({ activeMatchLock: null })));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps offline stale-own controls disabled and cannot buffer commands before a fresh reconnect state", async () => {
    state = ownState();
    const view = mount();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Pausar" })[0]).toBeEnabled());
    connected = false;
    ready = false;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    const pause = screen.getAllByRole("button", { name: "Pausar" })[0];
    expect(pause).toBeDisabled();
    fireEvent.click(pause);
    connected = true;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Pausar" })[0]);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
    ready = true;
    state = { ...state };
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Pausar" })[0]);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it.each([
    "other-category",
    "foreign-intent",
  ])("does not authorize operations for %s", async (condition) => {
    state =
      condition === "other-category" ? { ...ownState(), categoryId: "other-category" } : ownState();
    const entry = condition === "foreign-intent" ? { ...intent, categoryId: "foreign" } : intent;
    await act(async () => {
      mount(entry);
    });
    const button =
      screen.queryAllByRole("button", { name: "Cargar combate" })[0] ??
      screen.getAllByRole("button", { name: "Pausar" })[0];
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("cannot mutate or consume passive entry after the previously loaded own bout is already confirmed", async () => {
    state = ownState();
    const view = mount();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Pausar" })[0]).toBeEnabled());
    state = { ...state, resultConfirmed: true };
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    const pause = screen.getAllByRole("button", { name: "Pausar" })[0];
    expect(pause).toBeDisabled();
    fireEvent.click(pause);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("never offers the destructive legacy reset for a stale entry whose fight disappeared", async () => {
    useTournamentStore.setState({ fights: [] });
    await act(async () => {
      mount();
    });
    expect(
      screen.queryByRole("button", { name: "Limpiar estado anterior y empezar de cero" })
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows explicit local guest preparation without consuming passive entry or sending commands", async () => {
    useTournamentStore.setState({
      config: { ...useTournamentStore.getState().config, mode: "elimination" },
      fights: [{ ...pending, isGoldenPointFight: true }, imported],
    });
    const view = mount();
    await act(async () => {});
    expect(screen.getByRole("button", { name: /Huésped/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Huésped/ }));
    expect(screen.getByPlaceholderText("Nombre rojo")).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("Nombre rojo"), {
      target: { value: "Invitado rojo" },
    });
    fireEvent.change(screen.getByPlaceholderText("Nombre azul"), {
      target: { value: "Invitado azul" },
    });
    fireEvent.change(screen.getByPlaceholderText("ej: Infantil B Varones"), {
      target: { value: "Amistoso" },
    });
    fireEvent.change(screen.getByPlaceholderText("ej: Cuadrilátero 2"), {
      target: { value: "T3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar pelea" }));
    const guest = useTournamentStore.getState().fights.at(-1);
    expect(guest?.groupId).toBe("EXT:amistoso");
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    if (!guest) throw new Error("Missing local guest");
    fireEvent.click(screen.getByTestId(`fight-progress-${guest.id}`));
    fireEvent.click(screen.getByTestId(`fight-progress-${pending.id}`));
    connected = false;
    ready = false;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    connected = true;
    ready = true;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    await act(async () => {});
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "Confirmar y continuar",
    "Iniciar desempate",
    "Iniciar Punto de Oro",
  ])("disables the open %s footer and sanction writes until a fresh own state returns", async (label) => {
    if (label !== "Confirmar y continuar") {
      useTournamentStore.setState({
        config: { ...useTournamentStore.getState().config, mode: "elimination" },
        fights: [{ ...pending, isTiebreakExtra: label === "Iniciar Punto de Oro" }, imported],
      });
    }
    state = ownState("finished");
    if (label !== "Confirmar y continuar" && state.matchState) {
      state = {
        ...state,
        matchState: { ...state.matchState, result: { winner: "draw", reason: "points" } },
      };
    }
    const view = mount();
    await act(async () => {});
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Resultado del combate" })).getByRole("button", {
        name: /Confirmar resultado/,
      })
    );
    expect(screen.getByRole("button", { name: label })).toBeEnabled();
    connected = false;
    ready = false;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: label }));
    connected = true;
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: label })).toBeDisabled();
    expect(screen.getByTestId("sanction-red-warning-add")).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
    ready = true;
    state = { ...state };
    view.rerender(
      <MemoryRouter>
        <FightPage navigationIntent={intent} />
        <Route />
      </MemoryRouter>
    );
    expect(screen.getByRole("button", { name: label })).toBeEnabled();
    expect(screen.getByTestId("sanction-red-warning-add")).toBeEnabled();
  });
});
