import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateEliminationBracket } from "@/lib/bracket";
import { SetupPage } from "@/pages/SetupPage";
import { useTournamentStore } from "@/store/tournament";

vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({ socket: null, connected: false, stateReady: false, state: {} }),
}));
vi.mock("@/lib/tournament-presets", async (original) => ({
  ...(await original<typeof import("@/lib/tournament-presets")>()),
  fetchPresets: async () => [],
}));

const initial = useTournamentStore.getState();
const competitors = [
  { id: "juan", name: "Juan" },
  { id: "sebastian", name: "Sebastian" },
  { id: "pedro", name: "Pedro" },
];

beforeEach(() => {
  sessionStorage.clear();
  useTournamentStore.setState({
    ...initial,
    config: {
      ...initial.config,
      id: crypto.randomUUID(),
      categoryName: "Prueba de eliminación",
      nameGenerated: false,
      mode: "elimination",
    },
    competitors,
    fights: [],
    groups: [],
    bracketMatches: [],
    setupStarted: true,
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

async function renderSetup(): Promise<void> {
  await act(async () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
  });
}

it("shows the playable semifinal and pending final for three entrants without a bye row", async () => {
  await renderSetup();
  const preview = screen.getByTestId("setup-fixture-preview");
  expect(screen.getByText("2 combates")).toBeVisible();
  expect(within(preview).getByText("Semifinal")).toBeVisible();
  expect(within(preview).getByText("Final")).toBeVisible();
  expect(within(preview).getAllByTestId("preview-fight-row")).toHaveLength(2);
  expect(within(preview).getByText("Por definir")).toBeVisible();
  expect(within(preview).getByText("Pedro")).toBeVisible();
});

it("counts only playable elimination matches with two and five entrants", async () => {
  useTournamentStore.setState({ competitors: competitors.slice(0, 2) });
  await renderSetup();
  expect(screen.getByText("1 combate")).toBeVisible();
  expect(
    within(screen.getByTestId("setup-fixture-preview")).getAllByTestId("preview-fight-row")
  ).toHaveLength(1);
  cleanup();
  useTournamentStore.setState({
    config: { ...useTournamentStore.getState().config, id: crypto.randomUUID() },
    competitors: [...competitors, { id: "ana", name: "Ana" }, { id: "luis", name: "Luis" }],
  });
  await renderSetup();
  expect(screen.getByText("4 combates")).toBeVisible();
  expect(
    within(screen.getByTestId("setup-fixture-preview")).getAllByTestId("preview-fight-row")
  ).toHaveLength(4);
});

it("hides bye rows in a started elimination bracket too", async () => {
  useTournamentStore.setState({
    bracketMatches: generateEliminationBracket(competitors).matches,
    phase: "fighting",
  });
  await renderSetup();
  expect(screen.getByText("2 combates")).toBeVisible();
  expect(screen.getByText("0 de 2 combates completados")).toBeVisible();
  expect(
    within(screen.getByTestId("setup-fixture-preview")).getAllByTestId("preview-fight-row")
  ).toHaveLength(2);
});

it("uses a responsive full-width answer grid and readable competitor controls", async () => {
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  const grid = screen.getByTestId("category-answer-grid");
  expect(grid).toHaveClass("grid-cols-1", "lg:grid-cols-2", "2xl:grid-cols-3");
  const age = screen.getByRole("button", { name: /Editar Edad/ });
  expect(age).toHaveClass("whitespace-normal");
  const input = screen.getByPlaceholderText("Nombre del competidor");
  expect(input).toHaveClass("h-12", "text-base");
  const list = screen.getByTestId("setup-competitor-list");
  expect(within(list).getByText("Juan")).toHaveClass("text-lg");
  const preview = screen.getByTestId("setup-fixture-preview");
  expect(within(preview).getByText("Juan")).not.toHaveClass("truncate");
});
