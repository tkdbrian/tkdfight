import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SetupPage } from "@/pages/SetupPage";
import { useTournamentStore } from "@/store/tournament";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ socket: null }) }));
vi.mock("@/lib/tournament-presets", async (original) => ({
  ...(await original<typeof import("@/lib/tournament-presets")>()),
  fetchPresets: async () => [],
}));

const initial = useTournamentStore.getState();

beforeEach(() => {
  sessionStorage.clear();
  useTournamentStore.setState({
    ...initial,
    config: { ...initial.config, id: crypto.randomUUID(), categoryName: "" },
    competitors: [],
    fights: [],
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

async function remountSetup(): Promise<void> {
  cleanup();
  await renderSetup();
}

function chooseNewSparring(weight: string | null = null): void {
  fireEvent.click(screen.getByRole("button", { name: "No especificar Edad" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  fireEvent.click(screen.getByRole("button", { name: weight ?? "No especificar Peso" }));
  fireEvent.click(screen.getByRole("button", { name: "Round Robin" }));
}

it("shows large guided controls, timing summary, then optional advanced and Mesa", async () => {
  await renderSetup();
  expect(screen.getByRole("group", { name: "Categoría" }).parentElement).toHaveClass("items-start");
  expect(screen.getByRole("group", { name: "Combate y tiempos" })).toBeInTheDocument();
  expect(screen.getByText(/Desempate:/)).toBeVisible();
  expect(screen.queryByRole("group", { name: "Mesa" })).not.toBeInTheDocument();
  const age = screen.getByRole("button", { name: "KIDS (3-5)" });
  expect(age).toHaveClass("min-h-11", "focus-visible:ring-2");
  fireEvent.click(age);
  expect(useTournamentStore.getState().config.categoryAgeFrom).toBe("3");
  expect(screen.getByRole("group", { name: "Sistema de grado" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Peso" }));
  fireEvent.click(screen.getByRole("button", { name: "Round Robin" }));
  fireEvent.click(screen.getByText("Opciones avanzadas: presets y Yusan"));
  expect(
    screen.getByRole("button", { name: "Seleccionar perfil Yusan 2026 para este torneo" })
  ).toBeVisible();
  fireEvent.click(screen.getByText("Mesa (opcional)"));
  expect(screen.getByRole("group", { name: "Mesa" })).toBeVisible();
});

it("hides Tul weight, restores this category session weight, and preserves a manual name", async () => {
  useTournamentStore.setState({
    config: {
      ...useTournamentStore.getState().config,
      categoryName: "Junior · Liviano A",
      nameGenerated: false,
      weightLabel: "Liviano A",
      matchType: "sparring",
    },
  });
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  expect(screen.queryByRole("group", { name: "Peso" })).not.toBeInTheDocument();
  expect(useTournamentStore.getState().config.weightLabel).toBeUndefined();
  expect(useTournamentStore.getState().config.categoryName).toBe("Junior · Liviano A");
  expect(screen.getByText(/menciona el peso anterior/i)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar nombre con los datos seleccionados" })
  );
  expect(useTournamentStore.getState().config.categoryName).not.toContain("Liviano A");
  fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  expect(useTournamentStore.getState().config.weightLabel).toBe("Liviano A");
});

it("opens a new blank draft after closing and focuses competitors after Continue", async () => {
  await renderSetup();
  chooseNewSparring();
  fireEvent.click(screen.getByRole("button", { name: "Continuar con competidores" }));
  expect(screen.queryByRole("group", { name: "Categoría" })).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText("Nombre del competidor")).toHaveFocus();
  act(() =>
    useTournamentStore.setState({
      config: {
        ...useTournamentStore.getState().config,
        id: crypto.randomUUID(),
        categoryName: "",
      },
    })
  );
  await remountSetup();
  expect(screen.getByRole("group", { name: "Edad" })).toBeVisible();
});

it("keeps generated Tul names weight-free and stashes weight by category", async () => {
  const categoryA = useTournamentStore.getState().config.id;
  await renderSetup();
  chooseNewSparring("Liviano A");
  expect(useTournamentStore.getState().config.categoryName).toContain("Liviano A");
  fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  const savedA = useTournamentStore.getState().config;
  expect(savedA.weightLabel).toBeUndefined();
  expect(savedA.categoryName).not.toContain("Liviano A");

  act(() =>
    useTournamentStore.setState({
      config: {
        ...initial.config,
        id: crypto.randomUUID(),
        categoryName: "",
        matchType: "sparring",
        weightLabel: "Mediano B",
      },
    })
  );
  await remountSetup();
  fireEvent.click(screen.getByRole("button", { name: "No especificar Edad" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  expect(useTournamentStore.getState().config.weightLabel).toBeUndefined();

  act(() => useTournamentStore.setState({ config: savedA }));
  await remountSetup();
  expect(useTournamentStore.getState().config.id).toBe(categoryA);
  fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  expect(useTournamentStore.getState().config.weightLabel).toBe("Liviano A");
  expect(useTournamentStore.getState().config.categoryName).toContain("Liviano A");
});

it("warns about an imported Tul name mentioning weight without rewriting it", async () => {
  useTournamentStore.setState({
    config: {
      ...useTournamentStore.getState().config,
      categoryName: "Junior · Liviano A",
      nameGenerated: false,
      matchType: "tul",
      weightLabel: undefined,
    },
  });
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.queryByRole("group", { name: "Peso" })).not.toBeInTheDocument();
  expect(screen.getByText(/menciona el peso anterior/i)).toBeVisible();
  expect(useTournamentStore.getState().config.categoryName).toBe("Junior · Liviano A");
});

it("removes the complete weight phrase when updating an imported Tul name", async () => {
  useTournamentStore.setState({
    config: {
      ...useTournamentStore.getState().config,
      categoryName: "Junior - Peso Liviano A",
      nameGenerated: false,
      matchType: "tul",
      weightLabel: undefined,
    },
  });
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: /Configurar categor\u00eda/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar nombre con los datos seleccionados" })
  );
  expect(useTournamentStore.getState().config.categoryName).toBe("Junior");
});
