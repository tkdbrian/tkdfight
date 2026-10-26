import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import { generateEliminationBracket, generateGroupsTournament } from "@/lib/bracket";
import {
  type CategoryPrimaryActionContext,
  getCategoryPrimaryAction,
} from "@/lib/category-lifecycle";
import { getFightPageEntry } from "@/lib/fight-navigation";
import type { ServerState } from "@/lib/socket-types";
import { FightPageRoute } from "@/pages/FightPageRoute";
import baselineRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";

const transport = vi.hoisted(() => ({
  useSocket: vi.fn(),
  emit: vi.fn(),
  request: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: transport.useSocket }));
const initialStore = useTournamentStore.getState();
const rules = baselineRules as RuleSetSparring;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

function freeServer(): ServerState {
  return {
    rules: null,
    match: null,
    matchState: null,
    matchPaused: false,
    categoryId: null,
    resultConfirmed: false,
    activeMatchLock: null,
    judges: [],
    judgeVotes: {},
    judgeTotals: {},
    penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
    fallos: [],
    roundFlags: [],
    serverUrl: "",
  };
}

function connection(state: ServerState, connected = true, stateReady = true): void {
  transport.useSocket.mockReturnValue({
    connected,
    stateReady,
    state,
    emit: transport.emit,
    request: transport.request,
    socket: { on: transport.on, off: transport.off },
  });
}

function seed(snapshot = category()): TournamentCategorySnapshot {
  const selected = {
    ...snapshot,
    config: { ...snapshot.config, id: initialStore.config.id, ruleSet: rules },
  };
  act(() => useTournamentStore.setState(selected));
  return selected;
}

function page(intent: unknown): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={[{ pathname: "/fight", state: intent }]}>
      <FightPageRoute />
    </MemoryRouter>
  );
}

function HistoryControls(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <nav aria-label="Test browser history">
      <button type="button" onClick={() => navigate(-1)}>
        History back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        History forward
      </button>
    </nav>
  );
}

function intent(snapshot: TournamentCategorySnapshot): unknown {
  return {
    kind: "category-continue",
    categoryId: snapshot.config.id,
    fightId: snapshot.fights[snapshot.currentFightIndex].id,
  };
}

function category(): TournamentCategorySnapshot {
  const competitors = ["Ana", "Bruno", "Carla"].map((name, index) => ({
    id: `independent-continue-entrant-${index}`,
    name,
    team: "Club",
  }));
  return {
    phase: "fighting",
    config: {
      id: "independent-continue-category",
      eventId: "independent-continue-event",
      tournamentName: "Prueba de continuación",
      categoryName: "Adultos",
      tableChief: "Mesa",
      ruleSet: null,
      judgesCount: 3,
      mode: "round-robin",
      matchType: "sparring",
    },
    competitors,
    ...generateGroupsTournament(competitors),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}

function context(snapshot: TournamentCategorySnapshot): CategoryPrimaryActionContext {
  return {
    snapshot,
    connected: true,
    stateReady: true,
    resultsVerified: false,
    serverState: { match: null, activeMatchLock: null },
  };
}

beforeEach(() => {
  transport.useSocket.mockReset();
  transport.request.mockReset();
  transport.emit.mockReset();
  transport.on.mockReset();
  transport.off.mockReset();
  transport.request.mockResolvedValue({ ok: true, result: null });
  connection(freeServer());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]"))
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (scrollDescriptor)
    Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  act(() => useTournamentStore.setState(initialStore, true));
  localStorage.clear();
});

describe("independent passive Continue foundation", () => {
  it("prefers the selected stored pending fight, otherwise the first eligible one without modifying progress", () => {
    const snapshot = category();
    snapshot.phase = "results";
    snapshot.currentFightIndex = 1;
    const before = JSON.stringify(snapshot);

    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({
      kind: "continue",
      route: "/fight",
      fightId: snapshot.fights[1].id,
    });
    expect(JSON.stringify(snapshot)).toBe(before);

    snapshot.fights[1] = { ...snapshot.fights[1], completed: true, winner: "blue" };
    const afterResult = JSON.stringify(snapshot);
    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({
      kind: "continue",
      route: "/fight",
      fightId: snapshot.fights[0].id,
    });
    expect(JSON.stringify(snapshot)).toBe(afterResult);
  });

  it("prioritizes the own pending operative result even when its local record is already completed", () => {
    const snapshot = category();
    snapshot.fights[0] = { ...snapshot.fights[0], completed: true, winner: "red" };
    snapshot.currentFightIndex = 2;
    const before = JSON.stringify(snapshot);

    expect(
      getCategoryPrimaryAction({
        ...context(snapshot),
        serverState: {
          match: null,
          activeMatchLock: {
            categoryId: snapshot.config.id,
            fightId: snapshot.fights[0].id,
            resultStatus: "pending_confirmation",
          },
        },
      })
    ).toMatchObject({
      kind: "review",
      route: "/fight",
      fightId: snapshot.fights[0].id,
    });
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("offers explicit bracket preparation for an empty stored elimination queue without generating UUIDs", () => {
    const snapshot = category();
    snapshot.config.mode = "elimination";
    snapshot.fights = [];
    snapshot.groups = [];
    const generated = generateEliminationBracket(snapshot.competitors);
    snapshot.bracketMatches = generated.matches;
    snapshot.bracketSeeds = generated.seeds;
    const before = JSON.stringify(snapshot);
    const uuid = vi.spyOn(crypto, "randomUUID");

    expect(getCategoryPrimaryAction(context(snapshot))).toMatchObject({
      kind: "continue",
      route: "/bracket",
      reason: expect.stringMatching(/siguiente ronda|Final A\+B/),
    });
    expect(uuid).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("recognizes a valid local passive entry and preserves an ordinary direct entry", () => {
    const snapshot = category();
    const intent = {
      kind: "category-continue",
      categoryId: snapshot.config.id,
      fightId: snapshot.fights[0].id,
    };
    expect(getFightPageEntry(intent, snapshot.config.id, snapshot.fights)).toEqual({
      mode: "passive",
      intent,
    });
    expect(getFightPageEntry(undefined, snapshot.config.id, snapshot.fights)).toEqual({
      mode: "normal",
    });
  });

  it.each([
    { categoryId: "foreign" },
    { fightId: "missing" },
    { fightId: "" },
    { autoLoad: true },
  ])("fails closed rather than falling back to normal legacy entry for a claimed invalid intent %j", (overrides) => {
    const snapshot = category();
    const intent = {
      kind: "category-continue",
      categoryId: snapshot.config.id,
      fightId: snapshot.fights[0].id,
      ...overrides,
    };
    const before = JSON.stringify(snapshot);
    expect(getFightPageEntry(intent, snapshot.config.id, snapshot.fights)).toEqual({
      mode: "invalid",
    });
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

describe("independent passive Combat route integration", () => {
  it("retains imported and Golden Point records through passive mount, selection and reconnect", async () => {
    const snapshot = category();
    snapshot.config.mode = "elimination";
    snapshot.fights = [
      { ...snapshot.fights[0], importedFrom: "T2", completed: true, winner: "red" },
      { ...snapshot.fights[1], isGoldenPointFight: true },
    ];
    snapshot.currentFightIndex = 1;
    const selected = seed(snapshot);
    const entry = intent(selected);
    const before = JSON.stringify(selected.fights);
    const view = render(page(entry));
    await act(async () => {});
    expect(JSON.stringify(useTournamentStore.getState().fights)).toBe(before);
    expect(transport.emit).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Cargar combate" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId(`fight-progress-${selected.fights[0].id}`));
    fireEvent.click(screen.getByTestId(`fight-progress-${selected.fights[1].id}`));
    connection(freeServer(), false, false);
    view.rerender(page(entry));
    await act(async () => {});
    connection(freeServer(), true, false);
    view.rerender(page(entry));
    await act(async () => {});
    connection(freeServer(), true, true);
    view.rerender(page(entry));
    await act(async () => {});
    expect(JSON.stringify(useTournamentStore.getState().fights)).toBe(before);
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(transport.emit).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(
      0
    );
  });

  it("restores the own pending server result visually without overwriting a completed local record", async () => {
    const snapshot = category();
    snapshot.fights[0] = {
      ...snapshot.fights[0],
      completed: true,
      winner: "red",
      flagsRed: 3,
      flagsBlue: 0,
    };
    const selected = seed(snapshot);
    const fight = selected.fights[0];
    connection({
      ...freeServer(),
      categoryId: selected.config.id,
      rules,
      match: { id: fight.id, ringId: "TEST", red: fight.red, blue: fight.blue },
      activeMatchLock: {
        categoryId: selected.config.id,
        fightId: fight.id,
        tournamentId: 1,
        resultStatus: "pending_confirmation",
      },
      matchState: {
        ...createMatch(rules),
        phase: "finished",
        result: { winner: "blue", reason: "points" },
      },
      resultConfirmed: false,
    });
    render(page(intent(selected)));
    await act(async () => {});

    const pendingResult = screen.getByRole("dialog", { name: "Resultado del combate" });
    expect(within(pendingResult).getByText(fight.blue.name)).toBeVisible();
    expect(
      within(pendingResult).getByRole("button", { name: /Confirmar resultado/ })
    ).toBeEnabled();
    expect(
      within(pendingResult).getByRole("button", { name: /Corregir banderines/ })
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cargar combate" })).not.toBeInTheDocument();
    expect(useTournamentStore.getState().fights[0]).toEqual(fight);
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    expect(transport.emit).not.toHaveBeenCalled();
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("keeps the own running clock visible but cannot buffer controls during disconnect or stale reconnect", async () => {
    const selected = seed();
    const fight = selected.fights[0];
    const running: ServerState = {
      ...freeServer(),
      categoryId: selected.config.id,
      rules,
      match: { id: fight.id, ringId: "TEST", red: fight.red, blue: fight.blue },
      matchState: { ...createMatch(rules), phase: "round", timeLeft: 47 },
      activeMatchLock: {
        categoryId: selected.config.id,
        fightId: fight.id,
        tournamentId: 1,
        resultStatus: null,
      },
    };
    connection(running);
    const entry = intent(selected);
    const view = render(page(entry));
    await act(async () => {});
    expect(screen.getAllByRole("button", { name: "Pausar" }).length).toBeGreaterThan(0);

    for (const [connected, stateReady] of [
      [false, false],
      [true, false],
    ]) {
      connection(running, connected, stateReady);
      view.rerender(page(entry));
      await act(async () => {});
      const controls = screen.getAllByRole("button", { name: "Pausar" });
      expect(controls.length).toBeGreaterThan(0);
      for (const button of controls) {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
      expect(screen.getAllByText("0:47").length).toBeGreaterThan(0);
      expect(transport.emit).not.toHaveBeenCalled();
      expect(transport.request).not.toHaveBeenCalled();
    }
  });

  it("cannot expose or execute the empty-page full reset through an invalid stale Continue intent", async () => {
    const snapshot = category();
    snapshot.fights = [];
    const selected = seed(snapshot);
    render(
      page({ kind: "category-continue", categoryId: selected.config.id, fightId: "deleted-fight" })
    );
    await act(async () => {});
    const reset = screen.queryByRole("button", {
      name: "Limpiar estado anterior y empezar de cero",
    });
    if (reset) fireEvent.click(reset);
    await act(async () => {});

    expect(reset).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(
      0
    );
    expect(useTournamentStore.getState().fights).toEqual(selected.fights);
  });

  it("does not sync or load a previous category when an explicit load status reply arrives late", async () => {
    const selected = seed();
    const before = JSON.stringify(selected.fights);
    let resolveStatus: (response: Response) => void = () => {
      throw new Error("The status request did not start");
    };
    const status = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const fetchStatus = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("last-confirmed")
        ? Promise.resolve(new Response(JSON.stringify({ ok: true, last: null, ambiguous: false })))
        : status);
    vi.stubGlobal("fetch", fetchStatus);
    render(page(intent(selected)));
    await act(async () => {});
    expect(fetchStatus).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    });
    expect(fetchStatus).toHaveBeenCalledWith("/api/ring/status");
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(transport.request).not.toHaveBeenCalled();

    act(() =>
      useTournamentStore.setState({
        config: { ...useTournamentStore.getState().config, id: "another-current-category" },
      })
    );
    await act(async () => {
      resolveStatus(new Response(JSON.stringify({ activeMatchLock: null })));
    });

    expect(
      screen.getByRole("heading", { name: "No se encontró el combate de esta continuación" })
    ).toBeVisible();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.emit).not.toHaveBeenCalled();
    expect(JSON.stringify(useTournamentStore.getState().fights)).toBe(before);
    expect(useTournamentStore.getState().config.id).toBe("another-current-category");
  });

  it("restores fresh passive lifetimes on browser back and forward after an explicit operative command", async () => {
    const snapshot = category();
    snapshot.config.mode = "elimination";
    snapshot.fights[1] = { ...snapshot.fights[1], isGoldenPointFight: true };
    const selected = seed(snapshot);
    const first = selected.fights[0];
    const second = selected.fights[1];
    const before = JSON.stringify(selected.fights);
    connection({
      ...freeServer(),
      categoryId: selected.config.id,
      rules,
      match: { id: first.id, ringId: "TEST", red: first.red, blue: first.blue },
      matchState: { ...createMatch(rules), phase: "round", timeLeft: 41 },
    });
    render(
      <MemoryRouter
        initialIndex={0}
        initialEntries={[
          { pathname: "/fight", state: intent(selected) },
          {
            pathname: "/fight",
            state: {
              kind: "category-continue",
              categoryId: selected.config.id,
              fightId: second.id,
            },
          },
        ]}
      >
        <FightPageRoute />
        <HistoryControls />
      </MemoryRouter>
    );
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "Pausar" })[0]);
    expect(transport.emit).toHaveBeenCalledExactlyOnceWith("match:pause", {
      categoryId: selected.config.id,
      matchId: first.id,
    });

    connection(freeServer());
    fireEvent.click(screen.getByRole("button", { name: "History forward" }));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    fireEvent.click(screen.getByTestId(`fight-progress-${first.id}`));
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await act(async () => {});
    expect(useTournamentStore.getState().currentFightIndex).toBe(0);
    fireEvent.click(screen.getByTestId(`fight-progress-${second.id}`));
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "History forward" }));
    await act(async () => {});

    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(JSON.stringify(useTournamentStore.getState().fights)).toBe(before);
    expect(transport.emit).toHaveBeenCalledTimes(1);
    expect(transport.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [true, false],
  ])("disables an already-open pending confirmation footer when connected=%s and fresh=%s", async (connected, fresh) => {
    const selected = seed();
    const fight = selected.fights[0];
    const pending: ServerState = {
      ...freeServer(),
      categoryId: selected.config.id,
      rules,
      match: { id: fight.id, ringId: "TEST", red: fight.red, blue: fight.blue },
      matchState: {
        ...createMatch(rules),
        phase: "finished",
        result: { winner: "red", reason: "points" },
      },
      resultConfirmed: false,
      resultRevision: 4,
    };
    connection(pending);
    const entry = intent(selected);
    const view = render(page(entry));
    await act(async () => {});
    const review = screen.getByRole("dialog", { name: "Resultado del combate" });
    fireEvent.click(within(review).getByRole("button", { name: /Confirmar resultado/ }));
    const confirm = screen.getByRole("button", { name: "Confirmar y continuar" });
    expect(confirm).toBeEnabled();

    connection(pending, connected, fresh);
    view.rerender(page(entry));
    expect(screen.getByRole("button", { name: "Confirmar y continuar" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y continuar" }));
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.emit).not.toHaveBeenCalled();
    expect(useTournamentStore.getState().fights[0]).toEqual(fight);
  });
});
