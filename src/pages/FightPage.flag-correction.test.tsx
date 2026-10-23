import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import { FightPage, hasReopenedFlagUpdate } from "@/pages/FightPage";
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
  setState(makeState(false));
  const view = render(<FightPage />);
  await waitFor(() => expect(screen.queryAllByText(/Round 1 terminado/).length).toBeGreaterThan(0));
  setState(makeState(true));
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
      matchType: "sparring", judgesCount: 4, ruleSet: rules },
    fights: [fight], currentFightIndex: 0, phase: "fighting" }));
});
afterEach(() => {
  cleanup(); listeners.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  act(() => useTournamentStore.setState(initialStore));
});

describe("reabrir banderines pendientes sin adelantar el resultado", () => {
  it.each(["ack-first", "state-first"])("requires ACK and matching revision/state (%s)", async (order) => {
    const { view, overlay } = await openPendingOverlay();
    let reply: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    fireEvent.click(within(overlay).getByRole("button", { name: /Corregir banderines/ }));
    expect(mocks.request).toHaveBeenCalledWith("mesa:undoRound", { ...identity, expectedRevision: 0 });
    expect(within(overlay).getByRole("button", { name: /Reabriendo votación/ })).toBeDisabled();
    expect(within(overlay).getByRole("button", { name: /Confirmar resultado/ })).toBeDisabled();
    const reopened = makeState(false, 1);
    if (order === "ack-first") {
      await act(async () => reply({ ok: true, revision: 1 }));
    } else {
      setState(reopened); view.rerender(<FightPage />);
      await act(async () => { for (const listener of [...listeners]) listener(reopened); });
    }
    expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toBeInTheDocument();
    if (order === "ack-first") {
      await act(async () => { for (const listener of [...listeners]) listener({ ...reopened, resultRevision: 0 }); });
      expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toBeInTheDocument();
      setState(reopened); view.rerender(<FightPage />);
      await act(async () => { for (const listener of [...listeners]) listener(reopened); });
    } else await act(async () => reply({ ok: true, revision: 1 }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Resultado del combate" })).toBeNull());
    expect(screen.getAllByRole("button", { name: /Azul/ }).some((button) => !button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(within(screen.getByText("J1").parentElement!).getByRole("button", { name: /Azul/ }));
    expect(mocks.emit).toHaveBeenCalledWith("mesa:flagVote", { ...identity, judgeId: "J1", vote: "blue" });
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps the original overlay open on rejection and does not issue an optimistic undo", async () => {
    const { overlay } = await openPendingOverlay();
    mocks.request.mockResolvedValue({ ok: false, code: "persistence_failed", error: "Resultado intacto" });
    fireEvent.click(within(overlay).getByRole("button", { name: /Corregir banderines/ }));
    await waitFor(() => expect(within(overlay).getByRole("button", { name: /Corregir banderines/ })).not.toBeDisabled());
    expect(overlay).toHaveTextContent(/4/);
    expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toBeInTheDocument();
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
  });

  it("disables correction while disconnected", async () => {
    const { view, overlay } = await openPendingOverlay();
    setState(makeState(true), false); view.rerender(<FightPage />);
    expect(within(overlay).getByRole("button", { name: /Corregir banderines/ })).toBeDisabled();
    fireEvent.click(within(overlay).getByRole("button", { name: /Corregir banderines/ }));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("retains a readable result with an explicit exit if state arrives but the ACK is lost", async () => {
    const { view, overlay } = await openPendingOverlay();
    vi.useFakeTimers();
    mocks.request.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(within(overlay).getByRole("button", { name: /Corregir banderines/ }));
    const reopened = makeState(false, 1);
    setState(reopened); view.rerender(<FightPage />);
    await act(async () => { for (const listener of [...listeners]) listener(reopened); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6501); });
    expect(screen.getByRole("dialog", { name: "Resultado del combate" })).toHaveTextContent(/4/);
    expect(within(overlay).getByRole("alert")).toHaveTextContent(/no confirmó/);
    expect(within(overlay).getByRole("button", { name: /Confirmar resultado/ })).toBeDisabled();
    fireEvent.click(within(overlay).getByRole("button", { name: "Cerrar y revisar votación" }));
    expect(screen.queryByRole("dialog", { name: "Resultado del combate" })).toBeNull();
    expect(within(screen.getByText("J1").parentElement!).getByRole("button", { name: /Azul/ })).not.toBeDisabled();
  });

  it("invalidates an open result dialog instead of approving a newer remotely corrected revision", async () => {
    const { view, overlay } = await openPendingOverlay();
    fireEvent.click(within(overlay).getByRole("button", { name: /Confirmar resultado/ }));
    expect(await screen.findByRole("dialog", { name: "Registrar resultado del combate" })).toBeInTheDocument();
    const remoteCorrection = makeState(true, 3);
    remoteCorrection.roundFlags = [{ red: 1, blue: 3, winner: "blue" }];
    remoteCorrection.matchState = { ...remoteCorrection.matchState!, result: { winner: "blue", reason: "points" } };
    setState(remoteCorrection); view.rerender(<FightPage />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Registrar resultado del combate" })).toBeNull());
    expect(mocks.request).not.toHaveBeenCalledWith("match:saveFallo", expect.anything());
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
  });

  it("sends the revision captured when opening the result confirmation dialog", async () => {
    const { overlay } = await openPendingOverlay();
    fireEvent.click(within(overlay).getByRole("button", { name: /Confirmar resultado/ }));
    const dialog = await screen.findByRole("dialog", { name: "Registrar resultado del combate" });
    mocks.request.mockResolvedValue({ ok: false, error: "stale", result: null });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirmar y continuar" }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:saveFallo", { ...identity, expectedRevision: 0 }));
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
  });

  it("never auto-confirms a newly discovered pending revision during read-only recovery", async () => {
    const absent = makeState(false);
    absent.match = null;
    absent.matchState = null;
    setState(absent);
    mocks.request.mockResolvedValue({ ok: true, result: { fightId: identity.matchId,
      categoryId: identity.categoryId, winner: "blue", reason: "points", flagsRed: 1, flagsBlue: 3,
      warningsRed: 2, warningsBlue: 0, foulsRed: 0, foulsBlue: 1,
      status: "pending_confirmation", revision: 3 } });
    render(<FightPage />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("match:result:get", identity));
    await act(async () => {});
    expect(mocks.request.mock.calls.filter(([event]) => event === "match:result:get").length).toBeGreaterThanOrEqual(2);
    expect(mocks.request).not.toHaveBeenCalledWith("match:saveFallo", expect.anything());
    expect(useTournamentStore.getState().fights[0].completed).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not mistake a different match/category/confirmed result for a reopened vote", () => {
    const reopened = makeState(false, 2);
    expect(hasReopenedFlagUpdate(reopened, identity.categoryId, identity.matchId, 2)).toBe(true);
    expect(hasReopenedFlagUpdate(reopened, "other", identity.matchId, 2)).toBe(false);
    expect(hasReopenedFlagUpdate(reopened, identity.categoryId, "other", 2)).toBe(false);
    expect(hasReopenedFlagUpdate(reopened, identity.categoryId, identity.matchId, 1)).toBe(false);
    expect(hasReopenedFlagUpdate({ ...reopened, resultConfirmed: true }, identity.categoryId, identity.matchId, 2)).toBe(false);
    expect(hasReopenedFlagUpdate(makeState(true, 2), identity.categoryId, identity.matchId, 2)).toBe(false);
  });
});
