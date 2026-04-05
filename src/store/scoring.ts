import { create } from "zustand";
import type { MatchState } from "@/engine/types";

interface ScoringState {
  matchState: MatchState | null;
  connectedJudges: string[];
  timerRunning: boolean;
  timerInterval: ReturnType<typeof setInterval> | null;

  setMatchState: (state: MatchState | null) => void;
  updateMatchState: (partial: Partial<MatchState>) => void;
  setConnectedJudges: (judges: string[]) => void;
  setTimerRunning: (running: boolean) => void;
  tickTimer: () => void;
  reset: () => void;
}

export const useScoringStore = create<ScoringState>((set, get) => ({
  matchState: null,
  connectedJudges: [],
  timerRunning: false,
  timerInterval: null,

  setMatchState: (state) => set({ matchState: state }),

  updateMatchState: (partial) =>
    set((s) => ({
      matchState: s.matchState ? { ...s.matchState, ...partial } : null,
    })),

  setConnectedJudges: (judges) => set({ connectedJudges: judges }),

  setTimerRunning: (running) => set({ timerRunning: running }),

  tickTimer: () => {
    const { matchState } = get();
    if (!matchState) return;
    const newTime = Math.max(0, matchState.timeLeft - 1);
    set((s) => ({
      matchState: s.matchState ? { ...s.matchState, timeLeft: newTime } : null,
    }));
  },

  reset: () =>
    set({
      matchState: null,
      connectedJudges: [],
      timerRunning: false,
      timerInterval: null,
    }),
}));
