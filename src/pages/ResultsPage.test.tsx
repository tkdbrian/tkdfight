import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResultsPage } from "@/pages/ResultsPage";
import { type CompetitorEntry, type FightEntry, useTournamentStore } from "@/store/tournament";

const requestMock = vi.hoisted(() =>
  vi.fn<(event: string, input: { matchId: string }) => Promise<unknown>>()
);

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

function bout(
  id: string,
  red: CompetitorEntry,
  blue: CompetitorEntry,
  winner: FightEntry["winner"],
  flagsRed: number,
  flagsBlue: number,
  foulsRed = 0,
  foulsBlue = 0,
  warningsRed = 0,
  warningsBlue = 0
): FightEntry {
  return {
    id,
    red,
    blue,
    groupId: "G1",
    completed: true,
    winner,
    flagsRed,
    flagsBlue,
    foulsRed,
    foulsBlue,
    warningsRed,
    warningsBlue,
  };
}

function renderResults(fights: FightEntry[]): void {
  act(() =>
    useTournamentStore.setState({
      config: {
        ...initialState.config,
        id: "rr-results-test",
        mode: "round-robin",
        matchType: "sparring",
      },
      competitors,
      groups: [{ id: "G1", competitors, size: 3 }],
      fights,
      phase: "results",
    })
  );
  render(<ResultsPage />);
}

function rankedNames(): string[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[1].textContent?.trim() ?? "");
}

beforeEach(() => requestMock.mockImplementation(async () => null));

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  act(() => useTournamentStore.setState(initialState));
});

describe("Resultados de Round Robin", () => {
  it("orders equal classification points by flags, then fewer penalty points and warnings", () => {
    renderResults([
      bout("ab", a, b, "draw", 2, 2),
      bout("ac", a, c, "red", 2, 1, 0, 0, 1),
      bout("bc", b, c, "red", 3, 1),
    ]);
    expect(rankedNames()).toEqual(["B", "A", "C"]);
    expect(screen.getByRole("columnheader", { name: "Banderines" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Pt. contra" })).toBeInTheDocument();
  });

  it.each([
    { foulsA: 1, foulsB: 0, warningsA: 0, warningsB: 2 },
    { foulsA: 0, foulsB: 0, warningsA: 2, warningsB: 1 },
  ])("uses fewer penalties before fewer warnings when flags also tie", ({
    foulsA,
    foulsB,
    warningsA,
    warningsB,
  }) => {
    renderResults([
      bout("ab", a, b, "draw", 2, 2),
      bout("ac", a, c, "red", 3, 1, foulsA, 0, warningsA),
      bout("bc", b, c, "red", 3, 1, foulsB, 0, warningsB),
    ]);
    expect(rankedNames()).toEqual(["B", "A", "C"]);
  });

  it("does not crown a provisional leader while normal pairings remain unfinished", () => {
    renderResults([
      bout("ab", a, b, "draw", 2, 2),
      { ...bout("ac", a, c, undefined, 0, 0), completed: false },
      { ...bout("bc", b, c, undefined, 0, 0), completed: false },
    ]);
    expect(screen.getByText(/Clasificación provisional:/)).toBeInTheDocument();
    expect(screen.queryByText("🥇")).not.toBeInTheDocument();
  });

  it("keeps a locally completed winner provisional if a server result is pending", async () => {
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => ({
      ok: true,
      result: {
        fightId: input.matchId,
        categoryId: "rr-results-test",
        status: input.matchId === "bc" ? "pending_confirmation" : "confirmed",
        winner: "red",
        flagsRed: 4,
        flagsBlue: 0,
        foulsRed: 0,
        foulsBlue: 0,
        warningsRed: 0,
        warningsBlue: 0,
      },
    }));
    renderResults([
      bout("ab", a, b, "red", 4, 0),
      bout("ac", a, c, "red", 4, 0),
      bout("bc", b, c, "red", 4, 0),
    ]);
    await waitFor(() => expect(requestMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText(/Clasificación provisional:/)).toBeInTheDocument();
    expect(screen.queryByText("🥇")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exportar HTML/ })).toBeDisabled();
  });

  it("shows the official podium only after all completed results match the server", async () => {
    const fights = [
      bout("ab", a, b, "red", 4, 0),
      bout("ac", a, c, "red", 4, 0),
      bout("bc", b, c, "red", 4, 0),
    ];
    requestMock.mockImplementation(async (_event: string, input: { matchId: string }) => {
      const entry = fights.find((candidate) => candidate.id === input.matchId);
      if (!entry) return { ok: false, result: null };
      return {
        ok: true,
        result: {
          fightId: entry.id,
          categoryId: "rr-results-test",
          status: "confirmed",
          winner: entry.winner,
          flagsRed: entry.flagsRed,
          flagsBlue: entry.flagsBlue,
          foulsRed: entry.foulsRed,
          foulsBlue: entry.foulsBlue,
          warningsRed: entry.warningsRed,
          warningsBlue: entry.warningsBlue,
        },
      };
    });
    renderResults(fights);
    await waitFor(() => expect(screen.getByText("🥇")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Exportar HTML/ })).toBeEnabled();
  });
});
