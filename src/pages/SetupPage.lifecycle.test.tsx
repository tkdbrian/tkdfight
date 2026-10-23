import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bracket from "@/lib/bracket";
import { BracketPage } from "@/pages/BracketPage";
import { SetupPage } from "@/pages/SetupPage";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const socket = vi.hoisted(() => ({
  connected: true,
  stateReady: true,
  socket: null,
  request: vi.fn(),
  state: { match: null, activeMatchLock: null } as {
    match: null;
    activeMatchLock: { fightId: string; categoryId: string; resultStatus: string } | null;
  },
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => socket }));
vi.mock("@/lib/tournament-presets", async (original) => ({
  ...(await original<typeof import("@/lib/tournament-presets")>()),
  fetchPresets: async () => [],
}));
const initial = useTournamentStore.getState();
function Location(): React.JSX.Element {
  const location = useLocation();
  return <><output data-testid="route">{location.pathname}</output><output data-testid="navigation-state">{JSON.stringify(location.state)}</output></>;
}
beforeEach(() => {
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  socket.state = { match: null, activeMatchLock: null };
  socket.request.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}"))
  );
});
afterEach(() => {
  cleanup();
  useCategoryDeletionState.setState({ pending: false, recoveryRequired: false, message: null, observed: [] });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("category lifecycle entrypoints", () => {
  it("keeps Delete in a separate secondary menu and disables primary/restart during deletion recovery", async () => {
    useTournamentStore.setState(recordedCategory());
    await act(async () => render(<MemoryRouter><SetupPage /></MemoryRouter>));
    fireEvent.click(screen.getByText("Más acciones de categoría"));
    expect(screen.getByRole("button", { name: "Eliminar categoría…" })).toBeVisible();
    act(() => useCategoryDeletionState.setState({ recoveryRequired: true }));
    expect(screen.getByRole("button", { name: "Ir a Combate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reiniciar categoría…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Eliminar categoría…" })).toBeDisabled();
  });
  it("continues stored RR with progress, without regenerating or posting a fixture", async () => {
    const snapshot = recordedCategory();
    snapshot.currentFightIndex = 0;
    snapshot.fights[0] = { ...snapshot.fights[0], completed: true, winner: "red" };
    useTournamentStore.setState(snapshot);
    const generate = vi.spyOn(bracket, "generateGroupsTournament");
    await act(async () =>
      render(
        <MemoryRouter>
          <SetupPage />
          <Location />
        </MemoryRouter>
      )
    );
    expect(screen.getByText("Fixture guardado")).toBeVisible();
    expect(screen.getByText("1 de 3 combates completados")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ir a Combate" }));
    expect(screen.getByTestId("route")).toHaveTextContent("/fight");
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(JSON.parse(screen.getByTestId("navigation-state").textContent ?? "null")).toEqual({ kind: "category-continue", categoryId: snapshot.config.id, fightId: snapshot.fights[1].id });
    expect(generate).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
    expect(useTournamentStore.getState().fights).toEqual(snapshot.fights);
  });

  it.each([
    "setup",
    "bracket",
  ])("uses one explicit archive confirmation from %s and cancel preserves the graph", async (page) => {
    const snapshot = recordedCategory(5);
    if (page === "bracket") {
      snapshot.config.mode = "elimination";
      const graph = bracket.generateEliminationBracket(snapshot.competitors);
      snapshot.bracketMatches = graph.matches;
      snapshot.bracketSeeds = graph.seeds;
      snapshot.fights = [];
    }
    useTournamentStore.setState(snapshot);
    await act(async () =>
      render(<MemoryRouter>{page === "setup" ? <SetupPage /> : <BracketPage />}</MemoryRouter>)
    );
    expect(screen.queryByRole("button", { name: "Regenerar" })).not.toBeInTheDocument();
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Mayores");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Se archivará la ejecución actual y se creará otra desde cero. Se conservarán los competidores, la configuración y el historial."
    );
    expect(screen.getByRole("button", { name: "Archivar y reiniciar" })).toBeVisible();
    expect(warnings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useTournamentStore.getState().config.id).toBe(snapshot.config.id);
    expect(vi.mocked(fetch).mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });

  it("navigates to the pending own result without an import or restart confirmation", async () => {
    const snapshot = recordedCategory();
    useTournamentStore.setState(snapshot);
    socket.state.activeMatchLock = {
      fightId: snapshot.fights[0].id,
      categoryId: snapshot.config.id,
      resultStatus: "pending_confirmation",
    };
    await act(async () =>
      render(
        <MemoryRouter>
          <SetupPage />
          <Location />
        </MemoryRouter>
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Revisar resultado pendiente" }));
    expect(screen.getByTestId("route")).toHaveTextContent("/fight");
    expect(screen.getByRole("button", { name: "Reiniciar categoría…" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("never regenerates over restored elimination fights whose bracket graph is missing", async () => {
    const snapshot = recordedCategory();
    snapshot.config.mode = "elimination";
    snapshot.fights[0] = { ...snapshot.fights[0], completed: true, winner: "red" };
    useTournamentStore.setState(snapshot);
    await act(async () =>
      render(
        <MemoryRouter>
          <BracketPage />
        </MemoryRouter>
      )
    );
    expect(screen.queryByRole("button", { name: "Generar bracket" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reiniciar categoría…" })).toBeVisible();
    expect(screen.getByText(/Falta la llave guardada/)).toBeVisible();
    expect(useTournamentStore.getState().fights).toEqual(snapshot.fights);
  });

  it.each([
    true,
    false,
  ])("requires matching durable confirmations before showing results (%s)", async (matching) => {
    const snapshot = recordedCategory();
    snapshot.fights = snapshot.fights.map((fight) => ({
      ...fight,
      completed: true,
      winner: fight.red.id === "entrant-0" || fight.blue.id !== "entrant-0" ? "red" : "blue",
      flagsRed: 0,
      flagsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
    }));
    useTournamentStore.setState(snapshot);
    socket.request.mockImplementation(async (_event: string, payload: { matchId: string }) => {
      const fight = snapshot.fights.find((entry) => entry.id === payload.matchId);
      if (!fight) throw new Error("Unexpected result lookup");
      return {
        ok: true,
        result: {
          ...fight,
          fightId: fight.id,
          categoryId: snapshot.config.id,
          status: "confirmed",
          flagsRed: matching ? 0 : 1,
        },
      };
    });
    await act(async () =>
      render(
        <MemoryRouter>
          <SetupPage />
          <Location />
        </MemoryRouter>
      )
    );
    expect(
      screen.getByRole("button", { name: matching ? "Ver resultados" : "Revisar clasificación" })
    ).toBeVisible();
    expect(socket.request).toHaveBeenCalledTimes(3);
    if (matching) {
      fireEvent.click(screen.getByRole("button", { name: "Ver resultados" }));
      expect(screen.getByTestId("route")).toHaveTextContent("/results");
    }
    expect(vi.mocked(fetch).mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });
});
