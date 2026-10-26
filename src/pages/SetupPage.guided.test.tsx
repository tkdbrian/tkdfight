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

it("reveals one decision at a time and keeps completed answers editable", async () => {
  await renderSetup();
  expect(screen.getByRole("group", { name: "Edad" })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Sistema de grado" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Género" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "KIDS (3-5)" }));
  expect(screen.getByRole("button", { name: /Editar Edad/ })).toBeVisible();
  expect(screen.getByRole("group", { name: "Sistema de grado" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "GUPS" }));
  expect(screen.getByRole("group", { name: "Rango GUP" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Blancos y Puntas Amarillas" }));
  expect(screen.getByRole("group", { name: "Género" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Masculino" }));
  expect(screen.getByRole("group", { name: "Disciplina" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  expect(screen.getByRole("group", { name: "Peso" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Liviano A" }));
  expect(screen.getByRole("group", { name: "Formato" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Round Robin" }));
  expect(screen.getByRole("button", { name: "Continuar con competidores" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Editar Edad/ }));
  expect(screen.getByRole("group", { name: "Edad" })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Sistema de grado" })).not.toBeInTheDocument();
});

it("can omit optional fields and reach competitors without initiating the category", async () => {
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: "No especificar Edad" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  expect(screen.queryByRole("group", { name: "Peso" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Eliminación" }));
  const categoryName = screen.getByRole("textbox", { name: "Nombre de la categoría" });
  expect(categoryName).toHaveAccessibleDescription(/Poné un nombre/);
  fireEvent.change(categoryName, { target: { value: "Categoría abierta" } });
  expect(useTournamentStore.getState().config.categoryName).toBe("Categoría abierta");
  expect(useTournamentStore.getState().config.nameGenerated).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Continuar con competidores" }));
  expect(screen.getByPlaceholderText("Nombre del competidor")).toHaveFocus();
  expect(useTournamentStore.getState().config.gradeSystem).toBeUndefined();
  expect(useTournamentStore.getState().config.sexDivision).toBeUndefined();
  expect(useTournamentStore.getState().config.weightLabel).toBeUndefined();
  expect(useTournamentStore.getState().fights).toHaveLength(0);
});

it("resumes per-category progress across a keyed remount", async () => {
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: "KIDS (3-5)" }));
  cleanup();
  await renderSetup();
  expect(screen.getByRole("group", { name: "Sistema de grado" })).toBeVisible();
  expect(screen.getByRole("button", { name: /Editar Edad/ })).toBeVisible();
});

it("recovers an applicable step when stored progress targets a hidden question", async () => {
  const id = useTournamentStore.getState().config.id;
  useTournamentStore.setState((state) => ({
    config: { ...state.config, matchType: "tul", gradeSystem: undefined },
  }));
  sessionStorage.setItem(
    `tkd-category-guided-v1:${id}`,
    JSON.stringify({
      active: "weight",
      completed: ["age", "grade", "gender", "discipline"],
    })
  );
  await renderSetup();
  expect(screen.getByTestId("guided-active-step")).toHaveTextContent("Formato");
  expect(screen.getByRole("group", { name: "Formato" })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Peso" })).not.toBeInTheDocument();
});

it("validates custom age and Dan range before advancing without saving partial values", async () => {
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: "Personalizada" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Edad desde" }), {
    target: { value: "12" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Edad hasta" }), {
    target: { value: "10" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar edad" }));
  expect(screen.getByRole("alert")).toHaveTextContent("inicial no puede superar");
  expect(useTournamentStore.getState().config.categoryAgeFrom).toBeUndefined();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Edad hasta" }), {
    target: { value: "14" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar edad" }));
  expect(useTournamentStore.getState().config.categoryAgeFrom).toBe("12");
  expect(screen.getByTestId("guided-active-step")).toHaveTextContent("Sistema de grado");
  expect(screen.getByTestId("guided-active-step")).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "DANES" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Grado Dan desde" }), {
    target: { value: "3" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Grado Dan hasta" }), {
    target: { value: "1" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar rango Dan" }));
  expect(screen.getByRole("alert")).toHaveTextContent("inicial no puede superar");
  expect(useTournamentStore.getState().config.danFrom).toBeUndefined();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Grado Dan hasta" }), {
    target: { value: "4" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar rango Dan" }));
  expect(useTournamentStore.getState().config.danFrom).toBe(3);
  expect(screen.getByRole("group", { name: "Género" })).toBeVisible();
});

it("reconfirming selected guided choices never clears them", async () => {
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: "KIDS (3-5)" }));
  fireEvent.click(screen.getByRole("button", { name: "GUPS" }));
  fireEvent.click(screen.getByRole("button", { name: "Blancos y Puntas Amarillas" }));
  fireEvent.click(screen.getByRole("button", { name: /Editar Sistema de grado/ }));
  fireEvent.click(screen.getByRole("button", { name: "GUPS" }));
  expect(useTournamentStore.getState().config.gradeSystem).toBe("GUPS");
  fireEvent.click(screen.getByRole("button", { name: "Blancos y Puntas Amarillas" }));
  fireEvent.click(screen.getByRole("button", { name: "Masculino" }));
  fireEvent.click(screen.getByRole("button", { name: /Editar Género/ }));
  fireEvent.click(screen.getByRole("button", { name: "Masculino" }));
  expect(useTournamentStore.getState().config.sexDivision).toBe("Masculino");
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  fireEvent.click(screen.getByRole("button", { name: "Liviano A" }));
  fireEvent.click(screen.getByRole("button", { name: /Editar Peso/ }));
  fireEvent.click(screen.getByRole("button", { name: "Liviano A" }));
  expect(useTournamentStore.getState().config.weightLabel).toBe("Liviano A");
  expect(screen.getByRole("group", { name: "Formato" })).toBeVisible();
});
