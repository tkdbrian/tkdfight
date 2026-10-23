import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryPage } from "@/pages/HistoryPage";
import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
describe("read-only archived executions", () => {
  it("marks a deleted direct or transitive replacement without offering recovery or changing old archive", async () => {
    const receipt = restartReceipt();
    const source = { id: 1, name: "Evento", category: "Archivo anterior", createdAt: "2026-10-21",
      isActive: false, fightsTotal: 0, fightsCompleted: 0, competitors: [], fights: [], readOnly: true,
      archive: receipt.archive, fullSnapshot: recordedCategory(), replacementDeleted: {
        categoryId: "terminal-C", requestId: crypto.randomUUID(), deletedAt: "2026-10-22T00:00:00.000Z" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([source]))));
    await act(async () => render(<HistoryPage />));
    fireEvent.click(screen.getByText("Archivo anterior"));
    expect(screen.getByText(/Reemplazo eliminado definitivamente/)).toBeVisible();
    expect(screen.queryByRole("link", { name: /Ver ejecución de reemplazo/ })).not.toBeInTheDocument();
    expect(screen.getByText("Ejecución archivada · Solo lectura")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Eliminar categoría|Limpiar pruebas|Recuperar/ })).not.toBeInTheDocument();
  });
  it("shows full recorded snapshot, archive provenance/link and keeps protected source/replacement undeletable", async () => {
    const receipt = restartReceipt();
    const fullSnapshot = recordedCategory();
    fullSnapshot.fights[0] = {
      ...fullSnapshot.fights[0],
      completed: true,
      winner: "red",
      flagsRed: 3,
    };
    const source = {
      id: 1,
      name: "Evento",
      category: "Mayores",
      createdAt: "2026-10-21",
      isActive: false,
      fightsTotal: 0,
      fightsCompleted: 0,
      competitors: [],
      fights: [],
      readOnly: true,
      archive: receipt.archive,
      fullSnapshot,
    };
    const replacement = {
      ...source,
      id: 2,
      category: "Nueva ejecución",
      readOnly: undefined,
      archive: undefined,
      fullSnapshot: undefined,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([source, replacement])))
    );
    await act(async () => render(<HistoryPage />));
    fireEvent.click(screen.getByText("Mayores"));
    expect(screen.getByText("Ejecución archivada · Solo lectura")).toBeVisible();
    expect(screen.getByText(/Conservada tal como fue registrada/)).toBeVisible();
    expect(screen.getByText("Resultados locales conservados")).toBeVisible();
    expect(screen.getByRole("link", { name: /Ver ejecución de reemplazo/ })).toHaveAttribute(
      "href",
      "#history-execution-2"
    );
    expect(screen.getByText("Configuración completa")).toBeVisible();
    expect(screen.getByRole("region", { name: "Fixture archivado" })).toBeVisible();
    expect(screen.getByText("Persona 0 · Equipo")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Eliminar categoría/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Limpiar pruebas" })).not.toBeInTheDocument();
  });

  it("retains normal history cleanup controls for unrelated legacy executions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: 9,
                name: "Prueba",
                category: "Legacy",
                createdAt: "2026-10-21",
                isActive: false,
                fightsTotal: 0,
                fightsCompleted: 0,
                competitors: [],
                fights: [],
              },
            ])
          )
      )
    );
    await act(async () => render(<HistoryPage />));
    expect(screen.getByRole("button", { name: "Eliminar categoría Legacy" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Limpiar pruebas" })).toBeVisible();
  });
});
