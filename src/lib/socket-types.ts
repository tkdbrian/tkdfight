import type { MatchState, RuleSetSparring } from "@/engine/types";

export interface MatchInfo {
  id: string;
  ringId: string;
  red: { id: string; name: string; club?: string };
  blue: { id: string; name: string; club?: string };
}

export interface JudgeTotals {
  red: number;
  blue: number;
  redFav: number;
  blueFav: number;
  redContra: number;
  blueContra: number;
}

export interface PenaltyCounts {
  warnings: { red: number; blue: number };
  fouls: { red: number; blue: number };
}

export interface FalloEntry {
  id: number;
  time: string;
  redName: string;
  blueName: string;
  redScore: number;
  blueScore: number;
  winner: string;
}

export interface ServerState {
  rules: RuleSetSparring | null;
  match: MatchInfo | null;
  matchState: MatchState | null;
  matchPaused: boolean;
  judges: string[];
  judgeVotes: Record<string, string>;
  judgeTotals: Record<string, JudgeTotals>;
  penaltyCounts: PenaltyCounts;
  fallos: FalloEntry[];
  serverUrl: string;
}
