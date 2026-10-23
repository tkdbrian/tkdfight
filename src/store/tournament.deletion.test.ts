import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
const ledgerKey = "tkd-category-deletions-v1";
const tombstone = {
  categoryId: "category-old",
  requestId: crypto.randomUUID(),
  deletedAt: "2026-10-22T00:00:00.000Z",
};
beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
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

describe("durable execution tombstones", () => {
  it("fails closed when another browser tab writes an unresolved operation journal", () => {
    useTournamentStore.setState(recordedCategory());
    const before = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    localStorage.setItem("tkd-pending-category-deletion-v1", "{}");
    expect(useTournamentStore.getState().createCategory()).toBeNull();
    useTournamentStore.getState().setConfig({ categoryName: "stale tab" });
    expect(useTournamentStore.getState().config.categoryName).toBe("Mayores");
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(before);
  });
  it("cannot publish an old restart ACK while a deletion journal is unresolved", () => {
    useTournamentStore.setState(recordedCategory());
    const before = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    useCategoryDeletionState.setState({ pending: true });
    expect(useTournamentStore.getState().applyCategoryRestart(restartReceipt())).toBe(false);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(before);
  });
  it("persists technical identity before removing the selected graph and preserves sibling progress/event/preferences", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const sibling = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().setConfig({ categoryName: "Sibling kept" });
    const siblingSnapshot = useTournamentStore.getState().config;
    useTournamentStore.getState().selectCategory(previous.config.id);
    localStorage.setItem("preference", "keep");
    const writes: string[] = [];
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      writes.push(key);
      original.call(this, key, value);
    });
    expect(useTournamentStore.getState().applyCategoryDeletions([tombstone])).toBe(true);
    expect(writes[0]).toBe(ledgerKey);
    expect(useTournamentStore.getState().config).toEqual(siblingSnapshot);
    expect(useTournamentStore.getState().config.id).toBe(sibling);
    expect(useTournamentStore.getState().config.eventId).toBe(previous.config.eventId);
    expect(
      JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}").categories[
        previous.config.id
      ]
    ).toBeUndefined();
    expect(localStorage.getItem("preference")).toBe("keep");
    expect(localStorage.getItem(ledgerKey)).not.toContain("Persona");
  });

  it("leaves an empty local draft in the same event when no visible execution remains", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(useTournamentStore.getState().applyCategoryDeletions([tombstone])).toBe(true);
    const next = useTournamentStore.getState();
    expect(next.config.id).not.toBe(previous.config.id);
    expect(next.config.eventId).toBe(previous.config.eventId);
    expect(next.config.tournamentName).toBe(previous.config.tournamentName);
    expect(next.config.categoryName).toBe("");
    expect(next.fights).toEqual([]);
    expect(next.competitors).toEqual([]);
    expect(next.getCategoryEntries().find((entry) => entry.id === next.config.id)?.isDraft).toBe(
      true
    );
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects stale edits, outgoing autosaves, reopen, restore and old replacement ACK resurrection", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const sibling = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().selectCategory(previous.config.id);
    expect(useTournamentStore.getState().applyCategoryDeletions([tombstone])).toBe(true);
    const success = restartReceipt();
    expect(useTournamentStore.getState().applyCategoryRestart(success)).toBe(false);
    expect(useTournamentStore.getState().selectCategory(previous.config.id)).toBe(false);
    expect(useTournamentStore.getState().reopenCategory(previous.config.id)).toBe(false);
    expect(useTournamentStore.getState().restoreCategorySnapshot(previous.config.id)).toBe(false);
    useTournamentStore.setState(previous);
    const main = localStorage.getItem("tkd-tournament");
    useTournamentStore.getState().setConfig({ categoryName: "stale mutation" });
    expect(useTournamentStore.getState().config.categoryName).toBe(previous.config.categoryName);
    expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(false);
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(useTournamentStore.getState().selectCategory(sibling ?? "")).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}").categories[
        previous.config.id
      ]
    ).toBeUndefined();
  });

  it.each([
    ledgerKey,
    TOURNAMENT_CATEGORY_STORAGE_KEY,
  ])("keeps old memory read-only without fake rollback when %s storage fails", (failingKey) => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === failingKey) throw new Error("quota");
      original.call(this, key, value);
    });
    expect(useTournamentStore.getState().applyCategoryDeletions([tombstone])).toBe(false);
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    if (failingKey !== ledgerKey)
      expect(localStorage.getItem(ledgerKey)).toContain(previous.config.id);
    useTournamentStore.getState().addCompetitor({ name: "cannot revive" });
    expect(useTournamentStore.getState().competitors).toEqual(previous.competitors);
  });

  it("hydrates stale main/registry without resurrecting a tombstoned execution", async () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    localStorage.setItem(ledgerKey, JSON.stringify([tombstone]));
    vi.resetModules();
    const { useTournamentStore: reloaded } = await import("@/store/tournament");
    expect(reloaded.getState().config.id).not.toBe(previous.config.id);
    expect(reloaded.getState().config.eventId).toBe(previous.config.eventId);
    expect(
      reloaded
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === previous.config.id)
    ).toBe(false);
    expect(
      JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}").categories[
        previous.config.id
      ]
    ).toBeUndefined();
  });
});
