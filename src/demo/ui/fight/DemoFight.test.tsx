import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoFight } from "../DemoFight";
import { emptyDemoDeskState, reduceDemoDeskState } from "../../runtime";
import type { DeskRuntimeView } from "../../runtime/browser-runtime";
import type { DemoDeskCommand, DemoDeskState } from "../../runtime/types";
import type { CompetitorEntry, FightEntry, TournamentCategorySnapshot, TournamentConfig } from "@/store/tournament";
import baseRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";

const people = Object.fromEntries(["A", "B", "C", "D", "E"].map((id) => [id,
  { id, name: `Competidor ${id}` }])) as Record<string, CompetitorEntry>;
const fight = (id: string, red: string, blue: string, extra: Partial<FightEntry> = {}): FightEntry => ({
  id, red: people[red], blue: people[blue], completed: false, groupId: "G1", ...extra,
});

function fixture(fights: FightEntry[], matchType: "sparring" | "tul" = "sparring",
  mode: "round-robin" | "elimination" = "round-robin"): DemoDeskState {
  const state = emptyDemoDeskState("test-event");
  const config = { id: "cat", eventId: "test-event", tournamentName: "Prueba", categoryName: "Demo",
    tableChief: "Mesa", judgesCount: 4, mode, matchType, ruleSet: null } as TournamentConfig;
  const category: TournamentCategorySnapshot = { phase: "fighting", config, competitors: Object.values(people),
    fights, groups: mode === "round-robin" ? [{ id: "G1", competitors: Object.values(people), size: 5 }] : [],
    currentFightIndex: 0, bracketMatches: [], bracketSeeds: [], setupStarted: true };
  state.categories.cat = category;
  state.categoryOrder = ["cat"];
  state.selectedCategoryId = "cat";
  return state;
}

function mount(initial: DemoDeskState) {
  const calls: { command: DemoDeskCommand; commandId?: string }[] = [];
  function Harness() {
    const [state, setState] = useState(initial);
    const view: DeskRuntimeView = { state, isWriter: true, generation: 1, revision: 1 };
    const dispatch = async (command: DemoDeskCommand, commandId?: string) => {
      calls.push({ command, commandId });
      const next = reduceDemoDeskState(state, command, new Date("2026-10-27T12:00:00Z"));
      setState(next);
      return { ...view, state: next };
    };
    return <DemoFight view={view} dispatch={dispatch} />;
  }
  render(<Harness />);
  return calls;
}

describe("DemoFight browser-only desk", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps red left and blue right while swapping competitors before start", async () => {
    const calls = mount(fixture([fight("AB", "A", "B")]));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("button", { name: "Intercambiar competidores" });
    const station = screen.getByTestId("demo-fight-station");
    expect(station.className).toContain("-mx-3");
    expect(within(station).getByText("Rojo · izquierda").parentElement?.className).toContain("bg-red-950/50");
    expect(within(station).getByText("Azul · derecha").parentElement?.className).toContain("bg-blue-950/50");
    expect(within(station).getAllByText("0")[0].className).toContain("text-[clamp(3.25rem,16vw,5rem)]");
    fireEvent.click(screen.getByRole("button", { name: "Intercambiar competidores" }));
    await waitFor(() => expect(screen.getByText("Rojo · izquierda").parentElement?.textContent).toContain("Competidor B"));
    expect(screen.getByText("Azul · derecha").parentElement?.textContent).toContain("Competidor A");
    fireEvent.click(screen.getByRole("button", { name: "Iniciar combate" }));
    await waitFor(() => expect(calls.map((item) => item.command.type)).toContain("fight/start"));
    expect(screen.getByRole("group", { name: "Juez J1" }).parentElement?.className).toContain("min-[360px]:grid-cols-2");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Intercambiar competidores" })).toBeNull());
    const swap = calls.find((item) => item.command.type === "fight/swap");
    expect(swap?.commandId).toMatch(/^g1:/);
    expect(swap?.command).toMatchObject({ expectedRedId: "A", expectedBlueId: "B" });
  });

  it("keeps complete long competitor names visible on both color stations", async () => {
    const bout = fight("AB", "A", "B");
    bout.red = { ...bout.red, name: "Competidora Nombre y Apellido Muy Extenso" };
    bout.blue = { ...bout.blue, name: "Competidor con Dos Apellidos Muy Extensos" };
    mount(fixture([bout]));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    const red = await screen.findByText(bout.red.name);
    const blue = screen.getByText(bout.blue.name);
    expect(red.className).not.toContain("line-clamp");
    expect(blue.className).not.toContain("line-clamp");
    expect(red.className).toContain("[overflow-wrap:anywhere]");
    expect(blue.className).toContain("[overflow-wrap:anywhere]");
  });

  it("suggests the first resting bout after a confirmed AB fight instead of loading AE", async () => {
    const state = fixture([fight("AB", "A", "B", { completed: true, winner: "red" }),
      fight("AE", "A", "E"), fight("CD", "C", "D")]);
    state.categories.cat.currentFightIndex = 1;
    state.history.push({ id: "history-AB", categoryId: "cat", fightId: "AB", confirmedAt: "2026-10-27T11:00:00Z",
      red: people.A, blue: people.B, winner: "red", reason: "points", flagsRed: 3, flagsBlue: 1,
      warningsRed: 0, warningsBlue: 0, foulsRed: 0, foulsBlue: 0 });
    const calls = mount(state);
    expect(screen.queryByRole("button", { name: "Cargar pelea" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Usar sugerida/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cargar pelea" })).toBeTruthy());
    expect(calls[0].command).toMatchObject({ type: "fight/select", fightId: "CD" });
    expect(calls.some((item) => item.command.type === "fight/load")).toBe(false);
  });

  it("records individual Tul votes and confirms the actual assigned winner", async () => {
    const calls = mount(fixture([fight("AB", "A", "B")], "tul"));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("button", { name: "Iniciar votación de Tul" });
    expect(screen.queryByRole("button", { name: "Intercambiar competidores" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar votación de Tul" }));
    await screen.findByRole("button", { name: "Cerrar votación de Tul" });
    for (const id of ["J1", "J2", "J3", "J4"]) {
      const group = screen.getByRole("group", { name: `Juez ${id}` });
      fireEvent.click(within(group).getByRole("button", { name: "Rojo" }));
      await waitFor(() => expect(calls.filter((item) => item.command.type === "fight/vote" && item.command.judgeId === id)).toHaveLength(1));
    }
    fireEvent.click(screen.getByRole("button", { name: "Cerrar votación de Tul" }));
    await screen.findByRole("button", { name: "Confirmar resultado y cerrar pelea" });
    expect(screen.getByText("Ganó Competidor A")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar resultado y cerrar pelea" }));
    await waitFor(() => expect(calls.some((item) => item.command.type === "fight/confirmResult")).toBe(true));
  });

  it("does not dispatch a second load on a double tap while the first is pending", async () => {
    const dispatch = vi.fn((_command: DemoDeskCommand, _commandId?: string) => new Promise<null>(() => {}));
    render(<DemoFight view={{ state: fixture([fight("AB", "A", "B")]), isWriter: true, generation: 1, revision: 1 }} dispatch={dispatch} />);
    const load = screen.getByRole("button", { name: "Cargar pelea" });
    fireEvent.click(load);
    fireEvent.click(load);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1]).toBeTruthy();
    expect(dispatch.mock.calls[0][1]).toMatch(/^g1:/);
  });

  it("reuses the command ID when a failed load is retried", async () => {
    const dispatch = vi.fn(async (_command: DemoDeskCommand, _commandId?: string) => null);
    render(<DemoFight view={{ state: fixture([fight("AB", "A", "B")]), isWriter: true, generation: 1, revision: 1 }} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls[1][1]).toBe(dispatch.mock.calls[0][1]);
  });

  it("retries a lost swap reply with the same tagged ID and applies the swap only once", async () => {
    const loaded = reduceDemoDeskState(fixture([fight("AB", "A", "B")]),
      { type: "fight/load", categoryId: "cat", fightId: "AB" });
    const calls: string[] = [];
    const seen = new Set<string>();
    let persisted = loaded;
    let reductions = 0;
    function Harness() {
      const [state, setState] = useState(loaded);
      const dispatch = async (command: DemoDeskCommand, id?: string) => {
        if (command.type !== "fight/swap" || !id) return null;
        calls.push(id);
        if (!seen.has(id)) {
          seen.add(id);
          persisted = reduceDemoDeskState(persisted, command);
          reductions++;
        }
        if (calls.length === 1) return null; // commit succeeded but reply was lost
        setState(persisted);
        return { state: persisted, isWriter: true, generation: 1, revision: 2 };
      };
      return <DemoFight view={{ state, isWriter: true, generation: 1, revision: 1 }} dispatch={dispatch} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Intercambiar competidores" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Intercambiar competidores" }));
    await waitFor(() => expect(screen.getByText("Rojo · izquierda").parentElement?.textContent).toContain("Competidor B"));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^g1:/);
    expect(calls[1]).toBe(calls[0]);
    expect(reductions).toBe(1);
  });

  it("keeps an in-flight old-generation ID stale after reset and does not unlock a new pending action", async () => {
    const loaded = reduceDemoDeskState(fixture([fight("AB", "A", "B")]),
      { type: "fight/load", categoryId: "cat", fightId: "AB" });
    const rejectors = new Map<string, (error: Error) => void>();
    const dispatch = vi.fn((_command: DemoDeskCommand, id?: string) => new Promise<unknown>((_resolve, reject) => {
      if (id) rejectors.set(id, reject);
    }));
    const first = { state: loaded, isWriter: true, generation: 1, revision: 1 };
    const { rerender } = render(<DemoFight view={first} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("button", { name: "Intercambiar competidores" }));
    const oldId = dispatch.mock.calls[0][1] ?? "";
    expect(oldId).toMatch(/^g1:/);
    rerender(<DemoFight view={{ ...first, generation: 2, revision: 0 }} dispatch={dispatch} />);
    await screen.findByText(/La demo se reinició o importó/);
    fireEvent.click(screen.getByRole("button", { name: "Intercambiar competidores" }));
    const newId = dispatch.mock.calls[1][1] ?? "";
    expect(newId).toMatch(/^g2:/);
    await act(async () => { rejectors.get(oldId)?.(new Error("Generación anterior")); });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Iniciar combate" }).disabled).toBe(true);
    expect(screen.getByText("Rojo · izquierda").parentElement?.textContent).toContain("Competidor A");
    await act(async () => { rejectors.get(newId)?.(new Error("Operación cancelada")); });
  });

  it("blocks Start while a competitor swap is still being persisted", () => {
    const loaded = reduceDemoDeskState(fixture([fight("AB", "A", "B")]),
      { type: "fight/load", categoryId: "cat", fightId: "AB" });
    const dispatch = vi.fn((_command: DemoDeskCommand, _commandId?: string) => new Promise<null>(() => {}));
    render(<DemoFight view={{ state: loaded, isWriter: true, generation: 1, revision: 1 }} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("button", { name: "Intercambiar competidores" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Iniciar combate" }).disabled).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("supports per-judge Golden Point votes and waits for explicit confirmation", async () => {
    const calls = mount(fixture([fight("GP", "A", "B", { isGoldenPointFight: true })], "sparring", "elimination"));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByText(/Punto de Oro · intento 1/);
    expect(screen.queryByRole("timer")).toBeNull();
    for (const id of ["J1", "J2", "J3"]) {
      const group = screen.getByRole("group", { name: `Juez ${id}` });
      fireEvent.click(within(group).getByRole("button", { name: "Rojo" }));
      await waitFor(() => expect(calls.filter((item) => item.command.type === "fight/goldenVote" && item.command.judgeId === id)).toHaveLength(1));
    }
    expect(screen.queryByText("Ganó Competidor A")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar intento" }));
    await screen.findByText("Ganó Competidor A");
  });

  it("records points and arbiter sanctions before confirming the result", async () => {
    const state = fixture([fight("AB", "A", "B")]);
    state.categories.cat.config.ruleSet = { ...(baseRules as RuleSetSparring), judgingMode: "points" };
    const calls = mount(state);
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("button", { name: "Iniciar combate" });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar combate" }));
    await screen.findByText("Puntos por juez");
    fireEvent.click(screen.getAllByRole("button", { name: /hand body · \+1/ })[0]);
    await waitFor(() => expect(calls.some((item) => item.command.type === "fight/event" && item.command.judgeId === "J1")).toBe(true));
    fireEvent.click(screen.getByText("Sanciones y decisiones especiales"));
    fireEvent.click(screen.getAllByRole("button", { name: "+ Advertencia" })[0]);
    await waitFor(() => expect(calls.some((item) => item.command.type === "fight/event" && item.command.judgeId === "arbiter")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Finalizar round" }));
    await screen.findByRole("button", { name: "Confirmar puntos y sanciones" });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar puntos y sanciones" }));
    await screen.findByText("Ganó Competidor A");
  });

  it("requires explicit confirmation to reset time and votes, then allows restarting with a new loadId", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = mount(fixture([fight("AB", "A", "B")]));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("button", { name: "Iniciar combate" });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar combate" }));
    await screen.findByText("Banderas del round 1");
    fireEvent.click(within(screen.getByRole("group", { name: "Juez J1" })).getByRole("button", { name: "Rojo" }));
    await waitFor(() => expect(calls.some((item) => item.command.type === "fight/vote")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar combate" }));
    await screen.findByRole("button", { name: "Iniciar combate" });
    expect(screen.getByRole("timer").textContent).toBe("01:00");
    expect(screen.queryByText("Banderas del round 1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Intercambiar competidores" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar combate" }));
    await waitFor(() => expect(calls.filter((item) => item.command.type === "fight/start")).toHaveLength(2));
    const starts = calls.map((item) => item.command).filter((command): command is Extract<DemoDeskCommand, { type: "fight/start" }> => command.type === "fight/start");
    expect(starts[0].loadId).not.toBe(starts[1].loadId);
  });

  it("does not mutate a fight when reset confirmation is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const calls = mount(fixture([fight("AB", "A", "B")]));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("button", { name: "Iniciar combate" });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar combate" }));
    await screen.findByRole("button", { name: "Reiniciar combate" });
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar combate" }));
    expect(calls.some((item) => item.command.type === "fight/reset")).toBe(false);
    expect(screen.getByText(/Round 1 de 1 · en curso/)).toBeTruthy();
  });

  it("offers medical pause only while the round clock is running", async () => {
    const calls = mount(fixture([fight("AB", "A", "B")]));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    await screen.findByRole("button", { name: "Iniciar combate" });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar combate" }));
    const medical = await screen.findByRole<HTMLButtonElement>("button", { name: "Pausa médica · detener reloj" });
    fireEvent.click(medical);
    await waitFor(() => expect(calls.some((item) => item.command.type === "fight/medical")).toBe(true));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Reanudar" }).disabled).toBe(false));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Pausa médica · detener reloj" }).disabled).toBe(true);
  });

  it("can skip an untouched sparring round directly to flag registration", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = mount(fixture([fight("AB", "A", "B")]));
    fireEvent.click(screen.getByRole("button", { name: "Cargar pelea" }));
    const skip = await screen.findByRole("button", { name: "Registrar banderas sin cronómetro" });
    fireEvent.click(skip);
    await screen.findByText("Round 1 finalizado");
    expect(screen.getByRole("button", { name: "Confirmar banderas del round" })).toBeTruthy();
    expect(calls.some((item) => item.command.type === "fight/skipToFlags")).toBe(true);
  });
});
