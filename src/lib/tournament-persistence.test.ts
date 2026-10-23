import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commitTournamentAuthorities, recoverTournamentAuthorities, TOURNAMENT_PERSISTENCE_JOURNAL,
  useTournamentPersistenceState, conservePrincipalTournamentCopy } from "./tournament-persistence";

const snapshot = { phase: "setup", config: { id: "category", categoryName: "Test" }, competitors: [], fights: [],
  groups: [], bracketMatches: [], bracketSeeds: [], currentFightIndex: 0, setupStarted: false };
const main = JSON.stringify({ version: 1, state: { ...snapshot, eventProfiles: { event: "yusan-2026" } } });
const registry = JSON.stringify({ version: 2, categories: { category: snapshot }, visibleCategoryIds: ["category"],
  selectedCategoryId: "category", draftCategoryId: null, draftReturnCategoryId: null });
beforeEach(() => { localStorage.clear(); useTournamentPersistenceState.setState({ blocked: false, message: null }); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it.each(["tkd-tournament", "tkd-tournament-categories", TOURNAMENT_PERSISTENCE_JOURNAL])("keeps pending data and blocks operations when writing %s fails", (key) => {
  localStorage.setItem("tkd-tournament", "old-main"); localStorage.setItem("tkd-tournament-categories", "old-registry");
  const original = Storage.prototype.setItem;
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, name, value) {
    if (name === key) throw new DOMException("quota", "QuotaExceededError"); original.call(this, name, value);
  });
  expect(commitTournamentAuthorities(main, registry)).toBe(false);
  expect(useTournamentPersistenceState.getState().blocked).toBe(true);
  if (key === TOURNAMENT_PERSISTENCE_JOURNAL) {
    expect(localStorage.getItem("tkd-tournament")).toBe("old-main");
    expect(localStorage.getItem("tkd-tournament-categories")).toBe("old-registry");
  }
  fail.mockRestore();
  expect(recoverTournamentAuthorities()).toBe(true);
  expect(localStorage.getItem("tkd-tournament")).toBe(main);
  expect(localStorage.getItem("tkd-tournament-categories")).toBe(registry);
  expect(localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL)).toBeNull();
  expect(useTournamentPersistenceState.getState().blocked).toBe(false);
});

it("replays a durable pending commit before hydration without trusting the stale registry", () => {
  localStorage.setItem("tkd-tournament-categories", "old-registry");
  localStorage.setItem(TOURNAMENT_PERSISTENCE_JOURNAL, JSON.stringify({ version: 1, main, registry }));
  expect(recoverTournamentAuthorities()).toBe(true);
  expect(localStorage.getItem("tkd-tournament")).toBe(main);
  expect(localStorage.getItem("tkd-tournament-categories")).toBe(registry);
});

it("retains its journal and blockade if marker cleanup fails", () => {
  const original = Storage.prototype.removeItem;
  const fail = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function(this: Storage, key) {
    if (key === TOURNAMENT_PERSISTENCE_JOURNAL) throw new Error("remove failure"); original.call(this, key);
  });
  expect(commitTournamentAuthorities(main, registry)).toBe(false);
  expect(localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL)).not.toBeNull();
  expect(useTournamentPersistenceState.getState().blocked).toBe(true);
  fail.mockRestore(); expect(recoverTournamentAuthorities()).toBe(true);
});

it("refuses corrupt, mismatched or retired identities without touching the authorities", () => {
  for (const raw of ["broken", JSON.stringify({ version: 1, main, registry, sql: "bad" }),
    JSON.stringify({ version: 1, main: main.replace('"id":"category"', '"id":"other"'), registry })]) {
    localStorage.setItem(TOURNAMENT_PERSISTENCE_JOURNAL, raw);
    expect(recoverTournamentAuthorities()).toBe(false);
    expect(localStorage.getItem("tkd-tournament")).toBeNull();
    expect(localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL)).toBe(raw);
  }
});

it("never overwrites another window's newer commit with an unsaved RAM draft", async () => {
  vi.resetModules();
  const current = await import("./tournament-persistence");
  const original = Storage.prototype.setItem;
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, name, value) {
    if (name === TOURNAMENT_PERSISTENCE_JOURNAL) throw new Error("full storage"); original.call(this, name, value);
  });
  expect(current.commitTournamentAuthorities(main, registry)).toBe(false);
  fail.mockRestore();
  localStorage.setItem("tkd-tournament", "newer-from-other-window");
  expect(current.recoverTournamentAuthorities()).toBe(false);
  expect(localStorage.getItem("tkd-tournament")).toBe("newer-from-other-window");
  // Retain RAM recovery, but restore the baseline in this isolated test for cleanup.
  localStorage.removeItem("tkd-tournament");
  expect(current.recoverTournamentAuthorities()).toBe(true);
});

it("keeps a readback failure pending, including backup's unfinished-operation guard", async () => {
  const original = Storage.prototype.getItem;
  const fail = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function(this: Storage, key) {
    const value = original.call(this, key);
    return key === "tkd-tournament-categories" && value === registry ? "different readback" : value;
  });
  expect(commitTournamentAuthorities(main, registry)).toBe(false);
  expect(useTournamentPersistenceState.getState().blocked).toBe(true);
  fail.mockRestore();
  const { assertBrowserIdle } = await import("./full-backup-browser");
  expect(() => assertBrowserIdle(localStorage)).toThrow("Unresolved");
  expect(recoverTournamentAuthorities()).toBe(true);
});

it("does not resurrect a deleted execution during cold recovery", () => {
  localStorage.setItem("tkd-category-deletions-v1", JSON.stringify([{ categoryId: "category", requestId: "delete", deletedAt: "2026-10-23" }]));
  localStorage.setItem(TOURNAMENT_PERSISTENCE_JOURNAL, JSON.stringify({ version: 1, main, registry }));
  expect(recoverTournamentAuthorities()).toBe(false);
  expect(localStorage.getItem("tkd-tournament")).toBeNull();
  expect(localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL)).not.toBeNull();
});

it("preserves divergent legacy authorities until explicit principal-copy confirmation", () => {
  const newer = JSON.stringify({ version: 1, state: { ...snapshot, competitors: [{ id: "a", name: "New" }] } });
  localStorage.setItem("tkd-tournament", newer); localStorage.setItem("tkd-tournament-categories", registry);
  expect(recoverTournamentAuthorities()).toBe(false);
  expect(useTournamentPersistenceState.getState().conflict?.summary).toContain("Copia principal: 1 competidores");
  expect(localStorage.getItem("tkd-tournament")).toBe(newer);
  expect(localStorage.getItem("tkd-tournament-categories")).toBe(registry);
  expect(recoverTournamentAuthorities()).toBe(false);
  expect(conservePrincipalTournamentCopy()).toBe(true);
  expect(JSON.parse(localStorage.getItem("tkd-tournament-categories")!).categories.category.competitors).toEqual([{ id: "a", name: "New" }]);
});

it("does not guess which copy belongs to the active category when IDs differ", () => {
  const different = registry.replaceAll('"category"', '"other"');
  localStorage.setItem("tkd-tournament", main); localStorage.setItem("tkd-tournament-categories", different);
  expect(recoverTournamentAuthorities()).toBe(false);
  expect(useTournamentPersistenceState.getState().conflict).toBeNull();
  expect(conservePrincipalTournamentCopy()).toBe(false);
  expect(localStorage.getItem("tkd-tournament")).toBe(main);
  expect(localStorage.getItem("tkd-tournament-categories")).toBe(different);
});
