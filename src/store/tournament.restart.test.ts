import { afterEach, describe, expect, it, vi } from "vitest";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
afterEach(() => {
  vi.restoreAllMocks();
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("atomic local restart publication", () => {
  it("archives old graph and replaces its visible tab only after canonical ACK, preserving siblings/preferences", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const siblingId = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().selectCategory(previous.config.id);
    localStorage.setItem("unrelated-preference", "keep");
    const success = restartReceipt();
    expect(useTournamentStore.getState().applyCategoryRestart(success)).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(success.replacementCategoryId);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .map((e) => e.id)
    ).toContain(siblingId);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .map((e) => e.id)
    ).not.toContain(previous.config.id);
    expect(useTournamentStore.getState().selectCategory(previous.config.id)).toBe(false);
    expect(
      JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}").categories[
        previous.config.id
      ]
    ).toEqual(previous);
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("keeps progressed replacement intact on duplicate lookup and does not change a different selection", () => {
    useTournamentStore.setState(recordedCategory());
    const success = restartReceipt();
    expect(useTournamentStore.getState().applyCategoryRestart(success)).toBe(true);
    const fight = useTournamentStore.getState().fights[0];
    useTournamentStore.getState().completeFight(fight.id, "red", "kept");
    expect(useTournamentStore.getState().applyCategoryRestart(success)).toBe(true);
    expect(useTournamentStore.getState().fights[0].completed).toBe(true);
    const siblingId = useTournamentStore.getState().createCategory();
    expect(useTournamentStore.getState().applyCategoryRestart(success)).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(siblingId);
  });

  it("does not publish empty progress if durable write fails after server commit", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const before = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(useTournamentStore.getState().applyCategoryRestart(restartReceipt())).toBe(false);
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(before);
  });

  it("keeps the old execution read-only while recovery is required", () => {
    const previous = recordedCategory();
    useTournamentStore.setState(previous);
    const before = localStorage.getItem("tkd-tournament");
    useCategoryRestartState.setState({ recoveryRequired: true });
    useTournamentStore.getState().setConfig({ categoryName: "must not change" });
    useTournamentStore.getState().addCompetitor({ name: "must not add" });
    useTournamentStore.getState().setFights([]);
    expect(useTournamentStore.getState().config.categoryName).toBe(previous.config.categoryName);
    expect(useTournamentStore.getState().fights).toEqual(previous.fights);
    expect(localStorage.getItem("tkd-tournament")).toBe(before);
  });
});
