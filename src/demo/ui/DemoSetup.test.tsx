import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { generateDoubleBracket } from "@/lib/bracket";
import { emptyDemoDeskState, reduceDemoDeskState } from "../runtime/reducer";
import type { DemoDeskCommand, DemoDeskState } from "../runtime/types";
import { DemoSetup, purgeDemoPendingDrafts, type DemoCategoryNavigationRequest } from "./DemoSetup";

function startState(): DemoDeskState {
  return reduceDemoDeskState(emptyDemoDeskState("event-demo"), { type: "category/create", categoryId: "cat-1" });
}

function Harness({ initial = startState(), generation = 1, onChange }: {
  initial?: DemoDeskState; generation?: number; onChange?: (state: DemoDeskState) => void;
}) {
  const [state, setState] = useState(initial);
  const dispatch = async (command: DemoDeskCommand) => {
    setState((previous) => { const next = reduceDemoDeskState(previous, command); onChange?.(next); return next; });
    return true;
  };
  const navigation = useRef<((request: DemoCategoryNavigationRequest) => Promise<boolean>) | null>(null);
  const registerCategoryNavigation = useCallback((handler: typeof navigation.current) => { navigation.current = handler; }, []);
  return <><TestCategoryNavigation state={state} navigate={(request) => void navigation.current?.(request)} />
    <DemoSetup state={state} generation={generation} readOnly={false} dispatch={dispatch} onFight={() => {}}
      registerCategoryNavigation={registerCategoryNavigation} /></>;
}

function SlowHarness({ initial, onChange }: { initial: DemoDeskState; onChange: (state: DemoDeskState) => void }) {
  const [state, setState] = useState(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const dispatch = (command: DemoDeskCommand): Promise<boolean> => {
    const next = queue.current.then(() => new Promise((resolve) => setTimeout(resolve, 60))).then(() => {
      setState((previous) => { const updated = reduceDemoDeskState(previous, command); onChange(updated); return updated; });
      return true;
    });
    queue.current = next;
    return next;
  };
  const navigation = useRef<((request: DemoCategoryNavigationRequest) => Promise<boolean>) | null>(null);
  const registerCategoryNavigation = useCallback((handler: typeof navigation.current) => { navigation.current = handler; }, []);
  return <><TestCategoryNavigation state={state} navigate={(request) => void navigation.current?.(request)} />
    <DemoSetup state={state} generation={1} readOnly={false} dispatch={dispatch} onFight={() => {}}
      registerCategoryNavigation={registerCategoryNavigation} /></>;
}

function TestCategoryNavigation({ state, navigate }: {
  state: DemoDeskState; navigate: (request: DemoCategoryNavigationRequest) => void;
}) {
  return <div>
    <select aria-label="Categoría actual" value={state.selectedCategoryId ?? ""}
      onChange={(event) => navigate({ kind: "select", categoryId: event.target.value })}>
      {state.categoryOrder.map((id) => <option key={id} value={id}>{id}</option>)}
    </select>
    <button type="button" onClick={() => navigate({ kind: "create" })}>+ Nueva categoría</button>
  </div>;
}

function DelayedRemovalHarness({ initial, onChange, firstRemovalGate, onCommand }: {
  initial: DemoDeskState;
  onChange: (state: DemoDeskState) => void;
  firstRemovalGate?: Promise<void>;
  onCommand?: (command: DemoDeskCommand) => void;
}) {
  const [state, setState] = useState(initial);
  const navigation = useRef<((request: DemoCategoryNavigationRequest) => Promise<boolean>) | null>(null);
  const registerCategoryNavigation = useCallback((handler: typeof navigation.current) => { navigation.current = handler; }, []);
  const firstRemoval = useRef(true);
  const dispatch = async (command: DemoDeskCommand) => {
    onCommand?.(command);
    const pauseAfterThisRemoval = command.type === "category/removeCompetitor" && firstRemoval.current;
    if (pauseAfterThisRemoval) firstRemoval.current = false;
    setState((previous) => {
      const next = reduceDemoDeskState(previous, command);
      onChange(next);
      return next;
    });
    if (pauseAfterThisRemoval)
      await (firstRemovalGate ?? new Promise((resolve) => setTimeout(resolve, 80)));
    return true;
  };
  return <><TestCategoryNavigation state={state} navigate={(request) => void navigation.current?.(request)} />
    <DemoSetup state={state} generation={1} readOnly={false} dispatch={dispatch} onFight={() => {}}
      registerCategoryNavigation={registerCategoryNavigation} /></>;
}

function twoDrafts(): DemoDeskState {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
    competitorId: "ana", competitor: { name: "Ana" } });
  state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
    competitorId: "beto", competitor: { name: "Beto" } });
  state = reduceDemoDeskState(state, { type: "category/create", categoryId: "cat-2" });
  return reduceDemoDeskState(state, { type: "category/select", categoryId: "cat-1" });
}

it("guides a new category one decision at a time and keeps optional answers optional", async () => {
  let latest = startState();
  render(<Harness initial={latest} onChange={(next) => { latest = next; }} />);
  expect(screen.getByRole("heading", { name: /Paso 1 de 6: Edad/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "No especificar" }));
  await screen.findByRole("heading", { name: /Sistema de grado/ });
  fireEvent.click(screen.getByRole("button", { name: "GUPS" }));
  await screen.findByRole("heading", { name: /Rango de grado/ });
  fireEvent.click(screen.getByRole("button", { name: "Amarillos a Puntas Azules" }));
  await screen.findByRole("heading", { name: /Género/ });
  fireEvent.click(screen.getByRole("button", { name: "No especificar" }));
  await screen.findByRole("heading", { name: /Disciplina/ });
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  await screen.findByRole("heading", { name: /Formato/ });
  fireEvent.click(screen.getByRole("button", { name: "Eliminación" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Continuar con competidores/ })).toBeVisible());
  expect(latest.categories["cat-1"].config.matchType).toBe("tul");
  expect(latest.categories["cat-1"].config.weightLabel).toBeUndefined();
  expect(latest.categories["cat-1"].config.ageDivision).toBeUndefined();
  expect(latest.categories["cat-1"].config.sexDivision).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: /Continuar con competidores/ }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Nombre del competidor" })).toHaveFocus());
  expect(latest.categories["cat-1"].phase).toBe("setup");
});

it("uses large grouped choices and compact editable summaries like the original editor", async () => {
  const visualState = reduceDemoDeskState(emptyDemoDeskState("event-visual"), { type: "category/create", categoryId: "cat-visual" });
  render(<Harness initial={visualState} />);
  const age = screen.getByRole("button", { name: /KIDS/ });
  expect(age).toHaveAttribute("aria-pressed", "false");
  expect(age).toHaveClass("min-h-11");
  expect(age.parentElement).toHaveClass("flex-wrap");
  expect(screen.getByRole("group", { name: "Combate y tiempos" })).toHaveTextContent("Tiempo y perfil activos");
  age.focus();
  expect(age).toHaveFocus();
  fireEvent.click(age);
  const summary = await screen.findByRole("button", { name: /Editar Edad/ });
  expect(summary).toHaveClass("min-h-16");
  expect(summary.parentElement).toHaveClass("grid");
  expect(screen.getByRole("heading", { name: /Sistema de grado/ })).toBeVisible();
});

it("preserves fixed red/blue fixture preview and adds competitors without starting", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: { categoryName: "Prueba", nameGenerated: false } });
  const dispatchSpy = vi.fn();
  render(<Harness initial={state} onChange={dispatchSpy} />);
  const name = screen.getByRole("textbox", { name: "Nombre del competidor" });
  for (const person of ["Ana", "Beto", "Carla"]) {
    fireEvent.change(name, { target: { value: person } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
    await waitFor(() => expect(name).toHaveValue(""));
  }
  await waitFor(() => expect(screen.getByRole("heading", { name: /Fixture.*3 combates/ })).toBeVisible());
  expect(screen.getAllByText("vs")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Iniciar categoría" })).toBeEnabled();
  expect(dispatchSpy).toHaveBeenCalled();
});

it.each(["started", "with a confirmed result"])(
  "opens a fresh category from a %s category without changing its fights or history", async (phase) => {
    let state = startState();
    state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
      categoryName: "Formas de prueba", nameGenerated: false, matchType: "tul", mode: "elimination",
    } });
    for (const [id, name] of [["ana", "Ana"], ["beto", "Beto"]]) {
      state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
        competitorId: id, competitor: { name } });
    }
    state = reduceDemoDeskState(state, { type: "category/start", categoryId: "cat-1" });
    if (phase === "with a confirmed result") {
      const fight = state.categories["cat-1"].fights[0];
      fight.completed = true;
      fight.winner = "red";
      state.history.push({ id: "confirmed-1", categoryId: "cat-1", fightId: fight.id,
        confirmedAt: "2026-10-27T12:00:00.000Z", red: fight.red, blue: fight.blue,
        winner: "red", reason: "points", flagsRed: 2, flagsBlue: 0,
        warningsRed: 0, warningsBlue: 0, foulsRed: 0, foulsBlue: 0 });
    }
    const original = structuredClone(state.categories["cat-1"]);
    const originalHistory = structuredClone(state.history);
    let latest = state;
    render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Nueva categoría" }));
    await waitFor(() => expect(latest.categoryOrder).toHaveLength(2));
    expect(latest.selectedCategoryId).not.toBe("cat-1");
    const newId = latest.selectedCategoryId ?? "";
    expect(latest.categories[latest.selectedCategoryId ?? ""]?.phase).toBe("setup");
    expect(await screen.findByRole("heading", { name: /Paso 1 de 6: Edad/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cerrar configuración" })).toHaveAttribute("aria-expanded", "true");
    expect(latest.categories["cat-1"]).toEqual(original);
    expect(latest.history).toEqual(originalHistory);
    fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-1" } });
    await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-1"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Configurar categoría/ })).toHaveAttribute("aria-expanded", "false"));
    fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: newId } });
    await waitFor(() => expect(latest.selectedCategoryId).toBe(newId));
    expect(await screen.findByRole("heading", { name: /Paso 1 de 6: Edad/ })).toBeVisible();
  },
);

it("keeps the next competitor typed during a slow save and prevents a duplicate submit", async () => {
  let latest = startState();
  render(<SlowHarness initial={latest} onChange={(next) => { latest = next; }} />);
  const input = screen.getByRole("textbox", { name: "Nombre del competidor" });
  fireEvent.change(input, { target: { value: "Ana" } });
  fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
  fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
  fireEvent.change(input, { target: { value: "Beto" } });
  await waitFor(() => expect(latest.categories["cat-1"].competitors.map((item) => item.name)).toEqual(["Ana"]));
  expect(input).toHaveValue("Beto");
  await waitFor(() => expect(screen.getByRole("button", { name: "Agregar" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
  await waitFor(() => expect(latest.categories["cat-1"].competitors.map((item) => item.name)).toEqual(["Ana", "Beto"]));
  await waitFor(() => expect(input).toHaveValue(""));
});

it("scopes edit and add drafts to their category when selecting another tab", async () => {
  let latest = twoDrafts();
  render(<Harness initial={latest} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: "Editar a Ana" }));
  expect(screen.getByRole("textbox", { name: "Nombre del competidor" })).toHaveValue("Ana");
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-2" } });
  await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-2"));
  const input = screen.getByRole("textbox", { name: "Nombre del competidor" });
  expect(input).toHaveValue("");
  expect(screen.getByRole("button", { name: "Agregar" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Cancelar edición" })).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "Nueva de B" } });
  fireEvent.click(screen.getByRole("button", { name: "Agregar" }));
  await waitFor(() => expect(latest.categories["cat-2"].competitors.map((person) => person.name)).toEqual(["Nueva de B"]));
  expect(latest.categories["cat-1"].competitors.map((person) => person.name)).toEqual(["Ana", "Beto"]);
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-1" } });
  await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-1"));
  expect(screen.getByRole("textbox", { name: "Nombre del competidor" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Agregar" })).toBeDisabled();
});

it("does not carry a plain add draft into a newly created category", async () => {
  let latest = startState();
  render(<Harness initial={latest} onChange={(next) => { latest = next; }} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre del competidor" }),
    { target: { value: "Sólo para A" } });
  fireEvent.click(screen.getByRole("button", { name: "+ Nueva categoría" }));
  await waitFor(() => expect(latest.categoryOrder).toHaveLength(2));
  expect(screen.getByRole("textbox", { name: "Nombre del competidor" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Agregar" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-1" } });
  await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-1"));
  expect(screen.getByRole("textbox", { name: "Nombre del competidor" })).toHaveValue("");
  expect(latest.categories["cat-1"].competitors).toHaveLength(0);
});

it("keeps list clearing in its original category and resumes tab navigation afterward", async () => {
  let latest = twoDrafts();
  render(<DelayedRemovalHarness initial={latest} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: "Vaciar lista" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar vaciado" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-2" } });
  expect(latest.selectedCategoryId).toBe("cat-1");
  await waitFor(() => expect(latest.categories["cat-1"].competitors).toHaveLength(0));
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-2" } });
  await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-2"));
  const input = screen.getByRole("textbox", { name: "Nombre del competidor" });
  fireEvent.change(input, { target: { value: "B después del vaciado de A" } });
  expect(input).toHaveValue("B después del vaciado de A");
  expect(latest.categories["cat-2"].competitors).toHaveLength(0);
});

it("blocks starting and category navigation until a six-person list is fully cleared", async () => {
  let state = reduceDemoDeskState(startState(), { type: "category/configure", categoryId: "cat-1",
    patch: { categoryName: "Round Robin", nameGenerated: false, mode: "round-robin" } });
  for (let index = 1; index <= 6; index++) {
    state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
      competitorId: `person-${index}`, competitor: { name: `Competidor ${index}` } });
  }
  state = reduceDemoDeskState(state, { type: "category/create", categoryId: "cat-2" });
  state = reduceDemoDeskState(state, { type: "category/select", categoryId: "cat-1" });
  let latest = state;
  let releaseFirstRemoval: () => void = () => {};
  const firstRemovalGate = new Promise<void>((resolve) => { releaseFirstRemoval = resolve; });
  const commands: DemoDeskCommand[] = [];
  render(<DelayedRemovalHarness initial={state} firstRemovalGate={firstRemovalGate}
    onChange={(next) => { latest = next; }} onCommand={(command) => commands.push(command)} />);
  expect(screen.getByRole("button", { name: "Iniciar categoría" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Vaciar lista" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar vaciado" }));
  await waitFor(() => expect(latest.categories["cat-1"].competitors).toHaveLength(5));
  expect(screen.getByRole("button", { name: "Iniciar categoría" })).toBeDisabled();
  expect(screen.getByText(/Vaciando lista/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Iniciar categoría" }));
  fireEvent.click(screen.getByRole("button", { name: "+ Nueva categoría" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-2" } });
  expect(commands.filter((command) => command.type === "category/start"
    || command.type === "category/create" || command.type === "category/select")).toHaveLength(0);
  expect(latest.selectedCategoryId).toBe("cat-1");
  await act(async () => { releaseFirstRemoval(); });
  await waitFor(() => expect(latest.categories["cat-1"].competitors).toHaveLength(0));
  expect(latest.categories["cat-1"].phase).toBe("setup");
  expect(commands.some((command) => command.type === "category/start")).toBe(false);
  expect(screen.getByRole("button", { name: "Iniciar categoría" })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-2" } });
  await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-2"));
});

it("puts import and a confirmed list-clear action in the Lista header", async () => {
  let state = startState();
  for (const [id, name] of [["ana", "Ana"], ["beto", "Beto"]]) {
    state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
      competitorId: id, competitor: { name } });
  }
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  const list = screen.getByRole("region", { name: "Competidores" });
  expect(within(list).getByRole("heading", { name: /Lista/ })).toBeVisible();
  expect(within(list).getByRole("button", { name: "Importar Excel" })).toBeVisible();
  fireEvent.click(within(list).getByRole("button", { name: "Vaciar lista" }));
  const dialog = screen.getByRole("dialog", { name: "Vaciar lista de competidores" });
  expect(latest.categories["cat-1"].competitors).toHaveLength(2);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
  expect(latest.categories["cat-1"].competitors).toHaveLength(2);
  fireEvent.click(within(list).getByRole("button", { name: "Vaciar lista" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmar vaciado" }));
  await waitFor(() => expect(latest.categories["cat-1"].competitors).toHaveLength(0));
});

it("keeps a manual category name while Tul removes active weight and warns about the old label", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Liviano A · prueba", nameGenerated: false, weightLabel: "Liviano A",
  } });
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByRole("button", { name: /Editar Disciplina/ }));
  fireEvent.click(screen.getByRole("button", { name: "Tul / Formas" }));
  await waitFor(() => expect(latest.categories["cat-1"].config.weightLabel).toBeUndefined());
  expect(latest.categories["cat-1"].config.categoryName).toBe("Liviano A · prueba");
  expect(screen.getByRole("status")).toHaveTextContent("El nombre manual menciona un peso");
});

it.each([
  ["Junior - Peso Liviano A - Femenino", "Junior · Femenino"],
  ["Formas Pre-Junior · PESO 35 KG · Femenino", "Formas Pre-Junior · Femenino"],
  ["Adultos · Liviano A", "Adultos"],
])("offers explicit weight-name cleanup for imported Tul title %s", async (title, expected) => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: title, nameGenerated: false, matchType: "tul", weightLabel: undefined,
  } });
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Tul no utiliza peso");
  fireEvent.click(screen.getByRole("button", { name: "Quitar peso del nombre" }));
  await waitFor(() => expect(latest.categories["cat-1"].config.categoryName).toBe(expected));
  expect(latest.categories["cat-1"].config.nameGenerated).toBe(false);
  expect(latest.categories["cat-1"].config.weightLabel).toBeUndefined();
});

it("shows the same two-grid elimination preview that starting 17 competitors will save", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Eliminación grande", nameGenerated: false, mode: "elimination",
  } });
  for (let index = 1; index <= 17; index++) {
    state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
      competitor: { name: `Competidor ${index}` } });
  }
  const fixture = generateDoubleBracket(state.categories["cat-1"].competitors);
  const visibleMatches = fixture.matches.filter((match) => match.round > 0
    || Boolean(match.red.competitor && match.blue.competitor));
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  expect(screen.getByRole("heading", { name: new RegExp(`Llave.*${visibleMatches.length} combates`) })).toBeVisible();
  expect(screen.getAllByText(/Grilla A · Ronda/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Grilla B · Ronda/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Iniciar categoría" }));
  await waitFor(() => expect(latest.categories["cat-1"].phase).toBe("fighting"));
  expect(latest.categories["cat-1"].bracketMatches).toHaveLength(fixture.matches.length);
  expect(new Set(latest.categories["cat-1"].bracketMatches.map((match) => match.bracketGroup)))
    .toEqual(new Set(["A", "B"]));
});

it("applies a local time preset's age while retaining round-robin final timing", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Prueba", nameGenerated: false, finalSeconds: 99, tiebreakerSeconds: 35,
  } });
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByText("Ajustes avanzados: tiempos y perfil"));
  fireEvent.click(screen.getByRole("button", { name: "Kids (4-5)" }));
  await waitFor(() => expect(latest.categories["cat-1"].config.categoryAgeFrom).toBe("4"));
  expect(latest.categories["cat-1"].config.categoryAgeTo).toBe("5");
  expect(latest.categories["cat-1"].config.ruleSet?.mode).toBe("sparring");
  expect(latest.categories["cat-1"].config.finalSeconds).toBe(99);
  expect(latest.categories["cat-1"].config.tiebreakerSeconds).toBe(35);
});

it("configures judges and final timing without exposing inactive legacy tiebreak knobs", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Prueba", nameGenerated: false, maxTiebreakers: 3,
  } });
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByText("Ajustes avanzados: tiempos y perfil"));
  const chooseAdvanced = (group: string, option: string) =>
    fireEvent.click(within(screen.getByRole("group", { name: group })).getByRole("button", { name: option }));

  chooseAdvanced("Jueces", "3");
  await waitFor(() => expect(latest.categories["cat-1"].config.ruleSet?.judgesCount).toBe(3));
  chooseAdvanced("Jueces", "5");
  await waitFor(() => expect(latest.categories["cat-1"].config.judgesCount).toBe(5));
  chooseAdvanced("Rounds en la final", "2 rounds");
  chooseAdvanced("Duración del round final", "2 min");
  fireEvent.change(screen.getByRole("spinbutton", { name: "Segundos de desempate" }),
    { target: { value: "45" } });
  await waitFor(() => expect(latest.categories["cat-1"].config.tiebreakerSeconds).toBe(45));
  expect(screen.getByText("Si persiste el empate tras un desempate cronometrado, sigue Punto de Oro sin reloj.")).toBeVisible();
  expect(screen.queryByRole("group", { name: "Desempates antes del Punto de Oro" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Punto de oro (Golden Point)" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Tiempo extra" })).not.toBeInTheDocument();

  const config = latest.categories["cat-1"].config;
  expect(config.judgesCount).toBe(5);
  expect(config.ruleSet?.judgesCount).toBe(5);
  expect(config.finalRounds).toBe(2);
  expect(config.finalSeconds).toBe(120);
  expect(config.maxTiebreakers).toBe(3);
  expect(config.ageDivision).toBeUndefined();
  expect(config.gradeSystem).toBeUndefined();
  expect(config.sexDivision).toBeUndefined();
  expect(latest.categories["cat-1"].phase).toBe("setup");
});

it("applies a time preset without resetting selected judges", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Prueba", nameGenerated: false, mode: "elimination",
  } });
  let latest = state;
  render(<Harness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByText("Ajustes avanzados: tiempos y perfil"));
  fireEvent.click(within(screen.getByRole("group", { name: "Jueces" })).getByRole("button", { name: "5" }));
  await waitFor(() => expect(latest.categories["cat-1"].config.judgesCount).toBe(5));
  fireEvent.click(screen.getByRole("button", { name: "Pre-Junior (12-14)" }));
  await waitFor(() => expect(latest.categories["cat-1"].config.finalSeconds).toBe(120));
  const config = latest.categories["cat-1"].config;
  expect(config.judgesCount).toBe(5);
  expect(config.ruleSet?.judgesCount).toBe(5);
  expect(config.finalRounds).toBe(1);
  expect(config.maxTiebreakers).toBe(1);
  expect(latest.categories["cat-1"].phase).toBe("setup");
});

it("labels Yusan as active only after the profile is applied", async () => {
  let inactive = startState();
  inactive = reduceDemoDeskState(inactive, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Prueba", nameGenerated: false, profileId: "yusan-2026", profileApplied: false,
  } });
  const first = render(<Harness initial={inactive} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByText(/Perfil: Personalizado/)).toBeVisible();
  first.unmount();

  const active = reduceDemoDeskState(inactive, { type: "category/configure", categoryId: "cat-1", patch: {
    profileApplied: true,
  } });
  render(<Harness initial={active} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByText(/Perfil: Yusan 2026/)).toBeVisible();
});

it("keeps rapid category/chief typing local until delayed autosaves settle, then reopens intact", async () => {
  let latest = startState();
  latest = reduceDemoDeskState(latest, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Inicial", nameGenerated: false,
  } });
  const mounted = render(<SlowHarness initial={latest} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  const title = screen.getByRole("textbox", { name: "Nombre de la categoría" });
  let typed = "";
  for (const character of "Categoría extensa") {
    typed += character;
    fireEvent.change(title, { target: { value: typed } });
    expect(title).toHaveValue(typed);
  }
  fireEvent.blur(title);
  fireEvent.click(screen.getByText("Mesa (opcional)"));
  const chief = screen.getByRole("textbox", { name: "Jefe de mesa" });
  fireEvent.change(chief, { target: { value: "Brian Lipnjak" } }); // paste
  expect(chief).toHaveValue("Brian Lipnjak");
  fireEvent.blur(chief);
  await waitFor(() => expect(latest.categories["cat-1"].config).toMatchObject({
    categoryName: "Categoría extensa", tableChief: "Brian Lipnjak", nameGenerated: false,
  }), { timeout: 4000 });
  mounted.unmount();
  render(<Harness initial={latest} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Categoría extensa");
  fireEvent.click(screen.getByText("Mesa (opcional)"));
  expect(screen.getByRole("textbox", { name: "Jefe de mesa" })).toHaveValue("Brian Lipnjak");
});

it("accepts clear-and-type 120 and merges rapid timing edits instead of persisting 600", async () => {
  let latest = startState();
  latest = reduceDemoDeskState(latest, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Inicial", nameGenerated: false,
  } });
  render(<SlowHarness initial={latest} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByText("Ajustes avanzados: tiempos y perfil"));
  const duration = screen.getByRole("spinbutton", { name: "Segundos por round" });
  fireEvent.change(duration, { target: { value: "" } });
  expect(duration).toHaveValue(null);
  for (const value of ["1", "12", "120"]) {
    fireEvent.change(duration, { target: { value } });
    expect(duration).toHaveValue(Number(value));
  }
  fireEvent.blur(duration);
  const rest = screen.getByRole("spinbutton", { name: "Descanso (segundos)" });
  fireEvent.change(rest, { target: { value: "20" } });
  fireEvent.blur(rest);
  await waitFor(() => expect(latest.categories["cat-1"].config.ruleSet?.mode).toBe("sparring"));
  await waitFor(() => {
    const rules = latest.categories["cat-1"].config.ruleSet;
    expect(rules?.mode === "sparring" && rules.rounds).toMatchObject({ duration_seconds: 120, rest_seconds: 20 });
  });
  expect(latest.categories["cat-1"].phase).toBe("setup");
});

it("flushes the old category before switching and never duplicates an unmounted save", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Primera original", nameGenerated: false,
  } });
  state = reduceDemoDeskState(state, { type: "category/create", categoryId: "cat-2" });
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-2", patch: {
    categoryName: "Segunda original", nameGenerated: false,
  } });
  state = reduceDemoDeskState(state, { type: "category/select", categoryId: "cat-1" });
  let latest = state;
  const mounted = render(<SlowHarness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  const title = screen.getByRole("textbox", { name: "Nombre de la categoría" });
  fireEvent.change(title, { target: { value: "Primera nueva" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Categoría actual" }), { target: { value: "cat-2" } });
  await waitFor(() => expect(latest.selectedCategoryId).toBe("cat-2"));
  expect(latest.categories["cat-1"].config.categoryName).toBe("Primera nueva");
  expect(latest.categories["cat-2"].config.categoryName).toBe("Segunda original");
  mounted.unmount();

  const changed = vi.fn();
  const second = render(<SlowHarness initial={latest} onChange={changed} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre de la categoría" }),
    { target: { value: "Borrador no confirmado" } });
  second.unmount(); // the already-created command may finish, but must not be sent twice
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(changed).toHaveBeenCalledTimes(1);
});

it("flushes an in-flight category name before creating another setup category", async () => {
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Primera original", nameGenerated: false,
  } });
  let latest = state;
  render(<SlowHarness initial={state} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre de la categoría" }),
    { target: { value: "Primera guardada" } });
  fireEvent.click(screen.getByRole("button", { name: "+ Nueva categoría" }));
  await waitFor(() => expect(latest.categoryOrder).toHaveLength(2));
  expect(latest.categories["cat-1"].config.categoryName).toBe("Primera guardada");
  expect(latest.selectedCategoryId).not.toBe("cat-1");
});

it("keeps custom age and DAN number drafts local until their explicit validated apply actions", async () => {
  sessionStorage.removeItem("tkd-demo-guided-v1:cat-1");
  let latest = startState();
  render(<SlowHarness initial={latest} onChange={(next) => { latest = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edad personalizada" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Desde" }), { target: { value: "3" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Hasta" }), { target: { value: "5" } });
  expect(latest.categories["cat-1"].config.categoryAgeFrom).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Aplicar edad" }));
  await screen.findByRole("heading", { name: /Sistema de grado/ });
  fireEvent.click(screen.getByRole("button", { name: "DANES" }));
  await screen.findByRole("heading", { name: /Grado Dan/ });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Dan desde" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Dan hasta" }), { target: { value: "2" } });
  expect(latest.categories["cat-1"].config.danFrom).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Aplicar grados" }));
  await waitFor(() => expect(latest.categories["cat-1"].config).toMatchObject({
    categoryAgeFrom: "3", categoryAgeTo: "5", danFrom: 1, danTo: 2,
  }));
});

it("recovers only a matching-generation pending draft and rejects another writer's field change", async () => {
  sessionStorage.setItem("tkd-demo-guided-v1:cat-1", JSON.stringify({ active: null,
    completed: ["age", "grade", "gender", "discipline", "weight", "format"] }));
  let state = startState();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Base", nameGenerated: false,
  } });
  const pendingDispatch = () => new Promise<never>(() => {});
  const key = "tkd-demo-pending-v1:7:event-demo:cat-1:categoryName";
  const first = render(<DemoSetup state={state} generation={7} readOnly={false}
    dispatch={pendingDispatch} onFight={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre de la categoría" }),
    { target: { value: "Borrador pendiente" } });
  expect(sessionStorage.getItem(key)).toContain("Borrador pendiente");
  first.unmount(); // simulated reload before the IDB promise resolves

  let recovered = state;
  const second = render(<Harness initial={state} generation={7} onChange={(next) => { recovered = next; }} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Borrador pendiente");
  await waitFor(() => expect(recovered.categories["cat-1"].config.categoryName).toBe("Borrador pendiente"));
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull());
  second.unmount();

  // Reset/import increments generation, even if the imported category keeps its ID and event ID.
  sessionStorage.setItem(key, JSON.stringify({ value: "No aplicar", base: "Base", sent: [], token: "old" }));
  const imported = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: {
    categoryName: "Importada", nameGenerated: false,
  } });
  const third = render(<Harness initial={imported} generation={8} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Importada");
  third.unmount();

  // Same generation but a different writer changed this exact field: drop the stale draft.
  sessionStorage.setItem(key, JSON.stringify({ value: "No aplicar", base: "Base", sent: [], token: "old" }));
  const conflict = render(<Harness initial={imported} generation={7} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Importada");
  expect(screen.getByRole("alert")).toHaveTextContent("cambió en otra pestaña");
  expect(sessionStorage.getItem(key)).toBeNull();
  conflict.unmount();

  // A tab that lost the writer lease cannot later reapply an abandoned draft.
  sessionStorage.setItem(key, JSON.stringify({ value: "Borrador viejo", base: "Base", sent: [], token: "old" }));
  const takeover = render(<DemoSetup state={state} generation={7} readOnly={true}
    dispatch={pendingDispatch} onFight={() => {}} />);
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull());
  takeover.rerender(<DemoSetup state={state} generation={7} readOnly={false}
    dispatch={pendingDispatch} onFight={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  expect(screen.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Base");
});

it("purges private pending drafts after a confirmed generation replacement", () => {
  sessionStorage.setItem("tkd-demo-pending-v1:1:event:cat:categoryName", "Private category");
  sessionStorage.setItem("tkd-demo-pending-v1:1:event:cat:tableChief", "Private chief");
  sessionStorage.setItem("tkd-demo-pending-v1:2:event:cat:categoryName", "Current pending");
  sessionStorage.setItem("tkd-demo-guided-v1:cat", "UI progress");
  purgeDemoPendingDrafts(2); // Initial open after reset/import committed before the page reloaded.
  expect(sessionStorage.getItem("tkd-demo-pending-v1:1:event:cat:categoryName")).toBeNull();
  expect(sessionStorage.getItem("tkd-demo-pending-v1:1:event:cat:tableChief")).toBeNull();
  expect(sessionStorage.getItem("tkd-demo-pending-v1:2:event:cat:categoryName")).toBe("Current pending");
  purgeDemoPendingDrafts();
  expect(sessionStorage.getItem("tkd-demo-pending-v1:2:event:cat:categoryName")).toBeNull();
  expect(sessionStorage.getItem("tkd-demo-guided-v1:cat")).toBe("UI progress");
});
