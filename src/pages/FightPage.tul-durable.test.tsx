import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import { FightPage } from "@/pages/FightPage";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn(), emit: vi.fn(), request: vi.fn(), navigate: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
const initialStore = useTournamentStore.getState();
const rules = { ...itfRules, judgingMode: "flags", judgesCount: 4,
  rounds: { ...itfRules.rounds, count: 1 } } as RuleSetSparring;
const identity = { categoryId: "flags-category", matchId: "flags-fight" };
const fight = { id: identity.matchId, red: { id: "r", name: "Rojo" },
  blue: { id: "b", name: "Azul" }, groupId: "G1", completed: false };
const listeners = new Set<(state: ServerState) => void>();
const socket = { on: (event: string, listener: (state: ServerState) => void) => {
  if (event === "state:update") listeners.add(listener);
}, off: (event: string, listener: (state: ServerState) => void) => {
  if (event === "state:update") listeners.delete(listener);
} };

function makeState(finished: boolean, revision = 0): ServerState {
  return { rules, categoryId: identity.categoryId, match: { ...fight, ringId: "TEST" },
    matchState: { ...createMatch(rules), phase: finished ? "finished" : "rest", timeLeft: 0,
      result: finished ? { winner: "red", reason: "points" } : null },
    resultConfirmed: false, resultRevision: revision, matchPaused: true,
    judges: [], judgeVotes: finished ? {} : { J1: "red", J2: "red", J3: "red", J4: "red" },
    judgeTotals: {}, roundFlags: finished ? [{ red: 4, blue: 0, winner: "red" }] : [],
    penaltyCounts: { warnings: { red: 2, blue: 0 }, fouls: { red: 0, blue: 1 } },
    fallos: [], serverUrl: "" };
}
function setState(state: ServerState, connected = true): void {
  mocks.useSocket.mockReturnValue({ connected, stateReady: true, state,
    emit: mocks.emit, request: mocks.request, socket });
}
async function openPendingOverlay() {
  setState(tulState(false));
  const view = render(<FightPage />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Confirmar resultado" })[0]).toBeInTheDocument());
  setState(tulState(true));
  view.rerender(<FightPage />);
  const overlay = await screen.findByRole("dialog", { name: "Resultado del combate" });
  mocks.request.mockClear();
  return { view, overlay };
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
  Element.prototype.scrollIntoView = vi.fn();
  mocks.request.mockResolvedValue({ ok: true, result: null });
  act(() => useTournamentStore.setState({ ...initialStore,
    config: { ...initialStore.config, id: identity.categoryId, mode: "round-robin",
      matchType: "tul", judgesCount: 4, ruleSet: rules },
    fights: [fight], currentFightIndex: 0, phase: "fighting" }));
});
afterEach(() => {
  cleanup(); listeners.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  act(() => useTournamentStore.setState(initialStore));
});

function tulState(finished: boolean, revision = 0): ServerState {
  return { ...makeState(finished, revision), tulPhase: finished ? "finished" : "voting" };
}

describe("durable Tul voting controls", () => {
  it.each(["ack-first", "state-first"])("waits for undo acceptance and authoritative reopened state (%s)", async (order) => {
    const { view, overlay } = await openPendingOverlay();
    let reply: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    fireEvent.click(within(overlay).getByRole("button", { name: /Corregir banderines/ }));
    expect(mocks.request).toHaveBeenCalledWith("tul:undoFinish", { ...identity, expectedRevision: 0 });
    expect(mocks.emit).not.toHaveBeenCalled();
    const reopened = tulState(false, 1);
    if (order === "ack-first") await act(async () => reply({ ok: true, revision: 1 }));
    else {
      setState(reopened); view.rerender(<FightPage />);
      await act(async () => { for (const listener of [...listeners]) listener(reopened); });
    }
    expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toBeInTheDocument();
    if (order === "ack-first") {
      setState(reopened); view.rerender(<FightPage />);
      await act(async () => { for (const listener of [...listeners]) listener(reopened); });
    } else await act(async () => reply({ ok: true, revision: 1 }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Resultado del combate" })).toBeNull());
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
  });

  it("retains result and shows durable undo rejection", async () => {
    const { overlay } = await openPendingOverlay();
    mocks.request.mockResolvedValue({ ok: false, error: "Resultado intacto" });
    fireEvent.click(within(overlay).getByRole("button", { name: /Corregir banderines/ }));
    await waitFor(() => expect(within(overlay).getByRole("alert")).toHaveTextContent("Resultado intacto"));
    expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toBeInTheDocument();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("disallows a 2-2 Tul draw from the individual-judge panel", async () => {
    const state = tulState(false);
    state.judgeVotes = { J1: "red", J2: "red", J3: "blue", J4: "blue" };
    setState(state); render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Por juez" })[0]);
    const confirmation = screen.getByRole("button", { name: /Confirmar.*Empate en banderas/ });
    expect(confirmation).toBeDisabled();
    fireEvent.click(confirmation);
    expect(mocks.emit).not.toHaveBeenCalledWith("tul:finish", expect.anything());
  });

  it.each(["ack-first", "state-first"])("waits for durable finish ACK and state (%s)", async (order) => {
    setState(tulState(false)); const view = render(<FightPage />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Confirmar resultado" })[0]).toBeEnabled());
    let reply: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    fireEvent.click(screen.getAllByRole("button", { name: "Confirmar resultado" })[0]);
    expect(mocks.request).toHaveBeenCalledWith("tul:finish", { ...identity, expectedRevision: 0 });
    const finished = tulState(true);
    if (order === "ack-first") await act(async () => reply({ ok: true, revision: 0 }));
    else {
      setState(finished); view.rerender(<FightPage />);
      await act(async () => { for (const listener of [...listeners]) listener(finished); });
    }
    expect(screen.queryByRole("dialog", { name: "Resultado del combate" })).toBeNull();
    if (order === "ack-first") {
      setState(finished); view.rerender(<FightPage />);
      await act(async () => { for (const listener of [...listeners]) listener(finished); });
    } else await act(async () => reply({ ok: true, revision: 0 }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toBeInTheDocument());
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
  });

  it("requests durable finish and displays rejection without advancing", async () => {
    setState(tulState(false)); render(<FightPage />);
    mocks.request.mockClear();
    mocks.request.mockResolvedValue({ ok: false, error: "No se pudo guardar Tul" });
    fireEvent.click(screen.getAllByRole("button", { name: "Confirmar resultado" })[0]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("tul:finish", { ...identity, expectedRevision: 0 }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo guardar Tul");
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalledWith("tul:finish", expect.anything());
  });
});
