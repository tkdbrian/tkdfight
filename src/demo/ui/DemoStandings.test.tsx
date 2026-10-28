import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { emptyDemoDeskState, reduceDemoDeskState } from "../runtime/reducer";
import { buildDemoStandingsCsv, DemoStandings } from "./DemoStandings";

function started() {
  let state = reduceDemoDeskState(emptyDemoDeskState("event-demo"), { type: "category/create", categoryId: "cat-1" });
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1", patch: { categoryName: "Prueba" } });
  for (const [id, name] of [["c1", "Ana"], ["c2", "Beto"], ["c3", "Carla"]] as const) {
    state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1", competitorId: id, competitor: { name } });
  }
  return reduceDemoDeskState(state, { type: "category/start", categoryId: "cat-1" });
}

function startedElimination(entrants = 4) {
  let state = reduceDemoDeskState(emptyDemoDeskState("event-elimination"), { type: "category/create", categoryId: "cat-1" });
  state = reduceDemoDeskState(state, { type: "category/configure", categoryId: "cat-1",
    patch: { categoryName: "Eliminación de prueba", mode: "elimination" } });
  for (let index = 0; index < entrants; index++) {
    state = reduceDemoDeskState(state, { type: "category/addCompetitor", categoryId: "cat-1",
      competitorId: `c${index + 1}`, competitor: { name: `Competidor ${index + 1}` } });
  }
  return reduceDemoDeskState(state, { type: "category/start", categoryId: "cat-1" });
}

it("does not promote an unfinished round-robin leader to champion", () => {
  const state = started();
  render(<DemoStandings state={state} categoryId="cat-1" />);
  expect(screen.queryByText("Oro · Campeón")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("líderes parciales no son campeones");
});

it("uses the existing outcome selector for a completed group", () => {
  const state = started();
  for (const fight of state.categories["cat-1"].fights) {
    fight.completed = true;
    fight.winner = fight.red.id === "c1" ? "red" : fight.blue.id === "c1" ? "blue" : "red";
  }
  render(<DemoStandings state={state} categoryId="cat-1" />);
  expect(screen.getByText("Ana", { selector: "p" })).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("opens the shared official print sheet only after matching local confirmations", () => {
  const state = started();
  for (const [index, fight] of state.categories["cat-1"].fights.entries()) {
    fight.completed = true;
    fight.winner = fight.red.id === "c1" ? "red" : fight.blue.id === "c1" ? "blue" : "red";
    fight.flagsRed = fight.winner === "red" ? 3 : 1;
    fight.flagsBlue = fight.winner === "blue" ? 3 : 1;
    fight.warningsRed = 0; fight.warningsBlue = 0; fight.foulsRed = 0; fight.foulsBlue = 0;
    state.history.push({ id: `h${index}`, categoryId: "cat-1", fightId: fight.id, confirmedAt: "2026-10-27T12:00:00.000Z",
      red: fight.red, blue: fight.blue, winner: fight.winner, reason: "points", flagsRed: fight.flagsRed,
      flagsBlue: fight.flagsBlue, warningsRed: 0, warningsBlue: 0, foulsRed: 0, foulsBlue: 0 });
  }
  render(<DemoStandings state={state} categoryId="cat-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Planilla oficial / PDF" }));
  expect(screen.getByRole("dialog", { name: "Vista previa de impresión" })).toBeVisible();
});

it("quotes local CSV cells and neutralizes spreadsheet formulas in names", () => {
  const rows = new Map([["G1", [{ id: "1", name: "=IMPORTXML(1)", team: "A, B", played: 1,
    wins: 1, draws: 0, losses: 0, points: 3, flagsFor: 4, foulsAgainst: 0, warnings: 0 }]]]);
  const csv = buildDemoStandingsCsv(rows);
  expect(csv).toContain("\"'=IMPORTXML(1)\"");
  expect(csv).toContain("\"A, B\"");
});

it("shows the original-style elimination rounds rather than a generic table", () => {
  const state = startedElimination();
  render(<DemoStandings state={state} categoryId="cat-1" />);
  expect(screen.getByRole("heading", { name: "Bracket de Eliminación" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Llave principal" })).toBeVisible();
  expect(screen.getByText("Semifinal")).toBeVisible();
  expect(screen.getByText("Final")).toBeVisible();
  expect(screen.getAllByRole("article")).toHaveLength(state.categories["cat-1"].bracketMatches.length);
  expect(screen.getAllByText("Ganador pendiente").length).toBeGreaterThan(0);
});

it("keeps both generated grillas separate for a large elimination category", () => {
  const state = startedElimination(17);
  render(<DemoStandings state={state} categoryId="cat-1" />);
  expect(screen.getByRole("region", { name: "Grilla A" })).toBeVisible();
  expect(screen.getByRole("region", { name: "Grilla B" })).toBeVisible();
  expect(screen.getAllByRole("article")).toHaveLength(state.categories["cat-1"].bracketMatches.length);
});

it("shows confirmed elimination champion and runner-up above the bracket", () => {
  const state = startedElimination(2);
  const category = state.categories["cat-1"];
  const fight = category.fights[0];
  const match = category.bracketMatches[0];
  fight.completed = true;
  fight.winner = "red";
  match.completed = true;
  match.winnerId = fight.red.id;
  render(<DemoStandings state={state} categoryId="cat-1" />);
  expect(screen.getByText("Oro · Campeón")).toBeVisible();
  expect(screen.getByText("Plata · Subcampeón")).toBeVisible();
  expect(screen.getByText("Oro · Campeón").parentElement).toHaveTextContent(fight.red.name);
  expect(screen.getByText("Plata · Subcampeón").parentElement).toHaveTextContent(fight.blue.name);
});

it("keeps the round-robin table readable without a forced mobile-width scroll", () => {
  render(<DemoStandings state={started()} categoryId="cat-1" />);
  expect(screen.getByRole("heading", { name: "Clasificación" })).toBeVisible();
  const table = screen.getByRole("table");
  expect(table).toHaveClass("w-full");
  expect(table).not.toHaveClass("min-w-[38rem]");
  expect(screen.getByRole("columnheader", { name: "Empates" })).toHaveClass("hidden");
  expect(screen.getByRole("columnheader", { name: "Ganados" })).not.toHaveClass("hidden");
});
