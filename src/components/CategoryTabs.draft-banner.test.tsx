import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CategoryTabs } from "@/components/CategoryTabs";
import type { ServerState } from "@/lib/socket-types";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, type TournamentMode, useTournamentStore } from "@/store/tournament";

const initialStore = useTournamentStore.getState();
const serverState: ServerState = { rules: null, match: null, matchState: null, matchPaused: false,
  judges: [], judgeVotes: {}, judgeTotals: {}, roundFlags: [], fallos: [], serverUrl: "",
  penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } } };

beforeEach(() => {
  localStorage.removeItem("tkd-tournament");
  localStorage.removeItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
  act(() => useTournamentStore.setState({ ...initialStore, phase: "setup", competitors: [], fights: [],
    config: { ...initialStore.config, id: "previous-test-category", categoryName: "Anterior" } }));
});
afterEach(() => {
  cleanup(); act(() => useTournamentStore.setState(initialStore));
  localStorage.removeItem("tkd-tournament");
  localStorage.removeItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
});

function makeDraft(mode: TournamentMode): void {
  act(() => {
    useTournamentStore.getState().setConfig({ mode });
    expect(useTournamentStore.getState().createCategory()).not.toBeNull();
    useTournamentStore.getState().setConfig({ categoryName: "Liviano B" });
  });
}
function mount(connected = true): void {
  render(<MemoryRouter><CategoryTabs connected={connected} stateReady={connected} serverState={serverState} /></MemoryRouter>);
}

describe("mensaje neutral de categoría en preparación", () => {
  it("keeps active category tabs and controls reachable at narrow mobile widths", () => {
    makeDraft("round-robin");
    const categoryId = useTournamentStore.getState().config.id;
    render(<MemoryRouter><CategoryTabs connected stateReady serverState={{
      ...serverState,
      activeMatchLock: { fightId: "isolated-fight", categoryId, tournamentId: 1, resultStatus: null },
    }} /></MemoryRouter>);

    const selectedTab = screen.getByRole("tab", { selected: true });
    expect(selectedTab.className).toContain("min-h-11");
    expect(screen.getByText("Liviano B", { selector: "span" }).className).toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Agregar categoría" }).className).toContain("h-11");
    expect(screen.getByRole("button", { name: "Desplazar categorías a la izquierda" }).className).toContain("hidden");
    const combatNotice = screen.getByText("Combate cargado").closest('[role="status"]');
    expect(combatNotice?.className).toContain("flex-wrap");
    expect(combatNotice).not.toHaveTextContent("Liviano B");
  });

  it("still names another category when its loaded bout blocks the selected one", () => {
    makeDraft("round-robin");
    render(<MemoryRouter><CategoryTabs connected stateReady serverState={{
      ...serverState,
      activeMatchLock: { fightId: "other-fight", categoryId: "previous-test-category", tournamentId: 1, resultStatus: null },
    }} /></MemoryRouter>);
    expect(screen.getByText("Combate en Anterior")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Volver al combate" })).toBeInTheDocument();
  });

  it("shows the complete long category identity on combat mobile without a second heading", () => {
    makeDraft("round-robin");
    const longName = "Pesado A · Blancos y Puntas Amarillas · Femenino · 6–7 años";
    act(() => useTournamentStore.getState().setConfig({ categoryName: longName }));
    render(<MemoryRouter initialEntries={["/fight"]}>
      <CategoryTabs connected stateReady serverState={serverState} />
    </MemoryRouter>);

    const selectedTab = screen.getByRole("tab", { selected: true });
    const fullName = screen.getByText(longName, { selector: "span" });
    expect(selectedTab).toContainElement(fullName);
    expect(fullName.className.split(" ")).not.toContain("line-clamp-2");
    expect(selectedTab.className).toContain("max-w-[calc(100vw-4.5rem)]");
    expect(selectedTab.closest('[role="tablist"]')?.parentElement?.className).toContain("w-full");
  });

  it.each([
    { mode: "round-robin", connected: true }, { mode: "elimination", connected: true },
    { mode: "round-robin", connected: false }, { mode: "elimination", connected: false },
  ] as const)("shows the approved copy for $mode (connected=$connected) without changing draft state", ({ mode, connected }) => {
    makeDraft(mode);
    const before = useTournamentStore.getState();
    mount(connected);
    const heading = screen.getByText("Categoría en preparación.", { exact: true });
    expect(heading.tagName).toBe("STRONG");
    expect(heading.parentElement).toHaveTextContent("Categoría en preparación. Agregá los competidores para continuar.");
    expect(screen.queryByText(/Borrador de categoría|La categoría anterior sigue guardada/)).toBeNull();
    expect(screen.getByRole("button", { name: "Cancelar creación" })).toBeInTheDocument();
    expect(useTournamentStore.getState().getCategoryEntries().find((entry) => entry.id === before.config.id)?.isDraft).toBe(true);
    expect(useTournamentStore.getState().config).toEqual(before.config);
    expect(useTournamentStore.getState().competitors).toEqual(before.competitors);
    expect(useTournamentStore.getState().fights).toEqual(before.fights);
    const offline = screen.queryByText("Sin conexión: se pueden consultar y preparar categorías, pero no operar el tatami.");
    if (connected) expect(offline).toBeNull();
    else expect(offline).toBeInTheDocument();
  });

  it("does not show a preparation banner when the selected category is not a draft", () => {
    mount();
    expect(screen.queryByText("Categoría en preparación.")).toBeNull();
    expect(screen.queryByText("Agregá los competidores para continuar.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar creación" })).toBeNull();
  });
});
