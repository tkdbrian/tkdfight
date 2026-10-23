import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryDeleteButton } from "@/components/CategoryDeleteButton";
import type { CategoryDeletionRequest } from "@/lib/category-deletion-contract";
import { currentCategoryDeletionSnapshot } from "@/lib/category-deletion-controller";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
const counts = {
  competitors: 3,
  fights: 4,
  completedFights: 1,
  confirmedResults: 1,
  localOnlyFights: 2,
};
beforeEach(() => {
  localStorage.clear();
  useTournamentStore.setState(recordedCategory());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("separate permanent deletion confirmation", () => {
  it("shows one named authoritative dialog, requires exact text and leaves graphs intact until ACK", async () => {
    const snapshot = currentCategoryDeletionSnapshot();
    const sibling = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().selectCategory(snapshot.config.id);
    let release: (response: Response) => void = () => {};
    let request: CategoryDeletionRequest | undefined;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("deletion-preview"))
        return new Response(
          JSON.stringify({
            ok: true,
            categoryId: snapshot.config.id,
            revision: "a".repeat(64),
            counts,
            warnings: [],
            requiresConfirmationText: true,
          })
        );
      request = JSON.parse(String(options?.body)) as CategoryDeletionRequest;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<CategoryDeleteButton snapshot={snapshot} {...free} />);
    fireEvent.click(screen.getByText("Más acciones de categoría"));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría…" }));
    const dialog = await screen.findByRole("dialog", { name: "Eliminar Mayores definitivamente" });
    expect(dialog).toHaveTextContent("3 competidores");
    expect(dialog).toHaveTextContent("4 combates");
    expect(dialog).toHaveTextContent("1 resultados confirmados");
    expect(dialog).toHaveTextContent("archivos anteriores se conservarán");
    const confirm = screen.getByRole("button", { name: "Eliminar definitivamente" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Escribí ELIMINAR"), { target: { value: "eliminar" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Escribí ELIMINAR"), { target: { value: "ELIMINAR" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(useTournamentStore.getState().config.id).toBe(snapshot.config.id);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    if (!request) throw new Error("Expected deletion request");
    await act(async () =>
      release(
        new Response(
          JSON.stringify({
            ok: true,
            categoryId: snapshot.config.id,
            requestId: request?.requestId,
            tournamentId: null,
            deletedAt: "2026-10-22T00:00:00.000Z",
            counts,
          })
        )
      )
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTournamentStore.getState().config.id).toBe(sibling);
  });

  it("invalidates a server preview when local data changes and allows cancellation without a delete", async () => {
    const snapshot = currentCategoryDeletionSnapshot();
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            categoryId: snapshot.config.id,
            revision: "a".repeat(64),
            counts,
            warnings: [],
            requiresConfirmationText: false,
          })
        )
    );
    vi.stubGlobal("fetch", fetcher);
    const view = render(<CategoryDeleteButton snapshot={snapshot} {...free} />);
    fireEvent.click(screen.getByText("Más acciones de categoría"));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría…" }));
    await screen.findByRole("dialog");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Eliminar definitivamente" })).toBeEnabled()
    );
    act(() => useTournamentStore.getState().addCompetitor({ name: "new" }));
    view.rerender(<CategoryDeleteButton snapshot={currentCategoryDeletionSnapshot()} {...free} />);
    expect(screen.getByRole("button", { name: "Eliminar definitivamente" })).toBeDisabled();
    expect(screen.getByText(/La categoría cambió/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { connected: false, stateReady: false },
    { connected: true, stateReady: false },
  ])("cannot delete even a local draft without online fresh state: $connected/$stateReady", (connection) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(
      <CategoryDeleteButton
        snapshot={currentCategoryDeletionSnapshot()}
        {...free}
        {...connection}
      />
    );
    fireEvent.click(screen.getByText("Más acciones de categoría"));
    expect(screen.getByRole("button", { name: "Eliminar categoría…" })).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
