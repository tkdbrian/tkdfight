import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateEliminationBracket } from "@/lib/bracket";
import { SetupPage } from "@/pages/SetupPage";
import {
  CATEGORY_START_REASON,
  CATEGORY_START_RECOVERY_REASON,
  useTournamentStore,
} from "@/store/tournament";

vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({
    socket: null,
    connected: true,
    stateReady: true,
    state: { match: null, activeMatchLock: null },
  }),
}));
vi.mock("@/lib/tournament-presets", async (original) => ({
  ...(await original<typeof import("@/lib/tournament-presets")>()),
  fetchPresets: async () => [],
}));

const initial = useTournamentStore.getState();

beforeEach(() => {
  sessionStorage.clear();
  useTournamentStore.setState({
    ...initial,
    config: {
      ...initial.config,
      id: crypto.randomUUID(),
      categoryName: "Elimination lock test",
      nameGenerated: false,
      mode: "elimination",
      matchType: "sparring",
    },
    competitors: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    fights: [],
    groups: [],
    bracketMatches: [],
    bracketSeeds: [],
    phase: "setup",
    setupStarted: true,
    categoryOperationReason: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}"))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useTournamentStore.setState(initial, true);
  sessionStorage.clear();
});

it("commits elimination bracket and seeds before leaving the start lock", async () => {
  await act(async () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
  });
  const start = screen.getByTestId("category-primary-action");
  expect(start).toBeEnabled();
  fireEvent.click(start);
  await waitFor(() => expect(useTournamentStore.getState().phase).toBe("fighting"));
  const state = useTournamentStore.getState();
  expect(state.bracketMatches.length).toBeGreaterThan(0);
  expect(state.bracketSeeds).toContain("a");
  expect(state.bracketSeeds).toContain("b");
  expect(state.categoryOperationReason).toBeNull();
});

it("keeps the sole start action directly after competitor entry in keyboard order", async () => {
  await act(async () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
  });
  const start = screen.getByRole("button", { name: "Iniciar categoría" });
  const add = screen.getByRole("button", { name: "Agregar competidor" });
  const roster = screen.getByTestId("setup-competitor-list");
  expect(screen.getAllByRole("button", { name: "Iniciar categoría" })).toHaveLength(1);
  expect(start.closest("#tour-competitor-card")).not.toBeNull();
  expect(add.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(start.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(start).toHaveClass("h-14");
  expect(start).toHaveClass("focus-visible:ring-2");
});

it("explains a disabled nearby start and enables it when the roster reaches the minimum", async () => {
  useTournamentStore.setState({ competitors: [{ id: "a", name: "A" }] });
  await act(async () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
  });
  const start = screen.getByRole("button", { name: "Iniciar categoría" });
  expect(start).toBeDisabled();
  expect(start).toHaveAccessibleDescription("Mínimo 2 competidores");
  expect(screen.getByText("Mínimo 2 competidores")).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre del competidor" }), {
    target: { value: "B" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Agregar competidor" }));
  expect(start).toBeEnabled();
  expect(screen.getAllByRole("button", { name: "Iniciar categoría" })).toHaveLength(1);
});

it("still rejects bracket mutation in recovery quarantine", () => {
  const store = useTournamentStore.getState();
  store.setCategoryOperationReason(CATEGORY_START_RECOVERY_REASON);
  store.setBracket([], ["a", "b"]);
  expect(useTournamentStore.getState().bracketSeeds).toEqual([]);
});

it("blocks public fixture setters during START but permits one atomic guarded commit", () => {
  const expected = useTournamentStore.getState();
  const store = useTournamentStore.getState();
  store.setCategoryOperationReason(CATEGORY_START_REASON);
  store.setPhase("fighting");
  store.setFights([]);
  store.setGroups([]);
  store.setBracket([], ["a", "b"]);
  expect(useTournamentStore.getState().phase).toBe("setup");
  expect(useTournamentStore.getState().fights).toBe(expected.fights);
  expect(useTournamentStore.getState().groups).toBe(expected.groups);
  expect(useTournamentStore.getState().bracketSeeds).toBe(expected.bracketSeeds);
  const { matches, seeds } = generateEliminationBracket(expected.competitors);
  expect(store.commitCategoryStart(expected, { mode: "elimination", matches, seeds })).toBe(true);
  expect(useTournamentStore.getState().bracketMatches).toEqual(matches);
  expect(useTournamentStore.getState().phase).toBe("fighting");
});

it("rejects an atomic commit after the draft changes or enters recovery quarantine", () => {
  const store = useTournamentStore.getState();
  const expected = useTournamentStore.getState();
  const { matches, seeds } = generateEliminationBracket(expected.competitors);
  store.setCategoryOperationReason(CATEGORY_START_REASON);
  useTournamentStore.setState((state) => ({ config: { ...state.config } }));
  expect(store.commitCategoryStart(expected, { mode: "elimination", matches, seeds })).toBe(false);
  expect(useTournamentStore.getState().phase).toBe("setup");
  useTournamentStore.getState().setCategoryOperationReason(CATEGORY_START_RECOVERY_REASON);
  expect(
    store.commitCategoryStart(useTournamentStore.getState(), {
      mode: "elimination",
      matches,
      seeds,
    })
  ).toBe(false);
  expect(useTournamentStore.getState().bracketMatches).toEqual([]);
});

it("keeps structural choices optional while a manual name enables later start", async () => {
  useTournamentStore.getState().setConfig({ categoryName: "", nameGenerated: true });
  await act(async () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
  });
  fireEvent.click(screen.getByRole("button", { name: "No especificar Edad" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  fireEvent.click(screen.getByRole("button", { name: "Eliminación" }));
  expect(screen.getByTestId("category-primary-action")).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre de la categoría" }), {
    target: { value: "Abierta" },
  });
  expect(screen.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Abierta");
  expect(screen.getByTestId("category-primary-action")).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Continuar con competidores" }));
  expect(useTournamentStore.getState().phase).toBe("setup");
  expect(useTournamentStore.getState().fights).toEqual([]);
});
