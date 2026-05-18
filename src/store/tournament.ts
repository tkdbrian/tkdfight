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
  isTiebreakExtra?: boolean;
  isFinalFight?: boolean;
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
  categoryName: string;
  tableChief: string;
  ruleSet: RuleSet | null;
  judgesCount: number;
  mode: TournamentMode;
  /** Disciplina: sparring convencional o Tul (formas, voto rojo/azul) */
  matchType: 'sparring' | 'tul';
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

  setPhase: (phase: TournamentPhase) => void;
  setConfig: (config: Partial<TournamentConfig>) => void;
  addCompetitor: (competitor: Omit<CompetitorEntry, "id">) => void;
  removeCompetitor: (id: string) => void;
  updateCompetitor: (id: string, data: Partial<Omit<CompetitorEntry, "id">>) => void;
  setFights: (fights: FightEntry[]) => void;
  setGroups: (groups: TournamentGroup[]) => void;
  setCurrentFightIndex: (index: number) => void;
  completeFight: (fightId: string, winner: "red" | "blue" | "draw", reason: string, flagsRed?: number, flagsBlue?: number) => void;
  setBracket: (matches: BracketMatch[], seeds: (string | null)[]) => void;
  updateBracketSeed: (position: number, competitorId: string | null) => void;
  addTiebreakFights: (fights: FightEntry[]) => void;
  addFinalFights: (fights: FightEntry[]) => void;
  addImportedFights: (fights: FightEntry[]) => void;
  completeBracketMatch: (matchId: string, winnerId: string) => void;
  swapBracketSlots: (aMatchId: string, aSlot: "red" | "blue", bMatchId: string, bSlot: "red" | "blue") => void;
  reset: () => void;
}

const initialConfig: TournamentConfig = {
  categoryName: "",
  tableChief: "",
  ruleSet: null,
  judgesCount: 4,
  mode: "round-robin",
  matchType: "sparring",
};

export const useTournamentStore = create<TournamentState>()(persist((set) => ({
  phase: "setup",
  config: initialConfig,
  competitors: [],
  fights: [],
  groups: [],
  currentFightIndex: 0,
  bracketMatches: [],
  bracketSeeds: [],

  setPhase: (phase) => set({ phase }),

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

  updateCompetitor: (id, data) =>
    set((s) => ({
      competitors: s.competitors.map((c) =>
        c.id === id ? { ...c, ...data } : c
      ),
    })),

  setFights: (fights) => set({ fights, currentFightIndex: 0 }),

  setGroups: (groups) => set({ groups }),

  setCurrentFightIndex: (index) => set({ currentFightIndex: index }),

  completeFight: (fightId, winner, winReason, flagsRed, flagsBlue) =>
    set((s) => ({
      fights: s.fights.map((f) =>
        f.id === fightId ? { ...f, winner, winReason, completed: true, flagsRed, flagsBlue } : f
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

  reset: () =>
    set({
      phase: "setup",
      config: initialConfig,
      competitors: [],
      fights: [],
      currentFightIndex: 0,
      bracketMatches: [],
      bracketSeeds: [],
    }),
}), { name: "tkd-tournament" }));
