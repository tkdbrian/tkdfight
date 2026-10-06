import type { MatchState, RuleSetSparring } from "@/engine/types";

export interface MatchInfo {
  id: string;
  categoryId?: string;
  ringId: string;
  category?: string;
  matchMode?: 'sparring' | 'patterns' | 'tul';
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

export interface RoundFlagResult {
  red: number;
  blue: number;
  winner: 'red' | 'blue' | 'draw';
}

export interface ServerState {
  rules: RuleSetSparring | null;
  match: MatchInfo | null;
  categoryId?: string | null;
  tournamentId?: number | null;
  activeMatchLock?: {
    fightId: string;
    categoryId: string | null;
    tournamentId: number;
    resultStatus: string | null;
  } | null;
  resultConfirmed?: boolean;
  legacyMatchAssociationWarning?: string | null;
  matchState: MatchState | null;
  matchPaused: boolean;
  judges: string[];
  judgeVotes: Record<string, string>;
  judgeTotals: Record<string, JudgeTotals>;
  penaltyCounts: PenaltyCounts;
  fallos: FalloEntry[];
  roundFlags: RoundFlagResult[];
  serverUrl: string;
  ringToken?: string;
  ringAlias?: string;
  ringName?: string;
  /** Fase de votación para modo Tul */
  tulPhase?: 'idle' | 'voting' | 'finished';
}
