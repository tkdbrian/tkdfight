import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("defaults fresh and newly created categories to rest-optimized ordering", async () => {
  localStorage.clear();
  vi.resetModules();
  const { useTournamentStore } = await import("./tournament");
  expect(useTournamentStore.getState().config.rrOrderMode).toBe("rest-optimized");
  useTournamentStore.getState().addCompetitor({ name: "Starter" });
  expect(useTournamentStore.getState().createCategory()).not.toBeNull();
  expect(useTournamentStore.getState().config.rrOrderMode).toBe("rest-optimized");
});

it("hydrates an old category with no policy as group blocks without touching its saved fights", async () => {
  localStorage.clear();
  vi.resetModules();
  const oldFight = {
    id: "old-fight",
    red: { id: "a", name: "A" },
    blue: { id: "b", name: "B" },
    completed: false,
    groupId: "G1",
  };
  localStorage.setItem(
    "tkd-tournament",
    JSON.stringify({
      version: 1,
      state: {
        config: {
          id: "old-category",
          tournamentName: "Old",
          categoryName: "Old category",
          tableChief: "",
          ruleSet: null,
          judgesCount: 4,
          mode: "round-robin",
          matchType: "sparring",
        },
        fights: [oldFight],
      },
    })
  );
  const { useTournamentStore } = await import("./tournament");
  await useTournamentStore.persist.rehydrate();
  expect(useTournamentStore.getState().config.rrOrderMode).toBe("group-blocks");
  expect(useTournamentStore.getState().fights).toEqual([oldFight]);
});
