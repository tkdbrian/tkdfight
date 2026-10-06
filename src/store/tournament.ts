import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { RuleSet } from "@/engine/types";

export type TournamentPhase = "setup" | "fighting" | "results";
export type TournamentMode = "round-robin" | "elimination" | "groups";

export interface CompetitorEntry {
  id: string;
  name: string;
  team?: string;
  weight?: number;
}

export interface TournamentGroup {
  id: string;
  competitors: CompetitorEntry[];
  size: number;
}

export interface FightEntry {
  id: string;
  red: CompetitorEntry;
  blue: CompetitorEntry;
  winner?: "red" | "blue" | "draw";
  winReason?: string;
  completed: boolean;
  // Groups / round-robin fields
  groupId?: string;
  flagsRed?: number;
  flagsBlue?: number;
  warningsRed?: number;
  warningsBlue?: number;
  foulsRed?: number;
  foulsBlue?: number;
  isTiebreakExtra?: boolean;
  tiebreakerSeconds?: number;
  isFinalFight?: boolean;
  isGoldenPointFight?: boolean;
  // Peleas reasignadas desde otro cuadrilátero (Mesa Central)
  importedFrom?: string;
  // Bracket fields
  bracketRound?: number;
  bracketPosition?: number;
  bracketMatchId?: string;
}

export interface BracketSlot {
  competitor: CompetitorEntry | null;
  fromMatchId?: string; // winner of this match advances here
}

export interface BracketMatch {
  id: string;
  round: number;
  position: number;
  red: BracketSlot;
  blue: BracketSlot;
  winnerId?: string;
  completed: boolean;
  fightId?: string; // linked FightEntry
  bracketGroup?: "A" | "B"; // double-bracket mode
}

export interface TournamentConfig {
  id: string;
  tournamentName: string;
  categoryName: string;
  tableChief: string;
  ruleSet: RuleSet | null;
  judgesCount: number;
  mode: TournamentMode;
  /** Disciplina: sparring convencional o Tul (formas, voto rojo/azul) */
  matchType: 'sparring' | 'tul';
  /** Rounds para la pelea final (si difiere de los rounds regulares) */
  finalRounds?: number;
  /** Duración en segundos del round final (si difiere del round regular) */
  finalSeconds?: number;
  /** Duración en segundos de cada combate de desempate */
  tiebreakerSeconds?: number;
  /** Cuántos combates de desempate se permiten antes del Punto de Oro */
  maxTiebreakers?: number;
}

interface TournamentState {
  phase: TournamentPhase;
  config: TournamentConfig;
  competitors: CompetitorEntry[];
  fights: FightEntry[];
  groups: TournamentGroup[];
  currentFightIndex: number;
  bracketMatches: BracketMatch[];
  bracketSeeds: (string | null)[];
  categoryRevision: number;
  categoryOperationReason: string | null;

  setCategoryOperationReason: (reason: string | null) => void;
  getCategoryEntries: () => TournamentCategoryEntry[];
  hasValidCategoryRegistry: () => boolean;
  createCategory: () => string | null;
  selectCategory: (categoryId: string) => boolean;
  hideCategory: (categoryId: string, fallbackCategoryId?: string) => boolean;
  reopenCategory: (categoryId: string) => boolean;
  cancelCategoryCreation: (categoryId: string) => boolean;
  restoreSavedCategorySelection: () => boolean;
  saveCategorySnapshot: () => boolean;
  restoreCategorySnapshot: (categoryId: string) => boolean;
  setPhase: (phase: TournamentPhase) => void;
  setConfig: (config: Partial<TournamentConfig>) => void;
  addCompetitor: (competitor: Omit<CompetitorEntry, "id">) => void;
  removeCompetitor: (id: string) => void;
  clearCompetitors: () => void;
  updateCompetitor: (id: string, data: Partial<Omit<CompetitorEntry, "id">>) => void;
  setFights: (fights: FightEntry[]) => void;
  appendFightAndSelect: (fight: FightEntry) => void;
  setGroups: (groups: TournamentGroup[]) => void;
  setCurrentFightIndex: (index: number) => void;
  completeFight: (fightId: string, winner: "red" | "blue" | "draw", reason: string, stats?: { flagsRed?: number; flagsBlue?: number; warningsRed?: number; warningsBlue?: number; foulsRed?: number; foulsBlue?: number }) => void;
  resetFight: (fightId: string) => void;
  setBracket: (matches: BracketMatch[], seeds: (string | null)[]) => void;
  updateBracketSeed: (position: number, competitorId: string | null) => void;
  addTiebreakFights: (fights: FightEntry[]) => void;
  addFinalFights: (fights: FightEntry[]) => void;
  addImportedFights: (fights: FightEntry[]) => void;
  addGuestFight: (redName: string, blueName: string, categoryName: string, originRing: string) => void;
  completeBracketMatch: (matchId: string, winnerId: string) => void;
  swapBracketSlots: (aMatchId: string, aSlot: "red" | "blue", bMatchId: string, bSlot: "red" | "blue") => void;
  postponeFight: (fightId: string) => void;
  setupStarted: boolean;
  setSetupStarted: (v: boolean) => void;
  reset: () => void;
}

export interface TournamentCategorySnapshot {
  phase: TournamentPhase;
  config: TournamentConfig;
  competitors: CompetitorEntry[];
  fights: FightEntry[];
  groups: TournamentGroup[];
  currentFightIndex: number;
  bracketMatches: BracketMatch[];
  bracketSeeds: (string | null)[];
  setupStarted: boolean;
}

interface TournamentCategoryRegistry {
  version: 2;
  categories: Record<string, TournamentCategorySnapshot>;
  visibleCategoryIds: string[];
  selectedCategoryId: string | null;
  draftCategoryId: string | null;
  draftReturnCategoryId: string | null;
}

export interface TournamentCategoryEntry {
  id: string;
  name: string;
  tournamentName: string;
  matchType?: "sparring" | "tul";
  mode?: TournamentMode;
  visible: boolean;
  isDraft: boolean;
  fightIds: string[];
}

export const TOURNAMENT_CATEGORY_STORAGE_KEY = "tkd-tournament-categories";

function createCategoryId(): string {
  return globalThis.crypto.randomUUID();
}

function cloneSnapshot(snapshot: TournamentCategorySnapshot): TournamentCategorySnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TournamentCategorySnapshot;
}

function isSnapshot(value: unknown, categoryId: string): value is TournamentCategorySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<TournamentCategorySnapshot>;
  return snapshot.config?.id === categoryId
    && (snapshot.phase === "setup" || snapshot.phase === "fighting" || snapshot.phase === "results")
    && Array.isArray(snapshot.competitors)
    && Array.isArray(snapshot.fights)
    && Array.isArray(snapshot.groups)
    && Array.isArray(snapshot.bracketMatches)
    && Array.isArray(snapshot.bracketSeeds)
    && Number.isInteger(snapshot.currentFightIndex)
    && typeof snapshot.setupStarted === "boolean";
}

function readCategoryRegistry(): TournamentCategoryRegistry | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    if (raw === null) {
      return {
        version: 2,
        categories: {},
        visibleCategoryIds: [],
        selectedCategoryId: null,
        draftCategoryId: null,
        draftReturnCategoryId: null,
      };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const registry = parsed as {
      version?: number;
      categories?: Record<string, TournamentCategorySnapshot>;
      visibleCategoryIds?: string[];
      selectedCategoryId?: string | null;
      draftCategoryId?: string | null;
      draftReturnCategoryId?: string | null;
    };
    if ((registry.version !== 1 && registry.version !== 2)
      || !registry.categories
      || typeof registry.categories !== "object"
      || Array.isArray(registry.categories)) return null;
    if (Object.entries(registry.categories).some(([id, snapshot]) => !isSnapshot(snapshot, id))) return null;
    const categoryIds = Object.keys(registry.categories);
    if (registry.version === 1) {
      return {
        version: 2,
        categories: registry.categories,
        visibleCategoryIds: categoryIds,
        selectedCategoryId: categoryIds[0] ?? null,
        draftCategoryId: null,
        draftReturnCategoryId: null,
      };
    }
    if (!Array.isArray(registry.visibleCategoryIds)
      || registry.visibleCategoryIds.some((id) => typeof id !== "string" || !registry.categories?.[id])
      || (registry.selectedCategoryId !== null && (typeof registry.selectedCategoryId !== "string" || !registry.categories[registry.selectedCategoryId] || !registry.visibleCategoryIds.includes(registry.selectedCategoryId)))
      || (registry.draftCategoryId !== null && (typeof registry.draftCategoryId !== "string" || !registry.categories[registry.draftCategoryId]))
      || (registry.draftReturnCategoryId !== null && (typeof registry.draftReturnCategoryId !== "string" || !registry.categories[registry.draftReturnCategoryId]))) return null;
    return registry as TournamentCategoryRegistry;
  } catch {
    return null;
  }
}

function writeCategoryRegistry(registry: TournamentCategoryRegistry): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(TOURNAMENT_CATEGORY_STORAGE_KEY, JSON.stringify(registry));
    return true;
  } catch {
    return false;
  }
}

function saveSnapshot(snapshot: TournamentCategorySnapshot): boolean {
  const registry = readCategoryRegistry();
  if (!registry) return false;
  if (!registry.categories[snapshot.config.id]) registry.visibleCategoryIds.push(snapshot.config.id);
  registry.categories[snapshot.config.id] = cloneSnapshot(snapshot);
  if (!registry.selectedCategoryId) registry.selectedCategoryId = snapshot.config.id;
  if (registry.draftCategoryId === snapshot.config.id && snapshot.phase !== "setup" && snapshot.fights.length > 0) {
    registry.draftCategoryId = null;
    registry.draftReturnCategoryId = null;
  }
  return writeCategoryRegistry(registry);
}

function categoryEntries(registry: TournamentCategoryRegistry): TournamentCategoryEntry[] {
  const visibleIds = new Set(registry.visibleCategoryIds);
  return Object.entries(registry.categories).map(([id, snapshot]) => ({
    id,
    name: snapshot.config.categoryName.trim() || "Nueva categoría",
    tournamentName: snapshot.config.tournamentName,
    matchType: snapshot.config.matchType ?? "sparring",
    mode: snapshot.config.mode ?? "round-robin",
    visible: visibleIds.has(id),
    isDraft: registry.draftCategoryId === id,
    fightIds: snapshot.fights.map((fight) => fight.id),
  }));
}

function getSnapshot(state: TournamentState): TournamentCategorySnapshot {
  return cloneSnapshot({
    phase: state.phase,
    config: state.config,
    competitors: state.competitors,
    fights: state.fights,
    groups: state.groups,
    currentFightIndex: state.currentFightIndex,
    bracketMatches: state.bracketMatches,
    bracketSeeds: state.bracketSeeds,
    setupStarted: state.setupStarted,
  });
}

const initialConfig: TournamentConfig = {
  id: createCategoryId(),
  tournamentName: "",
  categoryName: "",
  tableChief: "",
  ruleSet: null,
  judgesCount: 4,
  mode: "round-robin",
  matchType: "sparring",
};

export const useTournamentStore = create<TournamentState>()(persist((set, get) => ({
  phase: "setup",
  config: initialConfig,
  competitors: [],
  fights: [],
  groups: [],
  currentFightIndex: 0,
  setupStarted: false,
  bracketMatches: [],
  bracketSeeds: [],
  categoryRevision: 0,
  categoryOperationReason: null,

  getCategoryEntries: () => {
    const registry = readCategoryRegistry();
    return registry
      ? categoryEntries(registry)
      : [{
          id: get().config.id,
          name: get().config.categoryName.trim() || "Nueva categoría",
          tournamentName: get().config.tournamentName,
          matchType: get().config.matchType ?? "sparring",
          mode: get().config.mode ?? "round-robin",
          visible: true,
          isDraft: false,
          fightIds: get().fights.map((fight) => fight.id),
        }];
  },

  hasValidCategoryRegistry: () => readCategoryRegistry() !== null,

  createCategory: () => {
    const current = get();
    const registry = readCategoryRegistry();
    if (!registry) return null;
    registry.categories[current.config.id] = getSnapshot(current);
    if (!registry.visibleCategoryIds.includes(current.config.id)) {
      registry.visibleCategoryIds.push(current.config.id);
    }

    const categoryId = createCategoryId();
    const config = { ...current.config, id: categoryId, categoryName: "" };
    const snapshot: TournamentCategorySnapshot = {
      phase: "setup",
      config,
      competitors: [],
      fights: [],
      groups: [],
      currentFightIndex: 0,
      bracketMatches: [],
      bracketSeeds: [],
      setupStarted: true,
    };
    registry.categories[categoryId] = snapshot;
    registry.visibleCategoryIds.push(categoryId);
    registry.selectedCategoryId = categoryId;
    registry.draftCategoryId = categoryId;
    registry.draftReturnCategoryId = current.config.id;
    if (!writeCategoryRegistry(registry)) return null;
    set({ ...cloneSnapshot(snapshot), categoryRevision: current.categoryRevision + 1 });
    return categoryId;
  },

  selectCategory: (categoryId) => {
    const current = get();
    if (categoryId === current.config.id) return true;
    const registry = readCategoryRegistry();
    const snapshot = registry?.categories[categoryId];
    if (!registry || !snapshot || !registry.visibleCategoryIds.includes(categoryId) || !isSnapshot(snapshot, categoryId)) return false;
    registry.categories[current.config.id] = getSnapshot(current);
    if (!registry.visibleCategoryIds.includes(current.config.id)) {
      registry.visibleCategoryIds.push(current.config.id);
    }
    registry.selectedCategoryId = categoryId;
    if (!writeCategoryRegistry(registry)) return false;
    set({ ...cloneSnapshot(snapshot), categoryRevision: current.categoryRevision + 1 });
    return true;
  },

  hideCategory: (categoryId, fallbackCategoryId) => {
    const current = get();
    const registry = readCategoryRegistry();
    if (!registry || !registry.visibleCategoryIds.includes(categoryId) || registry.visibleCategoryIds.length <= 1) return false;
    const remainingIds = registry.visibleCategoryIds.filter((id) => id !== categoryId);
    const isSelected = current.config.id === categoryId;
    const nextId = isSelected
      ? (fallbackCategoryId && remainingIds.includes(fallbackCategoryId) ? fallbackCategoryId : remainingIds[0])
      : registry.selectedCategoryId;
    if (isSelected && !nextId) return false;
    const nextSnapshot = isSelected && nextId ? registry.categories[nextId] : undefined;
    if (isSelected && nextId && (!nextSnapshot || !isSnapshot(nextSnapshot, nextId))) return false;
    registry.categories[current.config.id] = getSnapshot(current);
    registry.visibleCategoryIds = remainingIds;
    if (isSelected && nextId) registry.selectedCategoryId = nextId;
    if (!writeCategoryRegistry(registry)) return false;
    if (isSelected && nextSnapshot) {
      set({ ...cloneSnapshot(nextSnapshot), categoryRevision: current.categoryRevision + 1 });
    } else {
      set({ categoryRevision: current.categoryRevision + 1 });
    }
    return true;
  },

  reopenCategory: (categoryId) => {
    const registry = readCategoryRegistry();
    if (!registry || !registry.categories[categoryId]) return false;
    if (registry.visibleCategoryIds.includes(categoryId)) return true;
    registry.visibleCategoryIds.push(categoryId);
    if (!writeCategoryRegistry(registry)) return false;
    set((current) => ({ categoryRevision: current.categoryRevision + 1 }));
    return true;
  },

  cancelCategoryCreation: (categoryId) => {
    const current = get();
    const registry = readCategoryRegistry();
    if (!registry || registry.draftCategoryId !== categoryId) return false;
    const returnId = registry.draftReturnCategoryId;
    delete registry.categories[categoryId];
    registry.visibleCategoryIds = registry.visibleCategoryIds.filter((id) => id !== categoryId);
    registry.draftCategoryId = null;
    registry.draftReturnCategoryId = null;
    const isSelected = current.config.id === categoryId;
    const fallbackId = returnId && registry.visibleCategoryIds.includes(returnId)
      ? returnId
      : registry.visibleCategoryIds[0];
    const fallback = isSelected && fallbackId ? registry.categories[fallbackId] : undefined;
    if (isSelected && (!fallback || !isSnapshot(fallback, fallbackId!))) return false;
    if (isSelected) registry.selectedCategoryId = fallbackId!;
    if (!writeCategoryRegistry(registry)) return false;
    if (isSelected && fallback) {
      set({ ...cloneSnapshot(fallback), categoryRevision: current.categoryRevision + 1 });
    } else {
      set({ categoryRevision: current.categoryRevision + 1 });
    }
    return true;
  },

  restoreSavedCategorySelection: () => {
    const current = get();
    const registry = readCategoryRegistry();
    const categoryId = registry?.selectedCategoryId;
    const snapshot = categoryId ? registry?.categories[categoryId] : undefined;
    if (!registry || !categoryId || !registry.visibleCategoryIds.includes(categoryId) || !snapshot || !isSnapshot(snapshot, categoryId)) return false;
    set({ ...cloneSnapshot(snapshot), categoryRevision: current.categoryRevision + 1 });
    return true;
  },

  setCategoryOperationReason: (categoryOperationReason) => set({ categoryOperationReason }),
  setPhase: (phase) => set({ phase }),
  setSetupStarted: (v) => set({ setupStarted: v }),

  setConfig: (config) =>
    set((s) => ({ config: { ...s.config, ...config } })),

  addCompetitor: (competitor) =>
    set((s) => ({
      competitors: [
        ...s.competitors,
        { ...competitor, id: crypto.randomUUID() },
      ],
    })),

  removeCompetitor: (id) =>
    set((s) => ({
      competitors: s.competitors.filter((c) => c.id !== id),
    })),

  clearCompetitors: () => set({ competitors: [] }),

  updateCompetitor: (id, data) =>
    set((s) => ({
      competitors: s.competitors.map((c) =>
        c.id === id ? { ...c, ...data } : c
      ),
    })),

  setFights: (fights) => set({ fights, currentFightIndex: 0 }),

  appendFightAndSelect: (fight) =>
    set((s) => ({ fights: [...s.fights, fight], currentFightIndex: s.fights.length })),

  setGroups: (groups) => set({ groups }),

  setCurrentFightIndex: (index) => set({ currentFightIndex: index }),

  completeFight: (fightId, winner, winReason, stats) =>
    set((s) => ({
      fights: s.fights.map((f) =>
        f.id === fightId ? { ...f, winner, winReason, completed: true, ...stats } : f
      ),
    })),

  resetFight: (fightId) =>
    set((s) => ({
      fights: s.fights.map((f) =>
        f.id === fightId
          ? { ...f, completed: false, winner: undefined, winReason: undefined, flagsRed: undefined, flagsBlue: undefined }
          : f
      ),
    })),

  setBracket: (bracketMatches, bracketSeeds) =>
    set({ bracketMatches, bracketSeeds }),

  updateBracketSeed: (position, competitorId) =>
    set((s) => {
      const seeds = [...s.bracketSeeds];
      seeds[position] = competitorId;
      return { bracketSeeds: seeds };
    }),

  addTiebreakFights: (newFights) =>
    set((s) => {
      const allFights = [...s.fights, ...newFights];
      const firstNew = allFights.indexOf(newFights[0]);
      return {
        fights: allFights,
        currentFightIndex: firstNew >= 0 ? firstNew : s.currentFightIndex,
      };
    }),

  addFinalFights: (newFights) =>
    set((s) => {
      const allFights = [...s.fights, ...newFights];
      const firstNew = allFights.indexOf(newFights[0]);
      return {
        fights: allFights,
        currentFightIndex: firstNew >= 0 ? firstNew : s.currentFightIndex,
      };
    }),

  // Peleas reasignadas desde otro tatami vía Mesa Central.
  // Solo agrega las que no existen todavía (por id) para evitar duplicados.
  addImportedFights: (newFights) =>
    set((s) => {
      const existingIds = new Set(s.fights.map((f) => f.id));
      const toAdd = newFights.filter((f) => !existingIds.has(f.id));
      if (toAdd.length === 0) return {};
      return { fights: [...s.fights, ...toAdd] };
    }),

  addGuestFight: (redName, blueName, categoryName, originRing) =>
    set((s) => {
      const slug = categoryName.trim().toLowerCase().replace(/\s+/g, "-");
      const fight: FightEntry = {
        id: crypto.randomUUID(),
        red: { id: crypto.randomUUID(), name: redName.trim() },
        blue: { id: crypto.randomUUID(), name: blueName.trim() },
        completed: false,
        groupId: `EXT:${slug}`,
        importedFrom: originRing.trim(),
      };
      return { fights: [...s.fights, fight] };
    }),

  completeBracketMatch: (matchId, winnerId) =>
    set((s) => {
      const matches = s.bracketMatches.map((m) => {
        if (m.id !== matchId) return m;
        return { ...m, winnerId, completed: true };
      });
      // Advance winner to next round
      const finished = matches.find((m) => m.id === matchId);
      if (!finished) return { bracketMatches: matches };
      const competitor = finished.red.competitor?.id === winnerId
        ? finished.red.competitor
        : finished.blue.competitor;
      if (!competitor) return { bracketMatches: matches };
      const advanced = matches.map((m) => {
        if (m.red.fromMatchId === matchId) return { ...m, red: { ...m.red, competitor } };
        if (m.blue.fromMatchId === matchId) return { ...m, blue: { ...m.blue, competitor } };
        return m;
      });
      return { bracketMatches: advanced };
    }),

  swapBracketSlots: (aMatchId, aSlot, bMatchId, bSlot) =>
    set((s) => {
      const matchA = s.bracketMatches.find((m) => m.id === aMatchId);
      const matchB = s.bracketMatches.find((m) => m.id === bMatchId);
      if (!matchA || !matchB) return {};
      const compA = aSlot === "red" ? matchA.red.competitor : matchA.blue.competitor;
      const compB = bSlot === "red" ? matchB.red.competitor : matchB.blue.competitor;
      if (aMatchId === bMatchId) {
        return {
          bracketMatches: s.bracketMatches.map((m) => {
            if (m.id !== aMatchId) return m;
            return {
              ...m,
              red: aSlot === "red"
                ? { ...m.red, competitor: compB }
                : bSlot === "red" ? { ...m.red, competitor: compA } : m.red,
              blue: aSlot === "blue"
                ? { ...m.blue, competitor: compB }
                : bSlot === "blue" ? { ...m.blue, competitor: compA } : m.blue,
            };
          }),
        };
      }
      return {
        bracketMatches: s.bracketMatches.map((m) => {
          if (m.id === aMatchId) {
            return aSlot === "red"
              ? { ...m, red: { ...m.red, competitor: compB } }
              : { ...m, blue: { ...m.blue, competitor: compB } };
          }
          if (m.id === bMatchId) {
            return bSlot === "red"
              ? { ...m, red: { ...m.red, competitor: compA } }
              : { ...m, blue: { ...m.blue, competitor: compA } };
          }
          return m;
        }),
      };
    }),

  // Mueve la pelea actual una posición hacia adelante intercambiándola
  // con la siguiente pelea no completada. currentFightIndex no cambia:
  // ahora apunta a la pelea que "subió" (la que era la siguiente).
  postponeFight: (fightId) =>
    set((s) => {
      const idx = s.fights.findIndex((f) => f.id === fightId);
      if (idx === -1) return {};
      const nextIdx = s.fights.findIndex((f, i) => i > idx && !f.completed);
      if (nextIdx === -1) return {};
      const newFights = [...s.fights];
      [newFights[idx], newFights[nextIdx]] = [newFights[nextIdx], newFights[idx]];
      return { fights: newFights };
    }),

  saveCategorySnapshot: () => saveSnapshot(getSnapshot(get())),

  restoreCategorySnapshot: (categoryId) => get().selectCategory(categoryId),

  reset: () => {
    const config = get().config;
    set({
      phase: "setup",
      config: { ...initialConfig, ...config, id: config.id, categoryName: "" },
      competitors: [],
      fights: [],
      groups: [],
      currentFightIndex: 0,
      bracketMatches: [],
      bracketSeeds: [],
      setupStarted: false,
    });
  },
}), {
  name: "tkd-tournament",
  version: 1,
  migrate: (persistedState) => {
    const persisted = (persistedState ?? {}) as Partial<TournamentState>;
    const config = { ...initialConfig, ...persisted.config };
    if (typeof config.id !== "string" || !config.id.trim()) config.id = createCategoryId();
    return { ...persisted, config };
  },
  merge: (persistedState, currentState) => {
    const persisted = (persistedState ?? {}) as Partial<TournamentState>;
    const config = { ...currentState.config, ...persisted.config };
    if (typeof config.id !== "string" || !config.id.trim()) config.id = createCategoryId();
    return { ...currentState, ...persisted, config, categoryOperationReason: null };
  },
  onRehydrateStorage: () => (state) => {
    if (!state?.restoreSavedCategorySelection()) state?.saveCategorySnapshot();
  },
}));

useTournamentStore.subscribe((state, previousState) => {
  if (state !== previousState) state.saveCategorySnapshot();
});

useTournamentStore.getState().saveCategorySnapshot();
