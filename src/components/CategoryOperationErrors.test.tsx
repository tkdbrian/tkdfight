import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CategoryDeleteButton } from "@/components/CategoryDeleteButton";
import { CategoryRestartButton } from "@/components/CategoryRestartButton";
import type { RuleSetSparring } from "@/engine/types";
import { categoryRestartSnapshotSchema } from "@/lib/category-restart-contract";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
let snapshot: TournamentCategorySnapshot;
function invalidRules(): void {
  Object.assign(snapshot.config, {
    ruleSet: { ...baseline, rounds: { ...baseline.rounds, duration_seconds: "invalid duration" } },
  });
}
function rawValidationDetails(): string {
  const invalid = structuredClone(snapshot);
  Object.assign(invalid.config, {
    ruleSet: { ...baseline, privateGraph: "PRIVATE_COMPETITOR_DATA" },
  });
  const result = categoryRestartSnapshotSchema.safeParse(invalid);
  if (result.success) throw new Error("Expected strict unknown-field rejection");
  return `${result.error.message} PRIVATE_COMPETITOR_DATA`;
}
beforeEach(() => {
  localStorage.clear();
  snapshot = recordedCategory();
  snapshot.config.ruleSet = baseline as RuleSetSparring;
  useTournamentStore.setState(snapshot);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
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

describe("human-readable category operation errors", () => {
  it("keeps the screenshot's real preset metadata but shows a concise actionable error for invalid local rules", async () => {
    invalidRules();
    useTournamentStore.setState(snapshot);
    const before = localStorage.getItem("tkd-tournament");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<CategoryRestartButton snapshot={snapshot} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    fireEvent.click(screen.getByRole("button", { name: "Archivar y reiniciar" }));
    const dialog = screen.getByRole("dialog");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent?.length).toBeLessThan(240);
    expect(alert).toHaveTextContent(/configuración|reglas/i);
    expect(dialog).not.toHaveTextContent(/invalid_union|unrecognized_keys|invalid_type/);
    expect(within(dialog).getByRole("button", { name: "Cancelar" })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    expect(localStorage.getItem("tkd-pending-category-restart-v1")).toBeNull();
    expect(localStorage.getItem("tkd-tournament")).toBe(before);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(false);
  });

  it.each([
    "restart",
    "delete",
  ])("does not display raw server Zod/graph details in the %s dialog", async (operation) => {
    const raw = rawValidationDetails();
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_payload", message: raw }), {
          status: 400,
        })
    );
    vi.stubGlobal("fetch", fetcher);
    render(
      operation === "restart" ? (
        <CategoryRestartButton snapshot={snapshot} {...free} />
      ) : (
        <CategoryDeleteButton snapshot={snapshot} {...free} />
      )
    );
    if (operation === "restart") {
      fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
      fireEvent.click(screen.getByRole("button", { name: "Archivar y reiniciar" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría…" }));
    }
    const dialog = screen.getByRole("dialog");
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent?.length).toBeLessThan(240);
    expect(alert).toHaveTextContent(/configuración|datos|reglas/i);
    expect(dialog).not.toHaveTextContent(/PRIVATE_COMPETITOR_DATA|invalid_union|unrecognized_keys/);
    expect(useTournamentStore.getState().fights).toEqual(snapshot.fights);
  });

  it("does not crash an already-open Delete dialog when the selected rules become invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              categoryId: snapshot.config.id,
              revision: "a".repeat(64),
              warnings: [],
              requiresConfirmationText: false,
              counts: {
                competitors: 3,
                fights: 3,
                completedFights: 0,
                confirmedResults: 0,
                localOnlyFights: 3,
              },
            })
          )
      )
    );
    const view = render(<CategoryDeleteButton snapshot={snapshot} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar categoría…" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Eliminar definitivamente" })).toBeEnabled()
    );
    invalidRules();
    act(() => useTournamentStore.setState(snapshot));
    expect(() =>
      view.rerender(<CategoryDeleteButton snapshot={snapshot} {...free} />)
    ).not.toThrow();
    expect(screen.getByRole("button", { name: "Eliminar definitivamente" })).toBeDisabled();
    expect(screen.getByRole("dialog")).not.toHaveTextContent(
      /invalid_union|unrecognized_keys|invalid_type/
    );
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeVisible();
  });

  it("bounds an old raw validation message at the Restart dialog boundary", () => {
    useCategoryRestartState.setState({ message: rawValidationDetails() });
    render(<CategoryRestartButton snapshot={snapshot} {...free} />);
    fireEvent.click(screen.getByRole("button", { name: "Reiniciar categoría…" }));
    const alert = within(screen.getByRole("dialog")).getByRole("alert");
    expect(alert.textContent?.length).toBeLessThan(240);
    expect(alert).not.toHaveTextContent(/PRIVATE_COMPETITOR_DATA|unrecognized_keys/);
  });
});
