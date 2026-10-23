import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";
import { deleteAndRestartReceipt } from "@/test/category-restart-modes-fixtures";

const initial = useTournamentStore.getState();
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
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

describe("atomic local delete-and-restart", () => {
  it("resolves committed archived D→alive E truthfully without marking E deleted or recreating initial D", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const receipt = deleteAndRestartReceipt(previous);
    expect(
      useTournamentStore.getState().resolveCommittedCategoryRestart(
        {
          ok: false,
          error: "category_archived",
          message: "Advanced",
          categoryId: previous.config.id,
          requestId: receipt.requestId,
          deletion: receipt.deletion,
          archivedCategoryId: receipt.replacementCategoryId,
          replacementCategoryId: "alive-E",
        },
        receipt.replacementCategoryId
      )
    ).toBe(true);
    const markers = JSON.parse(localStorage.getItem("tkd-category-deletions-v1") ?? "[]");
    expect(markers.map((marker: { categoryId: string }) => marker.categoryId)).toEqual([
      previous.config.id,
    ]);
    expect(
      JSON.parse(localStorage.getItem("tkd-retired-category-sources-v1") ?? "[]")
    ).toContainEqual({
      sourceCategoryId: receipt.replacementCategoryId,
      reason: "archived",
      replacementCategoryId: "alive-E",
    });
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(registry.categories[receipt.replacementCategoryId]).toBeUndefined();
    expect(useTournamentStore.getState().reopenCategory(receipt.replacementCategoryId)).toBe(false);
  });

  it("distinguishes source deletion C from terminal deleted E in a committed410", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const receipt = deleteAndRestartReceipt(previous);
    const terminal = {
      ...receipt.deletion,
      categoryId: "deleted-E",
      requestId: crypto.randomUUID(),
    };
    expect(
      useTournamentStore.getState().resolveCommittedCategoryRestart(
        {
          ok: false,
          error: "replacement_deleted",
          message: "Deleted",
          categoryId: previous.config.id,
          requestId: receipt.requestId,
          deletion: receipt.deletion,
          replacementDeletion: terminal,
        },
        receipt.replacementCategoryId
      )
    ).toBe(true);
    expect(
      JSON.parse(localStorage.getItem("tkd-category-deletions-v1") ?? "[]").map(
        (marker: { categoryId: string }) => marker.categoryId
      )
    ).toEqual([previous.config.id, "deleted-E"]);
    expect(
      JSON.parse(localStorage.getItem("tkd-retired-category-sources-v1") ?? "[]")
    ).toContainEqual({
      sourceCategoryId: receipt.replacementCategoryId,
      deletedTargetCategoryId: "deleted-E",
    });
  });
  it("marks C before publishing D once without an empty draft or fabricated archive, retaining older archive bytes", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const receipt = deleteAndRestartReceipt(previous);
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    const oldArchive = {
      ...restartReceipt().archive,
      categoryId: "archive-A",
      replacementCategoryId: previous.config.id,
    };
    registry.archives = { "archive-A": oldArchive };
    const archiveBytes = JSON.stringify(registry.archives);
    localStorage.setItem(TOURNAMENT_CATEGORY_STORAGE_KEY, JSON.stringify(registry));
    const published: string[] = [];
    const stop = useTournamentStore.subscribe((state) => published.push(state.config.id));
    const writes: string[] = [];
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      writes.push(key);
      original.call(this, key, value);
    });
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(receipt)).toBe(true);
    stop();
    expect(writes[0]).toBe("tkd-category-deletions-v1");
    expect(published).toEqual([receipt.replacementCategoryId]);
    const next = useTournamentStore.getState();
    expect(next.config).toEqual(receipt.replacementSnapshot.config);
    expect(next.fights).toEqual(receipt.replacementSnapshot.fights);
    const saved = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(saved.categories[previous.config.id]).toBeUndefined();
    expect(JSON.stringify(saved.archives)).toBe(archiveBytes);
    expect(saved.archives[previous.config.id]).toBeUndefined();
  });

  it("defers generic source deletion fallback while the originating combined request is awaiting ACK", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const receipt = deleteAndRestartReceipt(previous);
    localStorage.setItem(
      "tkd-pending-category-restart-v1",
      JSON.stringify({
        mode: "delete-and-restart",
        categoryId: previous.config.id,
        request: {
          requestId: receipt.requestId,
          expectedRevision: "a".repeat(64),
          previousSnapshot: previous,
          replacementSnapshot: receipt.replacementSnapshot,
        },
      })
    );
    useCategoryRestartState.setState({
      pending: true,
      pendingDeleteAndRestartSourceId: previous.config.id,
    });
    const main = localStorage.getItem("tkd-tournament"),
      registry = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    expect(useTournamentStore.getState().applyCategoryRestart(restartReceipt())).toBe(false);
    const { categoryId, requestId, deletedAt } = receipt.deletion;
    expect(
      useTournamentStore.getState().applyCategoryDeletions([{ categoryId, requestId, deletedAt }])
    ).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(registry);
    expect(localStorage.getItem("tkd-category-deletions-v1")).toContain(previous.config.id);
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(receipt)).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(receipt.replacementCategoryId);
  });

  it("preserves already-progressed D and a different selected category on canonical recovery", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const receipt = deleteAndRestartReceipt(previous);
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(receipt)).toBe(true);
    const fight = useTournamentStore.getState().fights[0];
    if (!fight) throw new Error("Expected fresh fixture");
    useTournamentStore.getState().completeFight(fight.id, "red", "kept progress");
    const sibling = useTournamentStore.getState().createCategory();
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(receipt)).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(sibling);
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(registry.categories[receipt.replacementCategoryId].fights[0].completed).toBe(true);
    expect(registry.categories[receipt.replacementCategoryId].fights[0].winReason).toBe(
      "kept progress"
    );
  });

  it.each([
    "tkd-category-deletions-v1",
    "tkd-tournament",
    TOURNAMENT_CATEGORY_STORAGE_KEY,
  ])("retains readonly old memory and no fake rollback if %s fails", (failingKey) => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === failingKey) throw new Error("quota");
      original.call(this, key, value);
    });
    expect(
      useTournamentStore.getState().applyCategoryDeleteAndRestart(deleteAndRestartReceipt(previous))
    ).toBe(false);
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    useTournamentStore.getState().addCompetitor({ name: "must not revive" });
    expect(useTournamentStore.getState().competitors).toEqual(previous.competitors);
  });

  it("rehydrates a pending originating operation with a source marker without an intermediate empty draft", async () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const receipt = deleteAndRestartReceipt(previous);
    localStorage.setItem(
      "tkd-pending-category-restart-v1",
      JSON.stringify({
        mode: "delete-and-restart",
        categoryId: previous.config.id,
        request: {
          requestId: receipt.requestId,
          expectedRevision: "a".repeat(64),
          previousSnapshot: previous,
          replacementSnapshot: receipt.replacementSnapshot,
        },
      })
    );
    const { categoryId, requestId, deletedAt } = receipt.deletion;
    localStorage.setItem(
      "tkd-category-deletions-v1",
      JSON.stringify([{ categoryId, requestId, deletedAt }])
    );
    vi.resetModules();
    const { useTournamentStore: loaded } = await import("@/store/tournament");
    expect(loaded.getState().config.id).toBe(previous.config.id);
    expect(loaded.getState().fights).toEqual(previous.fights);
    expect(loaded.getState().createCategory()).toBeNull();
    expect(loaded.getState().applyCategoryDeleteAndRestart(receipt)).toBe(true);
    expect(loaded.getState().config.id).toBe(receipt.replacementCategoryId);
  });
});
