import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { emptyDemoDeskState, reduceDemoDeskState } from "../runtime/reducer";
import { DemoCategoryTools } from "./DemoCategoryTools";

function draft() {
  let state = reduceDemoDeskState(emptyDemoDeskState("event-demo"), { type: "category/create", categoryId: "cat-1" });
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: { categoryName: "Prueba" } });
  return state;
}

it("requires the exact category name before a destructive local command", async () => {
  const dispatch = vi.fn(async () => true);
  render(<DemoCategoryTools state={draft()} categoryId="cat-1" readOnly={false} dispatch={dispatch} />);
  fireEvent.click(screen.getByText("Reiniciar, archivar o borrar categoría"));
  fireEvent.click(screen.getByRole("button", { name: "Borrar categoría" }));
  const confirm = screen.getByRole("button", { name: "Confirmar acción" });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: /Escribí exactamente/ }), { target: { value: "Prueba" } });
  fireEvent.click(confirm);
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "category/delete", categoryId: "cat-1", confirm: true }));
});

it("offers a locally isolated guest bout only after category start", async () => {
  const state = draft();
  state.categories["cat-1"].phase = "fighting";
  const dispatch = vi.fn(async () => true);
  render(<DemoCategoryTools state={state} categoryId="cat-1" readOnly={false} dispatch={dispatch} />);
  fireEvent.click(screen.getByText("Combate invitado local"));
  fireEvent.change(screen.getByRole("textbox", { name: "Rojo" }), { target: { value: "Ana" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Azul" }), { target: { value: "Beto" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Nombre de la exhibición" }), { target: { value: "Exhibición" } });
  fireEvent.click(screen.getByRole("button", { name: "Agregar exhibición" }));
  await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "category/addGuestFight", categoryId: "cat-1",
    redName: "Ana", blueName: "Beto", categoryName: "Exhibición", originRing: "Mesa local" }));
});

it("offers a bracket-slot swap only before the first bout is loaded", async () => {
  let state = draft();
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: { mode: "elimination" } });
  for (const [id, name] of [["c1", "Ana"], ["c2", "Beto"]] as const) {
    state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1", competitorId: id, competitor: { name } });
  }
  state = reduceDemoDeskState(state, { type: "category/start", categoryId: "cat-1" });
  const dispatch = vi.fn(async () => true);
  render(<DemoCategoryTools state={state} categoryId="cat-1" readOnly={false} dispatch={dispatch} />);
  fireEvent.click(screen.getByText("Cambiar posiciones de la llave"));
  const first = screen.getByRole("combobox", { name: "Primera posición" });
  const second = screen.getByRole("combobox", { name: "Segunda posición" });
  const choices = screen.getAllByRole("option").filter((option) => (option as HTMLOptionElement).value);
  fireEvent.change(first, { target: { value: (choices[0] as HTMLOptionElement).value } });
  fireEvent.change(second, { target: { value: (choices[choices.length - 1] as HTMLOptionElement).value } });
  fireEvent.click(screen.getByRole("button", { name: "Intercambiar posiciones" }));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "category/swapBracketSlots", categoryId: "cat-1" }));
});
