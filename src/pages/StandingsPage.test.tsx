import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closedGroupBasis } from "@/lib/round-robin-resolution";
import { StandingsPage } from "@/pages/StandingsPage";
import { type CompetitorEntry, type FightEntry, useTournamentStore } from "@/store/tournament";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("canvas-confetti", () => ({ default: vi.fn() }));

vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({
    connected: true,
    stateReady: true,
    state: { activeMatchLock: null, match: null },
    request: requestMock,
  }),
}));

const initialState = useTournamentStore.getState();
const competitors: CompetitorEntry[] = ["a", "b", "c"].map((id) => ({
  id,
  name: id.toUpperCase(),
}));
const [a, b, c] = competitors;

function fight(id: string, red: CompetitorEntry, blue: CompetitorEntry): FightEntry {
  return {
    id,
    red,
    blue,
    groupId: "G1",
    completed: false,
    flagsRed: 0,
    flagsBlue: 0,
    foulsRed: 0,
    foulsBlue: 0,
    warningsRed: 0,
    warningsBlue: 0,
  };
}

function serverResult(entry: FightEntry, status = "confirmed") {
  return {
    fightId: entry.id,
    categoryId: "rr-standings-test",
    status,
    winner: entry.winner,
    flagsRed: entry.flagsRed,
    flagsBlue: entry.flagsBlue,
    foulsRed: entry.foulsRed,
    foulsBlue: entry.foulsBlue,
    warningsRed: entry.warningsRed,
    warningsBlue: entry.warningsBlue,
  };
}

function findFight(fights: FightEntry[], id: string): FightEntry {
  const entry = fights.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing test fight ${id}`);
  return entry;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  requestMock.mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
  act(() => useTournamentStore.setState(initialState));
});

describe("sincronización segura de desempates", () => {
  function completedGroup(): FightEntry[] {
    return [
      { ...fight("ab", a, b), completed: true, winner: "draw", flagsRed: 2, flagsBlue: 2 },
      { ...fight("ac", a, c), completed: true, winner: "red", flagsRed: 3, flagsBlue: 0 },
      { ...fight("bc", b, c), completed: true, winner: "red", flagsRed: 3, flagsBlue: 0 },
    ];
  }

  function mount(fights: FightEntry[]): void {
    act(() =>
      useTournamentStore.setState({
        config: {
          ...initialState.config,
          id: "rr-standings-test",
          mode: "round-robin",
          matchType: "sparring",
        },
        competitors,
        groups: [{ id: "G1", competitors, size: 3 }],
        fights,
        phase: "results",
      })
    );
    render(
      <MemoryRouter>
        <StandingsPage />
      </MemoryRouter>
    );
  }

  it("does not advance from a stale local completion when the server result is pending", async () => {
    const fights = completedGroup();
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: serverResult(
        findFight(fights, input.matchId),
        input.matchId === "bc" ? "pending_confirmation" : "confirmed"
      ),
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mount(fights);

    fireEvent.click(screen.getByRole("button", { name: /Resolver desempate/ }));
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(useTournamentStore.getState().fights).toHaveLength(3));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  for (const field of ["flagsRed", "foulsBlue", "warningsRed"] as const) {
    it(`blocks a playoff when the local ${field} differs from the confirmed result`, async () => {
      const fights = completedGroup();
      requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => {
        const entry = fights.find((candidate) => candidate.id === input.matchId);
        if (!entry) return { ok: false, result: null };
        return {
          ok: true,
          result:
            entry.id === "ab"
              ? { ...serverResult(entry), [field]: (entry[field] ?? 0) + 1 }
              : serverResult(entry),
        };
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      mount(fights);

      fireEvent.click(screen.getByRole("button", { name: /Resolver desempate/ }));
      await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(3));
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => expect(useTournamentStore.getState().fights).toHaveLength(3));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("reuses the same proposed fight ID after a 409 and sends all confirmed prerequisites", async () => {
    const fights = completedGroup();
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: serverResult(findFight(fights, input.matchId)),
    }));
    const proposedIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(String(options.body)) as {
          requiredConfirmedFightIds: string[];
          fights: { id: string }[];
        };
        expect(body.requiredConfirmedFightIds).toEqual(["ab", "ac", "bc"]);
        proposedIds.push(body.fights.at(-1)?.id ?? "");
        if (proposedIds.length === 1) {
          return { ok: false, json: async () => ({ error: "pending_result" }) };
        }
        return { ok: true };
      })
    );
    mount(fights);

    fireEvent.click(screen.getByRole("button", { name: /Resolver desempate/ }));
    await waitFor(() => expect(proposedIds).toHaveLength(1));
    expect(useTournamentStore.getState().fights).toHaveLength(3);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /Resolver desempate/ }));
    await waitFor(() => expect(useTournamentStore.getState().fights).toHaveLength(4));
    expect(proposedIds).toHaveLength(2);
    expect(proposedIds[1]).toBe(proposedIds[0]);
    expect(useTournamentStore.getState().fights[3].id).toBe(proposedIds[0]);
  });

  it("creates all three ranked mini-Round-Robin pairings after an exact three-way tie", async () => {
    const fights: FightEntry[] = [
      { ...fight("ab", a, b), completed: true, winner: "draw", flagsRed: 2, flagsBlue: 2 },
      { ...fight("ac", a, c), completed: true, winner: "draw", flagsRed: 2, flagsBlue: 2 },
      { ...fight("bc", b, c), completed: true, winner: "draw", flagsRed: 2, flagsBlue: 2 },
    ];
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: serverResult(findFight(fights, input.matchId)),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }))
    );
    mount(fights);

    fireEvent.click(screen.getByRole("button", { name: /Resolver desempate/ }));
    await waitFor(() => expect(useTournamentStore.getState().fights).toHaveLength(6));
    const mini = useTournamentStore.getState().fights.slice(3);
    expect(mini).toHaveLength(3);
    expect(mini.every((entry) => entry.isTiebreakExtra && entry.playoffKind === "mini")).toBe(true);
    expect(new Set(mini.map((entry) => [entry.red.id, entry.blue.id].sort().join("|"))).size).toBe(
      3
    );
  });

  it("exports a verified playoff winner ahead of provisional table order", async () => {
    const fights = completedGroup();
    const basis = closedGroupBasis("G1", fights, ["a", "b", "c"]);
    expect(basis).not.toBeNull();
    const playoff: FightEntry = {
      ...fight("extra", a, b),
      completed: true,
      winner: "blue",
      isTiebreakExtra: true,
      playoffKind: "direct",
      playoffBasis: basis ?? "",
    };
    const allFights = [...fights, playoff];
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: serverResult(findFight(allFights, input.matchId)),
    }));
    let csv = "";
    const NativeBlob = Blob;
    vi.stubGlobal(
      "Blob",
      class extends NativeBlob {
        constructor(parts: BlobPart[], options?: BlobPropertyBag) {
          super(parts, options);
          csv = String(parts[0]);
        }
      }
    );
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    mount(allFights);

    await waitFor(() => expect(screen.getByRole("button", { name: /Exportar CSV/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /Exportar CSV/ }));
    expect(csv).toMatch(/G1,1,"B"/);
    expect(csv).toMatch(/G1,2,"A"/);
    expect(screen.getByText("Campeón")).toBeInTheDocument();
  });

  it("announces a champion only after every result matches the confirmed server record", async () => {
    const fights: FightEntry[] = [
      { ...fight("ab", a, b), completed: true, winner: "red", flagsRed: 4 },
      { ...fight("ac", a, c), completed: true, winner: "red", flagsRed: 4 },
      { ...fight("bc", b, c), completed: true, winner: "red", flagsRed: 4 },
    ];
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: serverResult(findFight(fights, input.matchId)),
    }));
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    mount(fights);

    await waitFor(() => expect(screen.getByText("Campeón")).toBeInTheDocument());
    expect(screen.getByText("A", { selector: "p" })).toBeInTheDocument();
  });

  it("does not announce or export an unverified local champion", async () => {
    const fights: FightEntry[] = [
      { ...fight("ab", a, b), completed: true, winner: "red", flagsRed: 4 },
      { ...fight("ac", a, c), completed: true, winner: "red", flagsRed: 4 },
      { ...fight("bc", b, c), completed: true, winner: "red", flagsRed: 4 },
    ];
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: serverResult(findFight(fights, input.matchId), "pending_confirmation"),
    }));
    mount(fights);

    await waitFor(() => expect(requestMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.queryByText("Campeón")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exportar CSV/ })).toBeDisabled();
  });
});

describe("clasificación Round Robin provisional", () => {
  it("does not offer a first-place playoff or medal while two normal pairings remain", () => {
    const fights: FightEntry[] = [
      { ...fight("ab", a, b), completed: true, winner: "draw", flagsRed: 2, flagsBlue: 2 },
      fight("ac", a, c),
      fight("bc", b, c),
      { ...fight("premature", a, b), isTiebreakExtra: true, completed: true, winner: "draw" },
    ];
    act(() =>
      useTournamentStore.setState({
        config: {
          ...initialState.config,
          id: "rr-standings-test",
          mode: "round-robin",
          matchType: "sparring",
        },
        competitors,
        groups: [{ id: "G1", competitors, size: 3 }],
        fights,
        phase: "results",
      })
    );

    render(
      <MemoryRouter>
        <StandingsPage />
      </MemoryRouter>
    );

    expect(screen.getByText("Clasificación provisional")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resolver desempate/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Punto de Oro pendiente")).not.toBeInTheDocument();
    expect(screen.queryByText(/1° PUESTO/)).not.toBeInTheDocument();
  });
});
