import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryRestartButton } from "@/components/CategoryRestartButton";
import type { RuleSetSparring } from "@/engine/types";
import { generateEliminationBracket } from "@/lib/bracket";
import { currentCategoryDeletionSnapshot } from "@/lib/category-deletion-controller";
import type { CategoryDeleteAndRestartRequest } from "@/lib/category-restart-modes-contract";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";
import { deleteAndRestartReceipt } from "@/test/category-restart-modes-fixtures";

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
const counts = {
  competitors: 5,
  fights: 12,
  completedFights: 0,
  confirmedResults: 2,
  localOnlyFights: 5,
};
let previous: TournamentCategorySnapshot;
function previewBody() {
  return {
    ok: true,
    categoryId: previous.config.id,
    revision: "a".repeat(64),
    counts,
    warnings: [],
    requiresConfirmationText: true,
  };
}
beforeEach(() => {
  localStorage.clear();
  previous = recordedCategory(5);
  previous.config.ruleSet = baseline as RuleSetSparring;
  useTournamentStore.setState(previous);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCategoryRestartState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    pendingDeleteAndRestartSourceId: null,
  });
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("one restart dialog with explicit preservation mode", () => {
  it("defaults to Archive without a preview or operation, and cancel keeps the execution unchanged", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<CategoryRestartButton snapshot={previous} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    const dialog = screen.getByRole("dialog", { name: "Reiniciar Mayores" });
    expect(within(dialog).getByRole("radio", { name: "Archivar y reiniciar" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "Eliminar y reiniciar" })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Archivar y reiniciar" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(fetcher).not.toHaveBeenCalled();
    expect(useTournamentStore.getState().fights).toEqual(previous.fights);
  });

  it.each([
    "round-robin",
    "elimination",
  ] as const)("requires canonical preview and exact ELIMINAR for %s, publishing only the combined ACK", async (mode) => {
    previous.config.mode = mode;
    if (mode === "elimination") {
      const generated = generateEliminationBracket(previous.competitors);
      previous.bracketMatches = generated.matches;
      previous.bracketSeeds = generated.seeds;
      previous.fights = [];
    }
    useTournamentStore.setState(previous);
    let release: (response: Response) => void = () => {};
    let posted: CategoryDeleteAndRestartRequest | undefined;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("deletion-preview")) return new Response(JSON.stringify(previewBody()));
      posted = JSON.parse(String(init?.body)) as CategoryDeleteAndRestartRequest;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<CategoryRestartButton snapshot={previous} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    fireEvent.click(screen.getByRole("radio", { name: "Eliminar y reiniciar" }));
    await screen.findByText(/12 combates/);
    expect(screen.getByRole("dialog")).toHaveTextContent("2 resultados confirmados");
    const confirm = screen.getByRole("button", { name: "Eliminar y reiniciar" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Escribí ELIMINAR"), { target: { value: "eliminar" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Escribí ELIMINAR"), { target: { value: "ELIMINAR" } });
    fireEvent.click(confirm);
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: "Archivar y reiniciar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeDisabled();
    if (!posted) throw new Error("Expected combined request");
    const canonical = deleteAndRestartReceipt(previous);
    await act(async () =>
      release(
        new Response(
          JSON.stringify({
            ...canonical,
            requestId: posted?.requestId,
            replacementCategoryId: posted?.replacementSnapshot.config.id,
            replacementSnapshot: posted?.replacementSnapshot,
            deletion: { ...canonical.deletion, requestId: posted?.requestId },
          })
        )
      )
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useTournamentStore.getState().config.ruleSet).toEqual(baseline);
    expect(useTournamentStore.getState().competitors.map((entry) => entry.name)).toEqual(
      previous.competitors.map((entry) => entry.name)
    );
    expect(
      fetcher.mock.calls.some(
        (call) => call[0].endsWith("/restart-category") || call[0].endsWith("/delete")
      )
    ).toBe(false);
    expect(
      fetcher.mock.calls.filter((call) => call[0].endsWith("/delete-and-restart"))
    ).toHaveLength(1);
  });

  it("ignores an obsolete destructive preview after switching back to Archive and cancel never commits", async () => {
    let release: (response: Response) => void = () => {};
    const fetcher = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal("fetch", fetcher);
    render(<CategoryRestartButton snapshot={previous} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    fireEvent.click(screen.getByRole("radio", { name: "Eliminar y reiniciar" }));
    fireEvent.click(screen.getByRole("radio", { name: "Archivar y reiniciar" }));
    await act(async () => release(new Response(JSON.stringify(previewBody()))));
    expect(screen.queryByLabelText("Escribí ELIMINAR")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archivar y reiniciar" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not bind a preview that arrives after disconnect; reconnect needs an explicit fresh preview", async () => {
    let release: (response: Response) => void = () => {};
    const fetcher = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal("fetch", fetcher);
    const view = render(<CategoryRestartButton snapshot={previous} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    fireEvent.click(screen.getByRole("radio", { name: "Eliminar y reiniciar" }));
    view.rerender(
      <CategoryRestartButton snapshot={previous} {...free} connected={false} stateReady={false} />
    );
    await act(async () => release(new Response(JSON.stringify(previewBody()))));
    view.rerender(<CategoryRestartButton snapshot={previous} {...free} />);
    expect(screen.getByRole("button", { name: "Eliminar y reiniciar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Actualizar vista previa" })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidates authoritative preview when the category graph changes before confirmation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(previewBody())))
    );
    const view = render(<CategoryRestartButton snapshot={previous} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    fireEvent.click(screen.getByRole("radio", { name: "Eliminar y reiniciar" }));
    await screen.findByLabelText("Escribí ELIMINAR");
    fireEvent.change(screen.getByLabelText("Escribí ELIMINAR"), { target: { value: "ELIMINAR" } });
    act(() => useTournamentStore.getState().addCompetitor({ name: "new entry" }));
    view.rerender(<CategoryRestartButton snapshot={currentCategoryDeletionSnapshot()} {...free} />);
    expect(screen.getByRole("button", { name: "Eliminar y reiniciar" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent(/La categoría cambió/);
  });
});
