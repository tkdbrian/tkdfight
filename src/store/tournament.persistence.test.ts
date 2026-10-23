import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); vi.resetModules(); });

it("recovers the exact edited category after a registry quota fault and a real module reload", async () => {
  localStorage.clear(); vi.resetModules();
  const first = await import("./tournament");
  first.useTournamentStore.getState().addCompetitor({ name: "A" });
  const native = Storage.prototype.setItem;
  const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
    if (key === "tkd-tournament-categories") throw new DOMException("quota", "QuotaExceededError");
    native.call(this, key, value);
  });
  first.useTournamentStore.getState().addCompetitor({ name: "B" });
  const guard = await import("@/lib/tournament-persistence");
  expect(guard.useTournamentPersistenceState.getState().blocked).toBe(true);
  expect(localStorage.getItem(guard.TOURNAMENT_PERSISTENCE_JOURNAL)).not.toBeNull();
  first.useTournamentStore.getState().addCompetitor({ name: "must not be accepted" });
  expect(first.useTournamentStore.getState().competitors.map((entry) => entry.name)).toEqual(["A", "B"]);
  failure.mockRestore(); vi.resetModules();
  const restored = await import("./tournament");
  await restored.useTournamentStore.persist.rehydrate();
  expect(restored.useTournamentStore.getState().competitors.map((entry) => entry.name)).toEqual(["A", "B"]);
  expect(localStorage.getItem(guard.TOURNAMENT_PERSISTENCE_JOURNAL)).toBeNull();
});

it("keeps RAM recovery and refuses category switching when even the journal cannot be saved", async () => {
  localStorage.clear(); vi.resetModules();
  const { useTournamentStore } = await import("./tournament");
  const guard = await import("@/lib/tournament-persistence");
  useTournamentStore.getState().addCompetitor({ name: "A" });
  const main = localStorage.getItem("tkd-tournament"); const registry = localStorage.getItem("tkd-tournament-categories");
  const native = Storage.prototype.setItem;
  const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
    if (key === guard.TOURNAMENT_PERSISTENCE_JOURNAL) throw new Error("full storage");
    native.call(this, key, value);
  });
  useTournamentStore.getState().addCompetitor({ name: "B" });
  expect(guard.useTournamentPersistenceState.getState().message).toContain("No cierres ni recargues");
  expect(localStorage.getItem("tkd-tournament")).toBe(main);
  expect(localStorage.getItem("tkd-tournament-categories")).toBe(registry);
  expect(useTournamentStore.getState().createCategory()).toBeNull();
  failure.mockRestore(); expect(guard.recoverTournamentAuthorities()).toBe(true);
  await useTournamentStore.persist.rehydrate();
  expect(useTournamentStore.getState().competitors.map((entry) => entry.name)).toEqual(["A", "B"]);
});

it("journals category navigation before publishing its new selection", async () => {
  localStorage.clear(); vi.resetModules();
  const { useTournamentStore } = await import("./tournament");
  const guard = await import("@/lib/tournament-persistence");
  const originalId = useTournamentStore.getState().config.id;
  useTournamentStore.getState().addCompetitor({ name: "Original" });
  const secondId = useTournamentStore.getState().createCategory();
  expect(secondId).toBeTruthy();
  const native = Storage.prototype.setItem;
  const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
    if (key === "tkd-tournament-categories") throw new Error("category fault"); native.call(this, key, value);
  });
  expect(useTournamentStore.getState().selectCategory(originalId)).toBe(false);
  expect(useTournamentStore.getState().config.id).toBe(secondId);
  expect(guard.useTournamentPersistenceState.getState().blocked).toBe(true);
  failure.mockRestore(); expect(guard.recoverTournamentAuthorities()).toBe(true);
  await useTournamentStore.persist.rehydrate();
  expect(useTournamentStore.getState().config.id).toBe(originalId);
  expect(useTournamentStore.getState().competitors[0].name).toBe("Original");
});

it("makes unreadable registry failures visible and preserves the RAM edit for retry", async () => {
  localStorage.clear(); vi.resetModules();
  const { useTournamentStore } = await import("./tournament");
  const guard = await import("@/lib/tournament-persistence");
  useTournamentStore.getState().addCompetitor({ name: "A" });
  const native = Storage.prototype.getItem;
  const failure = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function(this: Storage, key) {
    if (key === "tkd-tournament-categories") throw new Error("read fault"); return native.call(this, key);
  });
  useTournamentStore.getState().addCompetitor({ name: "B" });
  expect(guard.useTournamentPersistenceState.getState().blocked).toBe(true);
  expect(guard.recoverTournamentAuthorities()).toBe(false);
  failure.mockRestore();
  expect(guard.recoverTournamentAuthorities()).toBe(true);
  expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(true);
  await useTournamentStore.persist.rehydrate();
  expect(useTournamentStore.getState().competitors.map((entry) => entry.name)).toEqual(["A", "B"]);
});

it("preserves corrupt registry bytes and blocks edits instead of replacing them", async () => {
  localStorage.clear(); vi.resetModules();
  const { useTournamentStore } = await import("./tournament");
  const guard = await import("@/lib/tournament-persistence");
  localStorage.setItem("tkd-tournament-categories", "broken registry bytes");
  useTournamentStore.getState().addCompetitor({ name: "pending" });
  expect(guard.useTournamentPersistenceState.getState().blocked).toBe(true);
  expect(guard.recoverTournamentAuthorities()).toBe(false);
  expect(localStorage.getItem("tkd-tournament-categories")).toBe("broken registry bytes");
  const count = useTournamentStore.getState().competitors.length;
  useTournamentStore.getState().addCompetitor({ name: "blocked" });
  expect(useTournamentStore.getState().competitors).toHaveLength(count);
});
