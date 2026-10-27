import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/layouts/AppLayout";
import { BracketPage } from "@/pages/BracketPage";
import { StandingsPage } from "@/pages/StandingsPage";
import type { ServerState } from "@/lib/socket-types";
import { type TournamentMode, useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn(), emit: vi.fn(), request: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("@/components/CategoryTabs", () => ({ CategoryTabs: () => <div>Categorías locales</div> }));
vi.mock("@/lib/tour", () => ({ startGlobalTour: vi.fn(), continueTourIfPending: vi.fn() }));
vi.mock("canvas-confetti", () => ({ default: vi.fn() }));
const initialStore = useTournamentStore.getState();
const otherCategoryState: ServerState = { rules: null, categoryId: "operating-other-category",
  match: { id: "operating-fight", ringId: "TEST", category: "Otra categoría operativa",
    red: { id: "r", name: "Rojo operativo" }, blue: { id: "b", name: "Azul operativo" } },
  resultConfirmed: false, matchState: null, matchPaused: true, judges: [], judgeVotes: {}, judgeTotals: {},
  penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
  fallos: [], roundFlags: [], serverUrl: "" };

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
function selectCategory(mode: TournamentMode, phase: "setup" | "fighting" = "fighting"): void {
  act(() => useTournamentStore.setState({ config: { ...initialStore.config, id: `viewed-${mode}`, mode,
    categoryName: `Categoría ${mode}` }, phase, fights: [], groups: [], competitors: [],
    bracketMatches: [], bracketSeeds: [] }));
}
function mountLayout(route: string) {
  return render(<MemoryRouter initialEntries={[route]}>
    <AppLayout><div data-testid="requested-panel">Panel solicitado</div></AppLayout>
    <LocationProbe />
  </MemoryRouter>);
}
function assertFormatLinks(mode: TournamentMode): void {
  const menus = screen.getAllByRole("navigation");
  expect(menus).toHaveLength(2);
  for (const menu of menus) {
    const destinations = within(menu).getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(destinations).toContain(mode === "elimination" ? "/bracket" : "/standings");
    expect(destinations).not.toContain(mode === "elimination" ? "/standings" : "/bracket");
    for (const unchanged of ["/", "/settings", "/fight", "/results", "/history"]) expect(destinations).toContain(unchanged);
  }
}
beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "3.0.0");
  mocks.useSocket.mockReturnValue({ connected: true, stateReady: true, state: otherCategoryState,
    emit: mocks.emit, request: mocks.request, socket: null });
});
afterEach(() => {
  cleanup(); act(() => useTournamentStore.setState(initialStore));
  vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe("navegación del formato de la categoría consultada", () => {
  it("keeps the mobile shell readable and its navigation clear of phone safe areas", () => {
    selectCategory("round-robin");
    act(() => useTournamentStore.setState((state) => ({
      config: { ...state.config, categoryName: "Pesado A · Blancos y Puntas Amarillas · Femenino · 6–7 años" },
    })));
    mountLayout("/settings");

    const mobileHeader = screen.getByRole("banner");
    const categoryName = within(mobileHeader).getByText(/Pesado A/);
    expect(categoryName).toHaveAttribute("title", "Pesado A · Blancos y Puntas Amarillas · Femenino · 6–7 años");
    expect(categoryName.className).toContain("line-clamp-2");
    expect(within(mobileHeader).getByRole("button", { name: "Cómo funciona" }).className).toContain("size-11");
    expect(mobileHeader.parentElement?.parentElement).toHaveStyle({ height: "100dvh" });

    const mobileNav = screen.getByRole("navigation", { name: "Navegación principal" });
    expect(mobileNav.className).toContain("safe-area-inset-bottom");
    const competitorLink = within(mobileNav).getByRole("link", { name: "Competidores" });
    expect(competitorLink.className).toContain("min-h-14");
  });

  it("does not repeat the selected category above the combat panel on mobile", () => {
    selectCategory("round-robin");
    act(() => useTournamentStore.setState((state) => ({
      config: { ...state.config, categoryName: "Pesado A · Femenino · 6–7 años" },
    })));
    mountLayout("/fight");
    expect(within(screen.getByRole("banner")).queryByText(/Pesado A/)).toBeNull();
  });

  it.each(["round-robin", "groups", "elimination"] as const)("adapts desktop/mobile menus to %s, not the operating category", (mode) => {
    selectCategory(mode); mountLayout("/settings");
    assertFormatLinks(mode);
    expect(screen.getByTestId("requested-panel")).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("updates both menus and safely replaces an incompatible panel when changing selected categories", () => {
    selectCategory("round-robin"); mountLayout("/standings");
    assertFormatLinks("round-robin");
    expect(screen.getByTestId("requested-panel")).toBeInTheDocument();
    selectCategory("elimination");
    assertFormatLinks("elimination");
    expect(screen.queryByTestId("requested-panel")).toBeNull();
    expect(screen.getByRole("link", { name: "Ver bracket" })).toHaveAttribute("href", "/bracket");
    // No automatic navigation while the selected snapshot/config is being restored.
    expect(screen.getByTestId("location")).toHaveTextContent("/standings");
    selectCategory("round-robin");
    expect(screen.getByTestId("requested-panel")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/standings");
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "round-robin", route: "/bracket", target: "/standings", label: "Ver clasificación" },
    { mode: "elimination", route: "/standings", target: "/bracket", label: "Ver bracket" },
  ] as const)("offers a local $label CTA for an incompatible direct URL", ({ mode, route, target, label }) => {
    selectCategory(mode); mountLayout(route);
    expect(screen.queryByTestId("requested-panel")).toBeNull();
    const link = screen.getByRole("link", { name: label });
    expect(link).toHaveAttribute("href", target);
    expect(screen.getByTestId("location")).toHaveTextContent(route);
    fireEvent.click(link);
    expect(screen.getByTestId("location")).toHaveTextContent(target);
    expect(screen.getByTestId("requested-panel")).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });

  it.each(["round-robin", "elimination"] as const)("returns to preparation rather than a disabled %s view during setup", (mode) => {
    selectCategory(mode, "setup"); mountLayout(mode === "elimination" ? "/standings" : "/bracket");
    const link = screen.getByRole("link", { name: "Ir a Competidores" });
    expect(link).toHaveAttribute("href", "/");
    fireEvent.click(link);
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keeps external/public display links unchanged", () => {
    selectCategory("round-robin"); mountLayout("/results");
    fireEvent.click(screen.getByRole("button", { name: "Pantallas externas" }));
    expect(screen.getByRole("link", { name: /Pantalla TV/ })).toHaveAttribute("href", "/tv");
    expect(screen.getByRole("link", { name: /Mesa Central/ })).toHaveAttribute("href", "/central");
    expect(screen.getByTestId("requested-panel")).toBeInTheDocument();
  });

  it.each(["round-robin", "elimination"] as const)("also offers a safe CTA from the standalone incompatible %s page guard", (mode) => {
    selectCategory(mode);
    render(<MemoryRouter>{mode === "elimination" ? <StandingsPage /> : <BracketPage />}</MemoryRouter>);
    expect(screen.getByRole("link", { name: mode === "elimination" ? "Ver bracket" : "Ver clasificación" }))
      .toHaveAttribute("href", mode === "elimination" ? "/bracket" : "/standings");
    expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });
});
