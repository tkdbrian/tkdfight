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
    match: { preFight: { revision: 0, started: false, timingKind: "regular" }, id: pending.id, ringId: "TEST", red: pending.red, blue: pending.blue },
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


describe("pre-fight settings", () => {
  it("edits a loaded never-started fight and blocks Start until save", async () => {
    state = ownState("idle");
    state.matchState = { ...state.matchState!, timeLeft: 60 };
    mount(); await act(async () => {});
    expect(screen.getAllByText("Ajustes de este combate").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", {name:"1:30"})[0]);
    expect(screen.getAllByRole("button", {name:"Iniciar combate"})[0]).toBeDisabled();
    mocks.request.mockResolvedValue({ok:false,error:"revisi?n desactualizada"});
    fireEvent.click(screen.getAllByRole("button", {name:"Guardar ajustes"})[0]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:configure",expect.objectContaining({categoryId,matchId:pending.id,durationSeconds:90,rounds:1,expectedRevision:0}),7000));
    expect(mocks.emit).not.toHaveBeenCalledWith("match:load",expect.anything());
    expect(screen.getAllByRole("button", {name:"Iniciar combate"})[0]).toBeDisabled();
  });
  it("recovers a lost acknowledgement without reloading and waits for canonical state before Start", async () => {
    state = ownState("idle");
    const view=mount(); await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", {name:"1:30"})[0]);
    mocks.request.mockImplementation(async (event) => event === "match:configure" ? null : {ok:true, preFight:{revision:1,started:false},rules:{...rules,rounds:{...rules.rounds,count:1,duration_seconds:90}}});
    fireEvent.click(screen.getAllByRole("button", {name:"Guardar ajustes"})[0]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:configuration",{categoryId,matchId:pending.id},7000));
    expect(screen.getAllByRole("button", {name:"Iniciar combate"})[0]).toBeDisabled();
    state={...state,rules:{...rules,rounds:{...rules.rounds,count:1,duration_seconds:90}},match:{...state.match!,preFight:{revision:1,started:false,timingKind:"regular"}},matchState:{...state.matchState!,timeLeft:90}};
    view.rerender(<MemoryRouter><FightPage navigationIntent={intent}/></MemoryRouter>);
    expect(screen.getAllByRole("button", {name:"Iniciar combate"})[0]).toBeEnabled();
    fireEvent.click(screen.getAllByRole("button", {name:"Iniciar combate"})[0]);
    expect(mocks.emit).toHaveBeenCalledWith("match:start",{categoryId,matchId:pending.id,expectedTimingRevision:1});
    expect(mocks.request).not.toHaveBeenCalledWith("match:load",expect.anything());
  });
  it("keeps Tul loading outside the sparring timing contract", async () => {
    useTournamentStore.setState({config:{...useTournamentStore.getState().config,matchType:"tul"}});
    vi.stubGlobal("fetch",vi.fn(async () => new Response(JSON.stringify({activeMatchLock:null}))));
    mocks.request.mockResolvedValue({ok:true});
    mount(); await act(async () => {});
    fireEvent.click(screen.getAllByRole("button",{name:"Iniciar competencia"})[0]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:load",expect.anything()));
    const call=mocks.request.mock.calls.find(([event]) => event==="match:load");
    expect(call?.[1].match).not.toHaveProperty("timingKind");
  });
  it("does not edit a loaded bout with a vote already registered", async () => {
    state=ownState("idle"); state.judgeVotes={J1:"red"};
    mount(); await act(async () => {});
    expect(screen.queryByText("Ajustes de este combate")).toBeNull();
  });
  it("never offers loaded settings for started or legacy bouts", async () => {
    state=ownState("idle"); state.match!.preFight!.started=true;
    const view=mount(); await act(async () => {});
    expect(screen.queryByText("Ajustes de este combate")).toBeNull();
    delete state.match!.preFight; view.rerender(<MemoryRouter><FightPage navigationIntent={intent}/></MemoryRouter>);
    expect(screen.queryByText("Ajustes de este combate")).toBeNull();
  });
  it("offers rounds only on an elimination final and resets drafts between fights", async () => {
    useTournamentStore.setState({config:{...useTournamentStore.getState().config,mode:"elimination"},fights:[{...pending,isFinalFight:true},{...pending,id:"next"}]});
    mount(); await act(async () => {});
    expect(screen.getAllByRole("button",{name:"2 rounds"}).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button",{name:"2 rounds"})[0]);
    act(() => useTournamentStore.getState().setCurrentFightIndex(1));
    expect(screen.queryByRole("button",{name:"2 rounds"})).toBeNull();
  });
});
