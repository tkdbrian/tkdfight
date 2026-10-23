import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import { generateEliminationBracket, getActiveBracketFights } from "@/lib/bracket";
import type { ServerState } from "@/lib/socket-types";
import { FightPage } from "@/pages/FightPage";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useTournamentStore } from "@/store/tournament";

const transport = vi.hoisted(() => ({ useSocket: vi.fn(), request: vi.fn(), emit: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: transport.useSocket }));
const initial = useTournamentStore.getState();
const rules = baseline as RuleSetSparring;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (scrollDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  transport.request.mockReset();
  transport.useSocket.mockReset();
  act(() => useTournamentStore.setState(initial, true));
  localStorage.clear();
});

describe("Sunday audit: elimination draw continuation isolation", () => {
  it.each([
    { otherPending: false, failure: "none" },
    { otherPending: true, failure: "before" },
    { otherPending: true, failure: "after" },
    { otherPending: false, failure: "malformed" },
  ])("creates the drawn bout's extra with another semifinal pending ($failure)", async ({
    otherPending, failure,
  }) => {
    const competitors = Array.from({ length: 4 }, (_, index) => ({
      id: `continuation-${index}`, name: `Entrant ${index}`,
    }));
    const bracket = generateEliminationBracket(competitors);
    const queued = getActiveBracketFights(bracket.matches, []);
    const current = queued[0];
    const fights = otherPending ? queued : [current];
    const categoryId = initial.config.id;
    const result = { categoryId, fightId: current.id, status: "confirmed", winner: "draw",
      reason: "points", flagsRed: 2, flagsBlue: 2, warningsRed: 0, warningsBlue: 0,
      foulsRed: 0, foulsBlue: 0 };
    const state: ServerState = { rules, categoryId,
      match: { id: current.id, ringId: "AUDIT", red: current.red, blue: current.blue },
      matchState: { ...createMatch(rules), phase: "finished", timeLeft: 0,
        result: { winner: "draw", reason: "points" } },
      resultConfirmed: false, matchPaused: false, judges: [], judgeVotes: {}, judgeTotals: {},
      penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
      fallos: [], roundFlags: [{ red: 2, blue: 2, winner: "draw" }], serverUrl: "" };
    transport.useSocket.mockReturnValue({ connected: true, stateReady: true, state,
      emit: transport.emit, request: transport.request, socket: { on: vi.fn(), off: vi.fn() } });
    let confirmed = false;
    transport.request.mockImplementation(async (event: string) => {
      if (event === "match:saveFallo") {
        confirmed = true;
        return { ok: true, result };
      }
      if (event === "match:result:get" && confirmed) return { ok: true, result };
      return { ok: false, result: null };
    });
    let syncAttempts = 0;
    let serverCanonical: { id: string; red_id: string; blue_id: string;
      stage: string; parentFightId: string; parentRevision: number } | null = null;
    const fetchMock = vi.fn(async (input: string, options?: RequestInit) => {
      if (input.includes("/continuation")) return serverCanonical
        ? new Response(JSON.stringify({ canonicalFight: serverCanonical }))
        : new Response(null, { status: 404 });
      syncAttempts += 1;
      if (failure === "before" && syncAttempts === 1)
        return new Response(JSON.stringify({ message: "Conexión interrumpida" }), { status: 503 });
      const body = JSON.parse(String(options?.body));
      const proposed = body.eliminationContinuation;
      serverCanonical = {
        id: proposed.proposedFight.id, red_id: proposed.proposedFight.red_id,
        blue_id: proposed.proposedFight.blue_id, stage: proposed.proposedFight.stage,
        parentFightId: proposed.parentFightId, parentRevision: proposed.parentRevision,
      };
      if (failure === "after" && syncAttempts === 1)
        throw new Error("ACK perdido");
      return new Response(JSON.stringify({ ok: true, synced: 1, tournamentId: 1,
        canonicalFight: serverCanonical }));
    });
    vi.stubGlobal("fetch", fetchMock);
    if (failure === "malformed") {
      const stage = JSON.stringify({ kind: "direct-continuation",
        currentFightId: current.id, isGoldenPoint: false });
      const key = `tkd-pending-fight-v1:${encodeURIComponent(categoryId)}:${
        encodeURIComponent(stage)}`;
      localStorage.setItem(key, JSON.stringify({ version: 1, stage, fights: [{
        id: "not-a-uuid", red: current.red, blue: current.blue, completed: false,
        isTiebreakExtra: true, playoffKind: "direct", bracketMatchId: current.bracketMatchId,
        continuationParentFightId: current.id, continuationStage: "timed-extra",
      }] }));
    }
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    act(() => useTournamentStore.setState({ ...initial, competitors,
      config: { ...initial.config, id: categoryId, mode: "elimination", ruleSet: rules },
      fights, bracketMatches: bracket.matches, bracketSeeds: bracket.seeds,
      currentFightIndex: 0, phase: "fighting", setupStarted: true }));
    await act(async () => render(<MemoryRouter>
      <FightPage navigationIntent={{ kind: "category-continue", categoryId, fightId: current.id }} />
    </MemoryRouter>));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Resultado del combate" }))
      .getByRole("button", { name: /Confirmar resultado/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Iniciar desempate" })));
    if (failure === "malformed") {
      expect(transport.request.mock.calls.filter(([event]) => event === "match:saveFallo"))
        .toHaveLength(0);
      expect(useTournamentStore.getState().fights).toHaveLength(fights.length);
      expect(syncAttempts).toBe(0);
      return;
    }
    if (failure !== "none") {
      await waitFor(() => expect(screen.getByRole("button", { name: "Reanudar desempate" }))
        .toBeEnabled());
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reanudar desempate" })));
      expect(transport.request.mock.calls.filter(([event]) => event === "match:saveFallo"))
        .toHaveLength(1);
      if (failure === "after") expect(syncAttempts).toBe(1);
    }
    expect(transport.request).toHaveBeenCalledWith("match:saveFallo",
      expect.objectContaining({ matchId: current.id }));
    expect(useTournamentStore.getState().fights[0]).toMatchObject({ completed: true, winner: "draw" });
    await waitFor(() => expect(useTournamentStore.getState().fights).toHaveLength(fights.length + 1));
    expect(useTournamentStore.getState().fights.at(-1)).toMatchObject({
      red: current.red, blue: current.blue, isTiebreakExtra: true, bracketMatchId: current.bracketMatchId,
      continuationParentFightId: current.id, continuationStage: "timed-extra",
    });
    const sync = fetchMock.mock.calls.find(([url]) => url === "/api/ring/sync-fights");
    expect(JSON.parse(String(sync?.[1]?.body)).requiredConfirmedFightIds).toEqual([current.id]);
  });
});
