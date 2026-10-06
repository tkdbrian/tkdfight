import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOURNAMENT_CATEGORY_STORAGE_KEY,
  useTournamentStore,
  type BracketMatch,
  type FightEntry,
} from "./tournament";

const initialState = useTournamentStore.getState();

afterEach(() => {
  useTournamentStore.setState(initialState, true);
  localStorage.removeItem("tkd-tournament");
  localStorage.removeItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
});

describe("swapBracketSlots", () => {
  it("swaps competitors between two slots in the same match", () => {
    const match: BracketMatch = {
      id: "match-1",
      round: 0,
      position: 0,
      red: { competitor: { id: "red-id", name: "Rojo" } },
      blue: { competitor: { id: "blue-id", name: "Azul" } },
      completed: false,
    };
    useTournamentStore.setState({ bracketMatches: [match] });

    useTournamentStore.getState().swapBracketSlots("match-1", "red", "match-1", "blue");

    const [updated] = useTournamentStore.getState().bracketMatches;
    expect(updated.red.competitor?.id).toBe("blue-id");
    expect(updated.blue.competitor?.id).toBe("red-id");
  });
});

describe("category snapshots", () => {
  it("migrates a legacy config and keeps its id across two store restarts", async () => {
    localStorage.setItem("tkd-tournament", JSON.stringify({
      state: {
        phase: "fighting",
        config: {
          tournamentName: "Torneo legado",
          categoryName: "Adultos",
          tableChief: "Mesa 1",
          ruleSet: null,
          judgesCount: 4,
          mode: "round-robin",
          matchType: "sparring",
        },
        competitors: [{ id: "legacy-athlete", name: "Competidor legado" }],
        fights: [],
        groups: [],
        currentFightIndex: 0,
        bracketMatches: [],
        bracketSeeds: [],
        setupStarted: true,
      },
      version: 0,
    }));

    await useTournamentStore.persist.rehydrate();
    const migratedId = useTournamentStore.getState().config.id;
    expect(migratedId).toBeTruthy();
    expect(useTournamentStore.getState().config.tournamentName).toBe("Torneo legado");
    expect(useTournamentStore.getState().competitors[0].id).toBe("legacy-athlete");

    vi.resetModules();
    const firstRestart = await import("./tournament");
    await firstRestart.useTournamentStore.persist.rehydrate();
    expect(firstRestart.useTournamentStore.getState().config.id).toBe(migratedId);

    vi.resetModules();
    const secondRestart = await import("./tournament");
    await secondRestart.useTournamentStore.persist.rehydrate();
    expect(secondRestart.useTournamentStore.getState().config.id).toBe(migratedId);
  });

  it("normalizes a missing id in current-version persisted state", async () => {
    localStorage.setItem("tkd-tournament", JSON.stringify({
      state: {
        config: {
          tournamentName: "Torneo actual",
          categoryName: "Juveniles",
          tableChief: "Mesa 2",
          ruleSet: null,
          judgesCount: 4,
          mode: "round-robin",
          matchType: "sparring",
        },
      },
      version: 1,
    }));

    await useTournamentStore.persist.rehydrate();
    const normalizedId = useTournamentStore.getState().config.id;
    expect(normalizedId).toBeTruthy();

    await useTournamentStore.persist.rehydrate();
    expect(useTournamentStore.getState().config.id).toBe(normalizedId);
  });

  it("creates an independent category and returns to A with its completed key intact", () => {
    const store = useTournamentStore.getState();
    const fightA: FightEntry = {
      id: "fight-a",
      red: { id: "red-a", name: "Rojo A" },
      blue: { id: "blue-a", name: "Azul A" },
      completed: false,
    };
    useTournamentStore.setState({
      phase: "fighting",
      config: { ...store.config, id: "category-a", categoryName: "Adultos", tournamentName: "Copa" },
      competitors: [fightA.red, fightA.blue],
      fights: [fightA],
      setupStarted: true,
    });
    useTournamentStore.getState().completeFight("fight-a", "red", "points", { flagsRed: 3, flagsBlue: 1 });

    const categoryB = useTournamentStore.getState().createCategory();
    expect(categoryB).toBeTruthy();
    expect(categoryB).not.toBe("category-a");
    expect(useTournamentStore.getState().competitors).toEqual([]);
    expect(useTournamentStore.getState().fights).toEqual([]);
    useTournamentStore.getState().setConfig({ categoryName: "Adultos" });

    expect(useTournamentStore.getState().selectCategory("category-a")).toBe(true);
    expect(useTournamentStore.getState().config.categoryName).toBe("Adultos");
    expect(useTournamentStore.getState().fights[0]).toMatchObject({
      id: "fight-a",
      completed: true,
      winner: "red",
      flagsRed: 3,
      flagsBlue: 1,
    });
    expect(useTournamentStore.getState().getCategoryEntries().filter((entry) => entry.name === "Adultos")).toHaveLength(2);
  });

  it("persists selection across rehydration and hides/reopens without deleting progress", async () => {
    const store = useTournamentStore.getState();
    useTournamentStore.setState({
      config: { ...store.config, id: "category-a", categoryName: "Adultos" },
      competitors: [{ id: "athlete-a", name: "Atleta A" }],
    });
    useTournamentStore.getState().saveCategorySnapshot();
    const categoryB = useTournamentStore.getState().createCategory();
    expect(categoryB).toBeTruthy();
    useTournamentStore.getState().setConfig({ categoryName: "Adultos" });

    expect(useTournamentStore.getState().hideCategory(categoryB!, "category-a")).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe("category-a");
    expect(useTournamentStore.getState().getCategoryEntries().find((entry) => entry.id === categoryB)?.visible).toBe(false);
    expect(useTournamentStore.getState().reopenCategory(categoryB!)).toBe(true);
    expect(useTournamentStore.getState().getCategoryEntries().filter((entry) => entry.visible)).toHaveLength(2);

    vi.resetModules();
    const restarted = await import("./tournament");
    await restarted.useTournamentStore.persist.rehydrate();
    expect(restarted.useTournamentStore.getState().config.id).toBe("category-a");
    expect(restarted.useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id)).toContain(categoryB);
    expect(restarted.useTournamentStore.getState().getCategoryEntries().filter((entry) => entry.name === "Adultos")).toHaveLength(2);
  });

  it("cancels a new category without changing the previous category", () => {
    const store = useTournamentStore.getState();
    useTournamentStore.setState({
      config: { ...store.config, id: "category-a", categoryName: "Adultos" },
      competitors: [{ id: "athlete-a", name: "Atleta A" }],
    });
    useTournamentStore.getState().saveCategorySnapshot();
    const categoryB = useTournamentStore.getState().createCategory();
    expect(categoryB).toBeTruthy();
    useTournamentStore.getState().addCompetitor({ name: "Borrador B" });

    expect(useTournamentStore.getState().cancelCategoryCreation(categoryB!)).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe("category-a");
    expect(useTournamentStore.getState().competitors).toEqual([{ id: "athlete-a", name: "Atleta A" }]);
    expect(useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id)).toEqual(["category-a"]);
  });

  it("does not hide the only visible category or duplicate an existing category", () => {
    const store = useTournamentStore.getState();
    useTournamentStore.setState({ config: { ...store.config, id: "category-a", categoryName: "Adultos" } });
    useTournamentStore.getState().saveCategorySnapshot();

    expect(useTournamentStore.getState().hideCategory("category-a")).toBe(false);
    expect(useTournamentStore.getState().selectCategory("category-a")).toBe(true);
    expect(useTournamentStore.getState().getCategoryEntries()).toHaveLength(1);
  });

  it("creates a snapshot when the sidecar is absent", () => {
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBeNull();
    useTournamentStore.setState({
      config: { ...useTournamentStore.getState().config, id: "category-a" },
      competitors: [{ id: "athlete-a", name: "Atleta A" }],
    });

    expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(true);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toContain("category-a");
  });

  it("does not overwrite a corrupt sidecar", () => {
    const corruptRaw = "{invalid-json";
    localStorage.setItem(TOURNAMENT_CATEGORY_STORAGE_KEY, corruptRaw);

    expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(false);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(corruptRaw);
  });

  it("restores isolated A and B snapshots and keeps snapshots detached", () => {
    const competitorsA = [{ id: "athlete-a", name: "Atleta A" }];
    const fightA: FightEntry = {
      id: "fight-a",
      red: competitorsA[0],
      blue: { id: "opponent-a", name: "Rival A" },
      completed: false,
    };
    useTournamentStore.setState({
      phase: "fighting",
      config: { ...useTournamentStore.getState().config, id: "category-a" },
      competitors: competitorsA,
      fights: [fightA],
    });
    competitorsA[0].name = "Mutado fuera del store";

    useTournamentStore.setState({
      config: { ...useTournamentStore.getState().config, id: "category-b" },
      competitors: [{ id: "athlete-b", name: "Atleta B" }],
      fights: [],
    });

    expect(useTournamentStore.getState().restoreCategorySnapshot("category-a")).toBe(true);
    expect(useTournamentStore.getState().competitors[0].name).toBe("Atleta A");
    useTournamentStore.getState().completeFight("fight-a", "red", "decision");
    expect(useTournamentStore.getState().fights[0].completed).toBe(true);

    expect(useTournamentStore.getState().restoreCategorySnapshot("category-b")).toBe(true);
    expect(useTournamentStore.getState().competitors[0].name).toBe("Atleta B");
    expect(useTournamentStore.getState().fights).toHaveLength(0);
  });
});