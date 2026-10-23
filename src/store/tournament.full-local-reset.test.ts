import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "./tournament";

const initialState = useTournamentStore.getState();
const proposalKey = "tkd-pending-fight-v1:old-category:stage";
const keptKeys = ["tkd-custom-presets", "tkd-central-targets", "tkd-sidebar-external-open",
  "tkd-pending-fight-v1-not-a-proposal", "other-app-record"];
const testKeys = ["tkd-tournament", TOURNAMENT_CATEGORY_STORAGE_KEY, "tkd-historial-cache", proposalKey, ...keptKeys];

function seedCategories(): string[] {
  const fighter = { id: "old-athlete", name: "Alumno anterior" };
  act(() => useTournamentStore.setState({ ...initialState,
    config: { ...initialState.config, id: "old-category", eventId: "old-event", profileId: "yusan-2026",
      profileApplied: true, categoryName: "Anterior", tournamentName: "Torneo anterior" },
    phase: "fighting", setupStarted: true, competitors: [fighter],
    fights: [{ id: "old-fight", red: fighter, blue: { id: "opponent", name: "Rival anterior" },
      completed: true, winner: "red", flagsRed: 4, flagsBlue: 0 }],
    groups: [{ id: "G1", competitors: [fighter], size: 1 }],
    bracketSeeds: [fighter.id], eventProfiles: { "old-event": "yusan-2026" } }));
  act(() => {
    useTournamentStore.getState().createCategory();
    useTournamentStore.getState().setConfig({ categoryName: "Guardada B" });
    useTournamentStore.getState().addCompetitor({ name: "Alumno B" });
    expect(useTournamentStore.getState().hideCategory("old-category")).toBe(true);
    useTournamentStore.getState().createCategory();
    useTournamentStore.getState().setConfig({ categoryName: "Borrador C" });
  });
  localStorage.setItem("tkd-historial-cache", JSON.stringify([{ name: fighter.name, fights: ["old-fight"] }]));
  localStorage.setItem(proposalKey, JSON.stringify({ fights: [{ red: fighter, id: "old-proposed" }] }));
  for (const key of keptKeys) localStorage.setItem(key, `preserve:${key}`);
  return useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id);
}

function assertEmptyCategory(oldIds: string[]): string {
  const state = useTournamentStore.getState();
  expect(state.phase).toBe("setup"); expect(state.setupStarted).toBe(false);
  expect(state.config.id).toBeTruthy(); expect(oldIds).not.toContain(state.config.id);
  expect(state.config.eventId).toBeTruthy(); expect(state.config.eventId).not.toBe("old-event");
  expect(state.config.profileId).toBeUndefined(); expect(state.config.profileApplied).not.toBe(true);
  expect(state.config.tournamentName).toBe(""); expect(state.config.categoryName).toBe("");
  expect(state.competitors).toEqual([]); expect(state.fights).toEqual([]); expect(state.groups).toEqual([]);
  expect(state.bracketMatches).toEqual([]); expect(state.bracketSeeds).toEqual([]);
  expect(state.currentFightIndex).toBe(0); expect(state.eventProfiles).toEqual({});
  const entries = state.getCategoryEntries();
  expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ id: state.config.id, visible: true, isDraft: false, fightIds: [] });
  const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)!);
  expect(Object.keys(registry.categories)).toEqual([state.config.id]);
  expect(registry.visibleCategoryIds).toEqual([state.config.id]); expect(registry.selectedCategoryId).toBe(state.config.id);
  expect(registry.draftCategoryId).toBeNull(); expect(registry.draftReturnCategoryId).toBeNull();
  const main = JSON.parse(localStorage.getItem("tkd-tournament")!);
  expect(main.state.config.id).toBe(state.config.id);
  expect(main.state.config.eventId).toBe(state.config.eventId);
  expect(main.state.fights).toEqual([]); expect(main.state.competitors).toEqual([]);
  expect(localStorage.getItem("tkd-historial-cache")).toBeNull(); expect(localStorage.getItem(proposalKey)).toBeNull();
  for (const key of keptKeys) expect(localStorage.getItem(key)).toBe(`preserve:${key}`);
  return state.config.id;
}

beforeEach(() => { for (const key of testKeys) localStorage.removeItem(key); });
afterEach(() => {
  vi.restoreAllMocks(); act(() => useTournamentStore.setState(initialState));
  for (const key of testKeys) localStorage.removeItem(key);
});

describe("reinicio explícito de todas las categorías locales", () => {
  it("replaces saved, hidden and draft graphs with one fresh blank category while preserving unrelated keys", () => {
    const oldIds = seedCategories();
    expect(useTournamentStore.getState().getCategoryEntries().some((entry) => !entry.visible)).toBe(true);
    expect(useTournamentStore.getState().getCategoryEntries().some((entry) => entry.isDraft)).toBe(true);
    expect(useTournamentStore.getState().resetAllLocalCategories()).toBe(true);
    assertEmptyCategory(oldIds);
  });

  it("does not resurrect old graphs or pending proposals after module reload", async () => {
    const oldIds = seedCategories();
    expect(useTournamentStore.getState().resetAllLocalCategories()).toBe(true);
    const freshId = assertEmptyCategory(oldIds);
    vi.resetModules();
    const restarted = await import("./tournament");
    await restarted.useTournamentStore.persist.rehydrate();
    expect(restarted.useTournamentStore.getState().config.id).toBe(freshId);
    expect(restarted.useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id)).toEqual([freshId]);
    expect(restarted.useTournamentStore.getState().fights).toEqual([]);
    for (const id of oldIds) expect(restarted.useTournamentStore.getState().restoreCategorySnapshot(id)).toBe(false);
    expect(localStorage.getItem(proposalKey)).toBeNull();
  });

  it("deduplicates the HTTP/socket pair but creates a new identity after the user adds data", () => {
    const oldIds = seedCategories();
    expect(useTournamentStore.getState().resetAllLocalCategories()).toBe(true);
    const firstId = assertEmptyCategory(oldIds);
    const firstEvent = useTournamentStore.getState().config.eventId;
    expect(useTournamentStore.getState().resetAllLocalCategories()).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe(firstId);
    expect(useTournamentStore.getState().config.eventId).toBe(firstEvent);
    act(() => useTournamentStore.getState().addCompetitor({ name: "Nueva prueba" }));
    expect(useTournamentStore.getState().resetAllLocalCategories()).toBe(true);
    expect(useTournamentStore.getState().config.id).not.toBe(firstId);
    assertEmptyCategory([...oldIds, firstId]);
  });

  it("does not publish an empty graph when writing the replacement registry fails", () => {
    seedCategories();
    const before = useTournamentStore.getState();
    const registry = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    const main = localStorage.getItem("tkd-tournament");
    const original = Storage.prototype.setItem;
    let failed = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === TOURNAMENT_CATEGORY_STORAGE_KEY && !failed) { failed = true; throw new Error("storage unavailable"); }
      return original.call(this, key, value);
    });
    expect(useTournamentStore.getState().resetAllLocalCategories()).toBe(false);
    expect(useTournamentStore.getState().config).toEqual(before.config);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(registry);
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(localStorage.getItem(proposalKey)).not.toBeNull();
  });
});
