import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryDeletionRecovery } from "@/components/CategoryDeletionRecovery";
import {
  PENDING_CATEGORY_DELETION_KEY,
  useCategoryDeletionState,
} from "@/store/category-deletion-state";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
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
describe("global readonly deletion recovery", () => {
  it("keeps recovery visibly pending offline and resolves canonical ACK by GET after fresh reconnect", async () => {
    localStorage.clear();
    const localSnapshot = recordedCategory();
    useTournamentStore.setState(localSnapshot);
    const requestId = crypto.randomUUID();
    localStorage.setItem(
      PENDING_CATEGORY_DELETION_KEY,
      JSON.stringify({
        categoryId: localSnapshot.config.id,
        request: { requestId, expectedRevision: "a".repeat(64), localSnapshot },
      })
    );
    useCategoryDeletionState.setState({ recoveryRequired: true });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            categoryId: localSnapshot.config.id,
            requestId,
            tournamentId: null,
            deletedAt: "2026-10-22T00:00:00.000Z",
            counts: {
              competitors: 3,
              fights: 3,
              completedFights: 0,
              confirmedResults: 0,
              localOnlyFights: 3,
            },
          })
        )
    );
    vi.stubGlobal("fetch", fetcher);
    const context = {
      connected: false,
      stateReady: false,
      serverState: { match: null, activeMatchLock: null },
    };
    const view = render(<CategoryDeletionRecovery {...context} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Solo lectura");
    expect(screen.getByRole("button", { name: "Recuperar eliminación" })).toBeDisabled();
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () =>
      view.rerender(<CategoryDeletionRecovery {...context} connected stateReady />)
    );
    await waitFor(() => expect(useCategoryDeletionState.getState().recoveryRequired).toBe(false));
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/deletion"), { method: "GET" });
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
  });
});
