import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryDeletionPreview } from "@/lib/category-deletion-contract";
import { beginCategoryRestart, recoverCategoryRestart } from "@/lib/category-restart-controller";
import type {
  CategoryDeleteAndRestartRequest,
  CategoryDeleteAndRestartSuccess,
} from "@/lib/category-restart-modes-contract";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";
import { deleteAndRestartReceipt } from "@/test/category-restart-modes-fixtures";

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
let previous = recordedCategory();
function preview(): CategoryDeletionPreview {
  return {
    ok: true,
    categoryId: previous.config.id,
    revision: "a".repeat(64),
    counts: deleteAndRestartReceipt(previous).deletion.counts,
    warnings: [],
    requiresConfirmationText: true,
  };
}
function options() {
  return { mode: "delete-and-restart" as const, preview: preview(), confirmationText: "ELIMINAR" };
}
function canonical(request: CategoryDeleteAndRestartRequest): CategoryDeleteAndRestartSuccess {
  const receipt = deleteAndRestartReceipt(request.previousSnapshot);
  return {
    ...receipt,
    requestId: request.requestId,
    replacementCategoryId: request.replacementSnapshot.config.id,
    replacementSnapshot: request.replacementSnapshot,
    deletion: { ...receipt.deletion, requestId: request.requestId },
  };
}
beforeEach(() => {
  localStorage.clear();
  previous = recordedCategory();
  useTournamentStore.setState(previous);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCategoryRestartState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    pendingDeleteAndRestartSourceId: null,
  });
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

describe("dual-mode restart controller", () => {
  it("dispatches a legacy mode-absent archive journal through the unchanged replacement lookup", async () => {
    const receipt = restartReceipt();
    localStorage.setItem(
      "tkd-pending-category-restart-v1",
      JSON.stringify({
        requestId: receipt.requestId,
        categoryId: previous.config.id,
        previousSnapshot: previous,
        replacementSnapshot: receipt.replacementSnapshot,
      })
    );
    const fetcher = vi.fn(async () => new Response(JSON.stringify(receipt)));
    vi.stubGlobal("fetch", fetcher);
    expect(await recoverCategoryRestart()).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(expect.stringMatching(/\/replacement$/), {
      method: "GET",
    });
  });

  it("persists one combined request and defers the arriving category:deleted marker before its ACK", async () => {
    const main = localStorage.getItem("tkd-tournament"),
      registry = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    let release: (response: Response) => void = () => {};
    let committed: CategoryDeleteAndRestartSuccess | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      committed = canonical(JSON.parse(String(init?.body)) as CategoryDeleteAndRestartRequest);
      const { categoryId, requestId, deletedAt } = committed.deletion;
      useTournamentStore.getState().applyCategoryDeletions([{ categoryId, requestId, deletedAt }]);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = beginCategoryRestart(previous, free, options());
    expect(useCategoryRestartState.getState().pendingDeleteAndRestartSourceId).toBe(
      previous.config.id
    );
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(registry);
    expect(await beginCategoryRestart(previous, free, options())).toBe(false);
    if (!committed) throw new Error("Expected combined request");
    release(new Response(JSON.stringify(committed)));
    expect(await pending).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/delete-and-restart$/),
      expect.objectContaining({ method: "POST" })
    );
    expect(useTournamentStore.getState().config.id).toBe(committed.replacementCategoryId);
    expect(localStorage.getItem("tkd-pending-category-restart-v1")).toBeNull();
  });

  it.each([false, true])("recovers lost ACK/503 via canonical GET without a second destructive POST (draft=%s)", async (draft) => {
    if (draft) { previous.competitors = []; useTournamentStore.setState(previous); }
    let committed: CategoryDeleteAndRestartSuccess | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        committed = canonical(JSON.parse(String(init.body)) as CategoryDeleteAndRestartRequest);
        return new Response("gateway", { status: 503 });
      }
      return new Response(JSON.stringify(committed));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(previous, free, options())).toBe(true);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "GET"]);
    expect(fetcher.mock.calls.every((call) => call[0].endsWith("/delete-and-restart"))).toBe(true);
  });

  it("refuses wrong typed confirmation, stale snapshot and any unconfirmed global loaded bout before POST", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await beginCategoryRestart(previous, free, { ...options(), confirmationText: "eliminar" })
    ).toBe(false);
    expect(
      await beginCategoryRestart(
        previous,
        { ...free, serverState: { match: { id: "other" }, resultConfirmed: false } },
        options()
      )
    ).toBe(false);
    useTournamentStore.getState().addCompetitor({ name: "changed" });
    expect(await beginCategoryRestart(previous, free, options())).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "category_archived",
    "replacement_deleted",
  ] as const)("settles committed advanced %s without replaying initial D or treating C as rolled back", async (code) => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as CategoryDeleteAndRestartRequest;
      const receipt = canonical(request);
      return new Response(
        JSON.stringify({
          ok: false,
          error: code,
          message: "Advanced",
          categoryId: previous.config.id,
          requestId: request.requestId,
          deletion: receipt.deletion,
          ...(code === "category_archived"
            ? {
                archivedCategoryId: receipt.replacementCategoryId,
                replacementCategoryId: "alive-E",
              }
            : {
                replacementDeletion: {
                  ...receipt.deletion,
                  categoryId: "terminal-E",
                  requestId: crypto.randomUUID(),
                },
              }),
        }),
        { status: code === "category_archived" ? 409 : 410 }
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(previous, free, options())).toBe(true);
    expect(localStorage.getItem("tkd-pending-category-restart-v1")).toBeNull();
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(false);
    expect(useCategoryRestartState.getState().message).toMatch(/Historial/);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === previous.config.id)
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const markers = JSON.parse(localStorage.getItem("tkd-category-deletions-v1") ?? "[]");
    expect(markers.some((marker: { categoryId: string }) => marker.categoryId === "alive-E")).toBe(
      false
    );
  });

  it("retains readonly recovery for foreign committed proof instead of deleting a foreign category", async () => {
    const receipt = deleteAndRestartReceipt(previous);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "category_archived",
            message: "Foreign",
            categoryId: "foreign-source",
            requestId: receipt.requestId,
            deletion: { ...receipt.deletion, categoryId: "foreign-source" },
            archivedCategoryId: receipt.replacementCategoryId,
            replacementCategoryId: "foreign-next",
          }),
          { status: 409 }
        )
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(previous, free, options())).toBe(false);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(true);
    expect(localStorage.getItem("tkd-pending-category-restart-v1")).not.toBeNull();
    expect(localStorage.getItem("tkd-category-deletions-v1")).toBeNull();
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
  });
});
