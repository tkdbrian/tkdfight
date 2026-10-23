import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CategoryDeletionPreview,
  CategoryDeletionRequest,
} from "@/lib/category-deletion-contract";
import { beginCategoryDeletion, recoverCategoryDeletion } from "@/lib/category-deletion-controller";
import { beginCategoryRestart } from "@/lib/category-restart-controller";
import {
  PENDING_CATEGORY_DELETION_KEY,
  useCategoryDeletionState,
} from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
const counts = {
  competitors: 3,
  fights: 3,
  completedFights: 0,
  confirmedResults: 0,
  localOnlyFights: 3,
};
let selected = recordedCategory();
function preview(): CategoryDeletionPreview {
  return {
    ok: true,
    categoryId: "category-old",
    revision: "a".repeat(64),
    counts,
    warnings: [],
    requiresConfirmationText: true,
  };
}
function receipt(request: CategoryDeletionRequest) {
  return {
    ok: true,
    categoryId: request.localSnapshot.config.id,
    requestId: request.requestId,
    tournamentId: null,
    deletedAt: "2026-10-22T00:00:00.000Z",
    counts,
  };
}
beforeEach(() => {
  localStorage.clear();
  selected = recordedCategory();
  useTournamentStore.setState(selected);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCategoryDeletionState.setState({ pending: false, recoveryRequired: false, message: null });
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("immutable category deletion controller", () => {
  it("retries a missing indeterminate operation with the identical journal request identity", async () => {
    const identities: string[] = [];
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        const request = JSON.parse(String(options.body)) as CategoryDeletionRequest;
        identities.push(request.requestId);
        if (identities.length === 1) throw new Error("Disconnected before ACK");
        return new Response(JSON.stringify(receipt(request)));
      }
      return new Response(
        JSON.stringify({ ok: false, error: "deletion_not_found", message: "Missing" }),
        { status: 404 }
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryDeletion(selected, preview(), free, "ELIMINAR")).toBe(false);
    expect(useTournamentStore.getState().config.id).toBe(selected.config.id);
    expect(await recoverCategoryDeletion(true, free)).toBe(true);
    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
  });

  it("releases a never-committed retry journal after a definitive server rejection without deleting data", async () => {
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: "a".repeat(64),
      localSnapshot: selected,
    };
    localStorage.setItem(
      PENDING_CATEGORY_DELETION_KEY,
      JSON.stringify({ categoryId: selected.config.id, request })
    );
    useCategoryDeletionState.setState({ recoveryRequired: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, options?: RequestInit) =>
          new Response(
            JSON.stringify({
              ok: false,
              error: options?.method === "POST" ? "snapshot_conflict" : "deletion_not_found",
              message: "Changed",
            }),
            { status: options?.method === "POST" ? 409 : 404 }
          )
      )
    );
    expect(await recoverCategoryDeletion(true, free)).toBe(false);
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
    expect(useCategoryDeletionState.getState().recoveryRequired).toBe(false);
    expect(useTournamentStore.getState().fights).toEqual(selected.fights);
  });

  it("resolves downstream deleted lineage during canonical deletion recovery before releasing readonly state", async () => {
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: "a".repeat(64),
      localSnapshot: selected,
    };
    localStorage.setItem(
      PENDING_CATEGORY_DELETION_KEY,
      JSON.stringify({ categoryId: selected.config.id, request })
    );
    useCategoryDeletionState.setState({ recoveryRequired: true });
    const deletion = { ...receipt(request), categoryId: "deleted-C" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "replacement_deleted",
              categoryId: selected.config.id,
              message: "Deleted replacement",
              deletion,
            }),
            { status: 410 }
          )
      )
    );
    expect(await recoverCategoryDeletion()).toBe(true);
    expect(JSON.parse(localStorage.getItem("tkd-retired-category-sources-v1") ?? "[]")).toEqual([
      { sourceCategoryId: selected.config.id, deletedTargetCategoryId: "deleted-C" },
    ]);
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === selected.config.id)
    ).toBe(false);
  });
  it("keeps both graph authorities intact before ACK, blocks double-submit/restart/tab changes, then publishes deletion", async () => {
    const snapshot = selected;
    const sibling = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().selectCategory(snapshot.config.id);
    const main = localStorage.getItem("tkd-tournament");
    const registry = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    let release: (response: Response) => void = () => {};
    let posted: CategoryDeletionRequest | undefined;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      posted = JSON.parse(String(options?.body)) as CategoryDeletionRequest;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = beginCategoryDeletion(snapshot, preview(), free, "ELIMINAR");
    expect(useCategoryDeletionState.getState().pending).toBe(true);
    expect(await beginCategoryDeletion(snapshot, preview(), free, "ELIMINAR")).toBe(false);
    expect(await beginCategoryRestart(snapshot, free)).toBe(false);
    expect(useTournamentStore.getState().selectCategory(sibling ?? "")).toBe(false);
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(registry);
    if (!posted) throw new Error("Expected posted deletion");
    release(new Response(JSON.stringify(receipt(posted))));
    expect(await pending).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(sibling);
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
  });

  it("rejects offline/global loaded idle locks, wrong exact text and stale preview snapshot without commands", async () => {
    const snapshot = selected;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await beginCategoryDeletion(snapshot, preview(), { ...free, connected: false }, "ELIMINAR")
    ).toBe(false);
    expect(
      await beginCategoryDeletion(
        snapshot,
        preview(),
        {
          ...free,
          serverState: {
            match: { id: "foreign", categoryId: "other" },
            resultConfirmed: false,
          },
        },
        "ELIMINAR"
      )
    ).toBe(false);
    expect(await beginCategoryDeletion(snapshot, preview(), free, "eliminar")).toBe(false);
    useTournamentStore.getState().addCompetitor({ name: "changed" });
    expect(await beginCategoryDeletion(snapshot, preview(), free, "ELIMINAR")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains all data on known revision rejection and releases interaction", async () => {
    const before = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "snapshot_conflict",
              message: "Actualizá la vista previa",
            }),
            { status: 409 }
          )
      )
    );
    expect(await beginCategoryDeletion(selected, preview(), free, "ELIMINAR")).toBe(false);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(before);
    expect(useCategoryDeletionState.getState().recoveryRequired).toBe(false);
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
  });

  it.each([
    500, 502,
  ])("recovers an indeterminate HTTP%s via canonical receipt without a second DELETE POST", async (status) => {
    let canonical: ReturnType<typeof receipt> | undefined;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        canonical = receipt(JSON.parse(String(options.body)) as CategoryDeletionRequest);
        return new Response("gateway", { status });
      }
      return new Response(JSON.stringify(canonical));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryDeletion(selected, preview(), free, "ELIMINAR")).toBe(true);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === "category-old")
    ).toBe(false);
  });

  it("keeps an immutable journal through quota recovery and uses one server operation", async () => {
    let canonical: ReturnType<typeof receipt> | undefined;
    const original = Storage.prototype.setItem;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        canonical = receipt(JSON.parse(String(options.body)) as CategoryDeletionRequest);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
          this: Storage,
          key,
          value
        ) {
          if (key === TOURNAMENT_CATEGORY_STORAGE_KEY) throw new Error("quota");
          original.call(this, key, value);
        });
      }
      return new Response(JSON.stringify(canonical));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryDeletion(selected, preview(), free, "ELIMINAR")).toBe(false);
    expect(useCategoryDeletionState.getState().recoveryRequired).toBe(true);
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).not.toBeNull();
    expect(useTournamentStore.getState().createCategory()).toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(original);
    expect(await recoverCategoryDeletion()).toBe(true);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it("resolves old restart410 sourceA→deletedC without deleting A or restoring its initial replacement", async () => {
    const snapshot = selected;
    const deletion = {
      ok: true,
      categoryId: "terminal-C",
      requestId: crypto.randomUUID(),
      deletedAt: "2026-10-22T00:00:00.000Z",
      tournamentId: 9,
      counts,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "replacement_deleted",
              categoryId: snapshot.config.id,
              message: "Eliminado",
              deletion,
            }),
            { status: 410 }
          )
      )
    );
    expect(await beginCategoryRestart(snapshot, free)).toBe(true);
    expect(JSON.parse(localStorage.getItem("tkd-category-deletions-v1") ?? "[]")).toEqual([
      { categoryId: "terminal-C", requestId: deletion.requestId, deletedAt: deletion.deletedAt },
    ]);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(false);
    expect(localStorage.getItem("tkd-pending-category-restart-v1")).toBeNull();
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(registry.categories[snapshot.config.id]).toEqual(snapshot);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === snapshot.config.id)
    ).toBe(false);
  });
});
