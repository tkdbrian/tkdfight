import { create } from "zustand";
import type { RuleSet } from "@/engine/types";

export type TournamentPhase = "setup" | "fighting" | "results";

export interface CompetitorEntry {
  id: string;
  name: string;
  team?: string;
  weight?: number;
}

export interface FightEntry {
  id: string;
  red: CompetitorEntry;
  blue: CompetitorEntry;
  winner?: "red" | "blue" | "draw";
  winReason?: string;
  completed: boolean;
}

export interface TournamentConfig {
  categoryName: string;
  ruleSet: RuleSet | null;
  judgesCount: number;
}

interface TournamentState {
  phase: TournamentPhase;
  config: TournamentConfig;
  competitors: CompetitorEntry[];
  fights: FightEntry[];
  currentFightIndex: number;

  setPhase: (phase: TournamentPhase) => void;
  setConfig: (config: Partial<TournamentConfig>) => void;
  addCompetitor: (competitor: Omit<CompetitorEntry, "id">) => void;
  removeCompetitor: (id: string) => void;
  updateCompetitor: (id: string, data: Partial<Omit<CompetitorEntry, "id">>) => void;
  setFights: (fights: FightEntry[]) => void;
  setCurrentFightIndex: (index: number) => void;
  completeFight: (fightId: string, winner: "red" | "blue" | "draw", reason: string) => void;
  reset: () => void;
}

const initialConfig: TournamentConfig = {
  categoryName: "",
  ruleSet: null,
  judgesCount: 1,
};

export const useTournamentStore = create<TournamentState>((set) => ({
  phase: "setup",
  config: initialConfig,
  competitors: [],
  fights: [],
  currentFightIndex: 0,

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

  setCurrentFightIndex: (index) => set({ currentFightIndex: index }),

  completeFight: (fightId, winner, winReason) =>
    set((s) => ({
      fights: s.fights.map((f) =>
        f.id === fightId ? { ...f, winner, winReason, completed: true } : f
      ),
    })),

  reset: () =>
    set({
      phase: "setup",
      config: initialConfig,
      competitors: [],
      fights: [],
      currentFightIndex: 0,
    }),
}));
