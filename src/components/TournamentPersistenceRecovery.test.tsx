import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TournamentPersistenceRecovery } from "./TournamentPersistenceRecovery";
import { useTournamentPersistenceState } from "@/lib/tournament-persistence";
import { useTournamentStore } from "@/store/tournament";
import { categoryRestartInteractionBlocked } from "@/store/category-restart-state";
afterEach(() => { cleanup(); vi.restoreAllMocks(); useTournamentPersistenceState.setState({ blocked: false, message: null }); localStorage.clear(); });
it("shows an explicit persistent warning and retries before reopening tournament actions", () => {
  useTournamentPersistenceState.setState({ blocked: true, message: "No cierres ni recargues esta ventana." });
  const hydrate = vi.spyOn(useTournamentStore.persist, "rehydrate").mockImplementation(() => {});
  render(<TournamentPersistenceRecovery />);
  expect(screen.getByRole("alert")).toHaveTextContent("No cierres ni recargues");
  expect(categoryRestartInteractionBlocked()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reintentar guardado" }));
  expect(hydrate).toHaveBeenCalledOnce();
  expect(categoryRestartInteractionBlocked()).toBe(false);
});
