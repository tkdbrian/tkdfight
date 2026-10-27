import type { MatchState, RuleSetSparring } from "@/engine/types";
import type { FlagRound } from "@/engine/desk-operations";
import type { CompetitorEntry, TournamentCategorySnapshot, TournamentConfig } from "@/store/tournament";

export interface DemoActiveMatch {
  categoryId: string;
  fightId: string;
  red: CompetitorEntry;
  blue: CompetitorEntry;
  rules: RuleSetSparring;
  state: MatchState;
  paused: boolean;
  started: boolean;
  /** A new loadId fences stale UI commands even when a fight is reloaded. */
  loadId: string;
  assignmentRevision: number;
  judgeVotes: Record<string, "red" | "blue" | "draw">;
  roundFlags: FlagRound[];
  tulPhase: "idle" | "voting" | "finished";
  resultConfirmed: boolean;
}

export interface DemoHistoryEntry {
  id: string;
  categoryId: string;
  fightId: string;
  confirmedAt: string;
  red: CompetitorEntry;
  blue: CompetitorEntry;
  winner: "red" | "blue" | "draw";
  reason: string;
  flagsRed: number;
  flagsBlue: number;
  warningsRed: number;
  warningsBlue: number;
  foulsRed: number;
  foulsBlue: number;
}

/** The complete local authority; no legacy localStorage or remote SQL source. */
export interface DemoDeskState {
  version: 1;
  eventId: string;
  tournamentName: string;
  categories: Record<string, TournamentCategorySnapshot>;
  /** Previous executions kept intact after Archive and restart. */
  archives: Record<string, TournamentCategorySnapshot>;
  categoryOrder: string[];
  selectedCategoryId: string | null;
  active: DemoActiveMatch | null;
  history: DemoHistoryEntry[];
}

export type DemoDeskCommand =
  | { type: "category/create"; categoryId?: string }
  | { type: "category/select"; categoryId: string }
  | { type: "category/configure"; categoryId: string; patch: Partial<TournamentConfig> }
  | { type: "category/addCompetitor"; categoryId: string; competitor: Omit<CompetitorEntry, "id">; competitorId?: string }
  | { type: "category/updateCompetitor"; categoryId: string; competitorId: string; patch: Partial<Omit<CompetitorEntry, "id">> }
  | { type: "category/removeCompetitor"; categoryId: string; competitorId: string }
  | { type: "category/start"; categoryId: string }
  | { type: "category/prepareNext"; categoryId: string }
  | { type: "category/preparePlayoff"; categoryId: string; groupId: string }
  | { type: "category/prepareFinal"; categoryId: string }
  | { type: "category/swapBracketSlots"; categoryId: string; aMatchId: string;
      aSlot: "red" | "blue"; bMatchId: string; bSlot: "red" | "blue" }
  | { type: "category/addGuestFight"; categoryId: string; redName: string;
      blueName: string; categoryName: string; originRing: string }
  | { type: "category/delete"; categoryId: string; confirm: true }
  | { type: "category/restart"; categoryId: string;
      mode: "archive" | "delete-and-restart"; confirm: true }
  | { type: "fight/select"; categoryId: string; fightId: string }
  | { type: "fight/load"; categoryId: string; fightId: string }
  | { type: "fight/swap"; categoryId: string; fightId: string; loadId: string; assignmentRevision: number; expectedRedId: string; expectedBlueId: string }
  | { type: "fight/postpone"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/start"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/pause"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/resume"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/tick"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/adjustTimer"; categoryId: string; fightId: string; loadId: string; seconds: number }
  | { type: "fight/skipToFlags"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/finishRound"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/vote"; categoryId: string; fightId: string; loadId: string; judgeId: string; vote: "red" | "blue" | "draw" }
  | { type: "fight/confirmRound"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/undoRound"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/event"; categoryId: string; fightId: string; loadId: string; judgeId: string; competitor: "red" | "blue"; eventType: string }
  | { type: "fight/undo"; categoryId: string; fightId: string; loadId: string; judgeId?: string }
  | { type: "fight/dq"; categoryId: string; fightId: string; loadId: string; competitor: "red" | "blue" }
  | { type: "fight/medical"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/reset"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/setSanction"; categoryId: string; fightId: string; loadId: string; competitor: "red" | "blue"; kind: "warning" | "minus_point"; expectedCount: number; count: number }
  | { type: "fight/confirmPenalties"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/resolveJury"; categoryId: string; fightId: string; loadId: string; winner: "red" | "blue" }
  | { type: "fight/goldenVote"; categoryId: string; fightId: string; loadId: string; judgeId: string; competitor: "red" | "blue"; attempt: number }
  | { type: "fight/confirmGolden"; categoryId: string; fightId: string; loadId: string; attempt: number }
  | { type: "fight/tulFinish"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/tulRetry"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/tulUndoFinish"; categoryId: string; fightId: string; loadId: string }
  | { type: "fight/continueDraw"; categoryId: string; fightId: string }
  | { type: "fight/confirmResult"; categoryId: string; fightId: string; loadId: string };

export type DemoRuntimeErrorCode = "invalid" | "stale" | "wrong-phase" | "locked" | "not-found";

export class DemoRuntimeError extends Error {
  constructor(readonly code: DemoRuntimeErrorCode, message: string) {
    super(message);
    this.name = "DemoRuntimeError";
  }
}
