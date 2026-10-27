import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatch } from "@/engine/match-machine";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import { FightPage, JefeMesaPanel } from "@/pages/FightPage";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn(), emit: vi.fn(), request: vi.fn(), navigate: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));

const initial = useTournamentStore.getState();
const rules = baseline as RuleSetSparring;
const fights = [
  { id: "mobile-one", red: { id: "r1", name: "BRIAN LARGUÍSIMO", team: "A" },
    blue: { id: "b1", name: "JUAN PEDRO", team: "B" }, groupId: "G1", completed: false },
  { id: "mobile-two", red: { id: "r2", name: "Ana", team: "A" },
    blue: { id: "b2", name: "Berta", team: "B" }, groupId: "G1", completed: false },
];

function serverState(): ServerState {
  return {
    rules,
    categoryId: "mobile-category",
    match: { id: fights[0].id, ringId: "T1", matchMode: "sparring",
      red: { ...fights[0].red }, blue: { ...fights[0].blue },
      preFight: { loadId: "mobile-load", revision: 0, started: false, timingKind: "regular" } },
    matchState: createMatch(rules), matchPaused: false, resultConfirmed: false,
    judges: ["J1", "J2", "J3", "J4"], judgeVotes: {}, judgeTotals: {}, roundFlags: [],
    penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
    fallos: [], serverUrl: "",
  };
}

beforeEach(() => {
  mocks.emit.mockReset();
  mocks.request.mockReset().mockResolvedValue({ ok: true, result: null });
  mocks.useSocket.mockReturnValue({ connected: true, stateReady: true, state: serverState(),
    emit: mocks.emit, request: mocks.request,
    socket: { on: vi.fn(), off: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => [] })));
  Element.prototype.scrollIntoView = vi.fn();
  act(() => useTournamentStore.setState({ ...initial,
    config: { ...initial.config, id: "mobile-category", matchType: "sparring",
      mode: "round-robin", ruleSet: rules, judgesCount: 4 },
    fights, currentFightIndex: 0, phase: "fighting",
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  act(() => useTournamentStore.setState(initial));
});

describe("panel de combate móvil", () => {
  it("separa navegación de nombres, ofrece acciones secundarias sin ejecutarlas y mantiene un solo scroll", () => {
    render(<FightPage />);
    const toolbar = screen.getByTestId("mobile-fight-toolbar");
    expect(toolbar).toHaveTextContent("Combate 1 de 2");
    expect(toolbar).not.toHaveTextContent("BRIAN");
    expect(within(toolbar).getByRole("button", { name: "Combate anterior" })).toHaveClass("size-11");
    expect(within(toolbar).getByRole("button", { name: "Combate siguiente" })).toHaveClass("size-11");
    expect(screen.getByTestId("red-station-mobile")).toHaveTextContent("BRIAN LARGUÍSIMO");
    expect(screen.getByTestId("blue-station-mobile")).toHaveTextContent("JUAN PEDRO");
    expect(screen.getByTestId("fight-content-scroll")).toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("fight-arena")).not.toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("fight-vote-panel")).not.toHaveClass("overflow-y-auto");
    expect(screen.getByTestId("fight-progress-mobile-one")).toHaveClass("size-11");

    const more = within(toolbar).getByRole("button", { name: "Más" });
    fireEvent.click(more);
    const dialog = screen.getByTestId("mobile-fight-actions");
    expect(dialog).toHaveClass("[&>button:last-child]:size-11");
    expect(dialog).toHaveTextContent("Agregar pelea huésped");
    expect(dialog).toHaveTextContent("Postergar pelea");
    expect(dialog).toHaveTextContent("Reiniciar combate");
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("muestra un juez por fila con votos de 44 px, estado y semántica accesible", () => {
    const emit = vi.fn();
    render(<JefeMesaPanel judgesCount={4} judgeVotes={{ J1: "red" }} roundFlags={[]}
      phase="rest" pendingJuryDecision={false} onEmit={emit} mode="porjuez" />);
    const rows = screen.getAllByRole("group", { name: /Voto J[1-4]/ });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveClass("grid-cols-[2rem_minmax(0,1fr)]");
    expect(within(rows[0]).getByRole("button", { name: /Rojo/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(rows[1]).getByRole("button", { name: /Azul/ })).toHaveClass("min-h-11");
    fireEvent.click(within(rows[1]).getByRole("button", { name: /Azul/ }));
    expect(emit).toHaveBeenCalledWith("mesa:flagVote", { judgeId: "J2", vote: "blue" });
  });

  it("prioriza Iniciar y deja los ajustes precombate cerrados pero editables", () => {
    render(<FightPage />);
    const controls = screen.getByTestId("mobile-fight-controls");
    const start = within(controls).getByRole("button", { name: "Iniciar combate" });
    const details = within(controls).getByTestId("mobile-timing-details");
    expect(start.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("Ajustes de este combate");
    fireEvent.click(within(details).getByText(/Ajustes de este combate ·/));
    expect(details).toHaveAttribute("open");
    fireEvent.click(within(details).getByRole("button", { name: "2 min" }));
    expect(start).toBeDisabled();
    expect(details).toHaveTextContent("Revisar antes de iniciar");
    expect(mocks.emit).not.toHaveBeenCalledWith("match:start", expect.anything());
  });

  it("transfiere el foco de Más a Huésped, lo mantiene en diálogo y lo restaura al cerrar", async () => {
    render(<FightPage />);
    const more = within(screen.getByTestId("mobile-fight-toolbar")).getByRole("button", { name: "Más" });
    fireEvent.click(more);
    fireEvent.click(within(screen.getByTestId("mobile-fight-actions"))
      .getByRole("button", { name: "🏁 Agregar pelea huésped" }));
    const guest = await screen.findByTestId("guest-fight-dialog");
    expect(guest).toHaveAttribute("role", "dialog");
    expect(guest).toHaveClass("[&>button:last-child]:size-11");
    const redInput = within(guest).getByLabelText("Rojo");
    await waitFor(() => expect(redInput).toHaveFocus());
    expect(guest.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(guest).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(more).toHaveFocus());
    expect(screen.queryByTestId("guest-fight-dialog")).toBeNull();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
