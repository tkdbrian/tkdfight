import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleSetSparring } from "@/engine/types";
import { SetupPage } from "@/pages/SetupPage";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useTournamentStore } from "@/store/tournament";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ socket: null }) }));
vi.mock("@/lib/tournament-presets", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tournament-presets")>();
  return { ...original, fetchPresets: async () => [] };
});

const initialState = useTournamentStore.getState();

beforeEach(() => {
  sessionStorage.clear();
  act(() => {
    useTournamentStore.setState({
      ...initialState,
      config: {
        ...initialState.config,
        id: crypto.randomUUID(),
        categoryName: "",
        gradeSystem: undefined,
      },
      competitors: [],
      fights: [],
      bracketMatches: [],
      setupStarted: true,
    });
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => useTournamentStore.setState(initialState));
  sessionStorage.clear();
});

describe("editor rápido de categoría", () => {
  it("offers a maintenance entry without starting backup inside the live store", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <SetupPage />
        </MemoryRouter>
      );
    });
    expect(screen.getByRole("link", { name: "Respaldo completo" })).toHaveAttribute(
      "href",
      "/maintenance"
    );
  });
  it("ordena las selecciones y abre solo el panel del sistema de grado elegido", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <SetupPage />
        </MemoryRouter>
      );
    });

    expect(screen.getByRole("group", { name: "Edad" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Sistema de grado" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Género" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Personalizada" }));
    expect(screen.getByRole("spinbutton", { name: "Edad desde" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Edad hasta" })).toBeVisible();

    const kids = screen.getByRole("button", { name: "KIDS (3-5)" });
    expect(kids).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(kids);
    expect(screen.getByRole("button", { name: /Editar Edad/ })).toBeVisible();
    expect(screen.getByRole("group", { name: "Sistema de grado" })).toBeVisible();

    const gups = screen.getByRole("button", { name: "GUPS" });
    fireEvent.click(gups);
    expect(screen.getByRole("group", { name: "Rango GUP" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Grado (Dan)" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Editar Sistema de grado/ }));
    fireEvent.click(screen.getByRole("button", { name: "DANES" }));
    expect(screen.getByRole("group", { name: "Grado (Dan)" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Rango GUP" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Grado Dan desde" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Grado Dan hasta" })).toBeInTheDocument();
  });

  it("recalcula los tiempos Yusan al cambiar de disciplina y formato predeterminado", async () => {
    const base = baseline as RuleSetSparring;
    const state = useTournamentStore.getState();
    act(() =>
      useTournamentStore.setState({
        config: {
          ...state.config,
          categoryName: "Yusan test",
          nameGenerated: false,
          ageDivision: "pre-juniors",
          gradeSystem: "GUPS",
          gupBand: "Amarillos a Puntas Azules",
          profileId: "yusan-2026",
          profileApplied: true,
          mode: "elimination",
          matchType: "sparring",
          ruleSet: { ...base, rounds: { ...base.rounds, count: 1, duration_seconds: 120 } },
          finalSeconds: 120,
        },
      })
    );
    await act(async () =>
      render(
        <MemoryRouter>
          <SetupPage />
        </MemoryRouter>
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
    fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
    let config = useTournamentStore.getState().config;
    expect(config.mode).toBe("elimination");
    expect(
      config.ruleSet?.mode === "sparring" ? config.ruleSet.rounds.duration_seconds : null
    ).toBe(120);

    fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
    config = useTournamentStore.getState().config;
    expect(config.mode).toBe("round-robin");
    expect(
      config.ruleSet?.mode === "sparring" ? config.ruleSet.rounds.duration_seconds : null
    ).toBe(60);
    expect(config.finalSeconds).toBe(120);
    expect(config.profileApplied).toBe(true);
  });

  it.each([
    undefined,
    "yusan-2026",
  ] as const)("no pisa tiempos de categoría antigua o personalizada (perfil %s)", async (profileId) => {
    const base = baseline as RuleSetSparring;
    const state = useTournamentStore.getState();
    act(() =>
      useTournamentStore.setState({
        config: {
          ...state.config,
          categoryName: "Custom timing test",
          nameGenerated: false,
          profileId,
          profileApplied: false,
          mode: "elimination",
          ruleSet: { ...base, rounds: { ...base.rounds, duration_seconds: 177 } },
          finalSeconds: 188,
        },
      })
    );
    await act(async () =>
      render(
        <MemoryRouter>
          <SetupPage />
        </MemoryRouter>
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
    fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
    fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
    const config = useTournamentStore.getState().config;
    expect(config.mode).toBe("round-robin");
    expect(
      config.ruleSet?.mode === "sparring" ? config.ruleSet.rounds.duration_seconds : null
    ).toBe(177);
    expect(config.finalSeconds).toBe(188);
    expect(config.profileApplied).toBe(false);
  });
});

it("keeps configured empty restart drafts in competitor preparation rather than the welcome screen", async () => {
  act(() =>
    useTournamentStore.setState({
      setupStarted: false,
      phase: "setup",
      config: { ...useTournamentStore.getState().config, categoryName: "Retained category" },
    })
  );
  await act(async () => {
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    );
  });
  expect(screen.getByPlaceholderText("Nombre del competidor")).toBeVisible();
  expect(screen.getByTestId("category-primary-action")).toHaveTextContent(/Iniciar categor/);
  expect(screen.getByTestId("category-primary-action")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Nuevo torneo" })).not.toBeInTheDocument();
});
