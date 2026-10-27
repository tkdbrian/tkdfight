import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { useCategoryInteractionBlocked } from "@/hooks/useCategoryInteractionBlocked";
import { categoryRestartInteractionBlocked } from "@/store/category-restart-state";
import { categoryExecutionUnavailable } from "@/lib/category-deletion-persistence";
import { useTournamentStore } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { getFightPageEntry } from "@/lib/fight-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  Wifi,
  WifiOff,
  UserX,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Trophy,
  ExternalLink,
  Keyboard,
  Smartphone,
  Users,
  Check,
  List,
  Zap,
} from "lucide-react";
import {
  PHASE_LABELS,
  WIN_REASON_LABELS,
  formatTime,
} from "@/lib/fight-utils";
import { cn } from "@/lib/utils";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import type { MatchInfo, PenaltyCounts, ServerState } from "@/lib/socket-types";
import type { MatchSwapReply, MatchSwapRequest } from "@/lib/match-swap-contract";
import { markLocalSwapPending } from "@/lib/match-swap-pending";
import type { FightEntry, TournamentMode } from "@/store/tournament";
import {
  applyFightTiming,
  withoutRegularRoundRobinTiebreak,
} from "@/lib/fight-timing";
import { PreFightSettings } from "@/components/PreFightSettings";
import { applyPreFightSettings, preFightTimingKind } from "@/lib/pre-fight-settings";
import { isMiniRoundRobinBout } from "@/lib/round-robin-playoff";
import { closedGroupBasis, isAuthorizedPlayoffFight, nextDirectFightIsGoldenPoint } from "@/lib/round-robin-resolution";
import { getCanonicalEliminationContinuation, syncProposedFights } from "@/lib/sync-proposed-fights";
import { clearFightProposal, getOrCreateFightProposal } from "@/lib/pending-fight-proposals";
import { eliminationContinuationSchema } from "@/lib/elimination-continuation-contract";
import { describeFightLock, type BlockedFightInfo } from "@/lib/pending-fight-lock";
import {
  findRoundRobinRestAdvisory,
  parseLastConfirmedRestReply,
  restReadKey,
  type LastConfirmedRestRead,
  type RoundRobinRestAdvisory,
} from "@/lib/rr-rest-advisory";

const DEFAULT_RULES = itfRules as RuleSetSparring;

/** Each bout that contributes flags to a Round Robin table needs real individual votes. */
export function requiresIndividualFlagsForBout(mode: TournamentMode, fight: FightEntry): boolean {
  if (mode === "elimination" || fight.isGoldenPointFight || fight.importedFrom ||
    fight.groupId?.startsWith("EXT:")) return false;
  if (fight.playoffKind === "mini") return true;
  return !fight.isFinalFight && !fight.isTiebreakExtra;
}
const MATCH_CONTEXT_EVENTS = new Set([
  "match:start", "match:event", "match:finishRound", "match:confirmPenalties",
  "match:resolveJury", "match:reset", "judge:vote", "match:undo",
  "match:undoArbiter", "match:pause", "match:resume", "match:dq",
  "match:medical", "match:saveFallo", "timer:addSeconds",
  "match:skipToFlags", "mesa:flagVote", "mesa:confirmRound",
  "mesa:undoRound", "mesa:goldenVote", "mesa:confirmGoldenOutcome", "tul:finish", "tul:undoFinish", "tul:reset",
  "mesa:setSanctionCount",
]);

export function withMatchContext(
  event: string,
  data: unknown,
  categoryId: string,
  matchId: string,
  preFight?: MatchInfo["preFight"],
): unknown {
  if (!MATCH_CONTEXT_EVENTS.has(event)) return data;
  const payload = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  return { ...payload, categoryId, matchId,
    ...(preFight && (preFight.swapCount ?? 0) > 0 ? {
      expectedLoadId: preFight.loadId,
      expectedAssignmentRevision: preFight.revision,
    } : {}),
  };
}

export function hasReopenedFlagUpdate(
  next: ServerState,
  categoryId: string,
  matchId: string,
  expectedRevision: number,
): boolean {
  return next.categoryId === categoryId && next.match?.id === matchId &&
    next.resultRevision === expectedRevision && !next.resultConfirmed &&
    next.matchState?.phase === "rest" && next.matchState.result === null;
}

export function hasConfirmedGoldenOutcomeUpdate(
  next: ServerState,
  categoryId: string,
  matchId: string,
  attempt: number,
  winner: "red" | "blue" | null,
): boolean {
  if (next.categoryId !== categoryId || next.match?.id !== matchId) return false;
  if (winner) {
    return next.matchState?.phase === "finished" && next.matchState.result?.winner === winner;
  }
  // Another table-chief client may already have recorded votes in the next attempt.
  return next.matchState?.phase === "golden_point" &&
    next.matchState.goldenPoint?.attempt === attempt + 1;
}

interface MatchResultRecord {
  fightId: string;
  categoryId: string;
  winner: "red" | "blue" | "draw";
  reason: string;
  flagsRed: number;
  flagsBlue: number;
  warningsRed: number;
  warningsBlue: number;
  foulsRed: number;
  foulsBlue: number;
  status: "pending_confirmation" | "confirmed";
  revision?: number;
}

interface MatchResultReply {
  ok: boolean;
  error?: string;
  result: MatchResultRecord | null;
  redId?: string;
  blueId?: string;
}

function fightColorsMatch(fight: FightEntry | undefined, match: MatchInfo | null): boolean {
  return !!fight && !!match && fight.red.id === match.red.id && fight.blue.id === match.blue.id;
}

function untouchedPreStart(state: ServerState): boolean {
  const matchState = state.matchState;
  return state.match?.matchMode === "sparring" && !!state.match.preFight?.loadId &&
    !state.match.preFight.started && state.match.preFight.timingKind !== "continuation" &&
    !state.match.goldenPoint && matchState?.phase === "idle" && !state.matchPaused &&
    !state.resultConfirmed && matchState.firstPoint === null && matchState.result === null &&
    matchState.rounds.every((round) => round.events.length === 0) &&
    (state.roundFlags?.length ?? 0) === 0 && Object.keys(state.judgeVotes ?? {}).length === 0 &&
    state.penaltyCounts.warnings.red === 0 && state.penaltyCounts.warnings.blue === 0 &&
    state.penaltyCounts.fouls.red === 0 && state.penaltyCounts.fouls.blue === 0;
}

interface GoldenActionReply {
  ok: boolean;
  code?: string;
  error?: string;
  attempt?: number;
}

interface MatchLoadReply extends Partial<BlockedFightInfo> {
  ok: boolean;
  error?: string;
  warning?: string;
}

interface RestPrompt {
  categoryId: string;
  fightId: string;
  read: LastConfirmedRestRead;
  advisory: RoundRobinRestAdvisory;
}

function competitorNameInFights(fights: readonly FightEntry[], id: string): string {
  for (const fight of fights) {
    if (fight.red.id === id) return fight.red.name;
    if (fight.blue.id === id) return fight.blue.name;
  }
  return id;
}

type SanctionSide = "red" | "blue";
type SanctionKind = "warning" | "minus_point";

interface SanctionActionReply {
  ok: boolean;
  code?: string;
  error?: string;
  counts?: PenaltyCounts;
  pendingResult?: MatchResultRecord | null;
  alreadyApplied?: boolean;
}

function sanctionCount(counts: PenaltyCounts, side: SanctionSide, kind: SanctionKind): number {
  return kind === "warning" ? counts.warnings[side] : counts.fouls[side];
}

export function scoreSanctionEventType(kind: SanctionKind, delta: -1 | 1): string {
  if (kind === "warning") return delta === 1 ? "warning_minor" : "remove_warning";
  return delta === 1 ? "minus_point" : "remove_minus_point";
}

export function dispatchScoreSanctionAction(
  side: SanctionSide,
  kind: SanctionKind,
  delta: -1 | 1,
  live: boolean,
  review: boolean,
  emitLive: (side: SanctionSide, eventType: string) => void,
  editPostClock: (side: SanctionSide, kind: SanctionKind, delta: -1 | 1) => void,
): void {
  if (live) emitLive(side, scoreSanctionEventType(kind, delta));
  else if (review) editPostClock(side, kind, delta);
}

export function hasSanctionCountUpdate(
  next: ServerState,
  categoryId: string,
  matchId: string,
  side: SanctionSide,
  kind: SanctionKind,
  count: number,
): boolean {
  return next.categoryId === categoryId && next.match?.id === matchId &&
    sanctionCount(next.penaltyCounts, side, kind) === count;
}

export function canReviewPostClockSanctions(phase: string, resultReason?: string | null): boolean {
  if (phase === "rest" || phase === "penalties") return true;
  return phase === "finished" && resultReason != null &&
    resultReason !== "golden_point" && resultReason !== "dq";
}

function judgesLabel(count: number): string {
  return count === 1 ? "1 juez" : `${count} jueces`;
}

function timerClass(timeLeft: number, isRunning: boolean, matchPaused: boolean): string {
  if (timeLeft <= 10 && isRunning && !matchPaused) return "text-red-400 text-5xl sm:text-7xl xl:text-9xl";
  return "text-5xl sm:text-7xl xl:text-9xl";
}

function showPauseBadge(matchPaused: boolean, phase: string): boolean {
  return matchPaused && phase !== "idle" && phase !== "finished";
}

function roundSuffix(phase: string, currentRound: number): string {
  if (phase === "round" || phase === "rest") return ` · R${currentRound}`;
  return "";
}

type FlagSide = "red" | "blue" | "draw";

function flagLabel(side: FlagSide): string {
  if (side === "red") return "🔴 Rojo";
  if (side === "blue") return "🔵 Azul";
  return "⚖️ Empate";
}

function FlagIcon({ side, size = 28 }: Readonly<{ side: "red" | "blue"; size?: number }>) {
  const fill = side === "red" ? "#ef4444" : "#3b82f6";
  const stroke = side === "red" ? "#7f1d1d" : "#1e3a8a";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* Palito */}
      <line x1="8" y1="2" x2="8" y2="30" stroke="#d4d4d8" strokeWidth="2" strokeLinecap="round" />
      {/* Pomo */}
      <circle cx="8" cy="3" r="1.6" fill="#e4e4e7" />
      {/* Bandera ondulada */}
      <path
        d="M8 5 H26 Q22 9 26 13 H8 Z"
        fill={fill}
        stroke={stroke}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Chicharra de campana — genera un sonido de "bell" usando Web Audio API
let bellAudioCtx: AudioContext | null = null;
function playBell() {
  try {
    if (typeof window === "undefined") return;
    bellAudioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = bellAudioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    // Dos golpes rápidos para simular una campana de ring
    const strikes = [0, 0.18];
    strikes.forEach((offset) => {
      const t = now + offset;
      // Tono fundamental + armónicos para sonar a campana metálica
      const freqs = [880, 1320, 1760];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        const peak = i === 0 ? 0.35 : 0.15 / (i + 1);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(peak, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 1);
      });
    });
  } catch {
    // Si el navegador bloquea el audio (sin gesto del usuario), simplemente ignoramos
  }
}

function resultBannerClass(winner: string): string {
  if (winner === "red") return "bg-red-950/60 border border-red-700";
  if (winner === "blue") return "bg-blue-950/60 border border-blue-700";
  return "bg-secondary border border-border";
}

function winnerName(
  winner: string,
  state: ServerState,
  fight: FightEntry | undefined
): string {
  if (winner === "draw") return "Empate";
  const name =
    winner === "red"
      ? (state.match?.red.name ?? fight?.red.name ?? "Rojo")
      : (state.match?.blue.name ?? fight?.blue.name ?? "Azul");
  return `Ganador: ${name}`;
}

// ── Flag voting panel ──────────────────────────────────────────────────────

function countFlags(judgesCount: number, votes: Record<string, string>): { red: number; blue: number; draw: number } {
  let red = 0, blue = 0, draw = 0;
  for (let i = 1; i <= judgesCount; i++) {
    const v = votes[`J${i}`];
    if (v === "red") red++;
    else if (v === "blue") blue++;
    else if (v === "draw") draw++;
  }
  return { red, blue, draw };
}

function countRoundsWon(flags: Array<{ winner: string }>): { red: number; blue: number } {
  let red = 0, blue = 0;
  for (const f of flags) {
    if (f.winner === "red") red++;
    else if (f.winner === "blue") blue++;
  }
  return { red, blue };
}

type FlagWinner = "red" | "blue" | "draw" | null;

function flagRoundWinner(flags: { red: number; blue: number; draw: number }): FlagWinner {
  const total = flags.red + flags.blue + flags.draw;
  if (total === 0) return null;
  if (flags.red > flags.blue && flags.red > flags.draw) return "red";
  if (flags.blue > flags.red && flags.blue > flags.draw) return "blue";
  if (flags.draw > flags.red && flags.draw > flags.blue) return "draw";
  // Empate entre rojo y azul → resultado empate
  if (flags.red === flags.blue) return "draw";
  // Empate entre un color y empate → gana el color
  return flags.red > flags.blue ? "red" : "blue";
}

function confirmBtnLabel(winner: "red" | "blue" | "draw" | null): string {
  if (winner === "red") return "🔴 Confirmar — Rojo gana el round";
  if (winner === "blue") return "🔵 Confirmar — Azul gana el round";
  if (winner === "draw") return "Confirmar — Empate en banderas";
  return "Confirmar votación del round";
}

function flagBtnClass(side: FlagSide, active: boolean): string {
  const base = cn(
    "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1 rounded-xl px-1 py-2 text-sm font-bold leading-tight transition-colors md:py-4 md:text-base",
    active && "ring-2 ring-inset ring-white/80",
  );
  if (side === "red") {
    return active
      ? `${base} bg-red-600 text-white`
      : `${base} bg-red-950/30 text-red-400/50 hover:bg-red-900/40 border border-red-900/50`;
  }
  if (side === "draw") {
    return active
      ? `${base} bg-secondary text-foreground border border-border`
      : `${base} bg-secondary/30 text-muted-foreground/50 hover:bg-secondary/60 border border-border/40`;
  }
  return active
    ? `${base} bg-blue-600 text-white`
    : `${base} bg-blue-950/30 text-blue-400/50 hover:bg-blue-900/40 border border-blue-900/50`;
}

function roundBadgeClass(winner: string): string {
  if (winner === "red") return "bg-red-900/40 text-red-300 border-red-800";
  if (winner === "blue") return "bg-blue-900/40 text-blue-300 border-blue-800";
  return "bg-secondary text-muted-foreground border-border";
}

function FlagButton({
  side, active, disabled, onClick,
}: Readonly<{ side: FlagSide; active: boolean; disabled: boolean; onClick: () => void }>) {
  const label = flagLabel(side);
  const plainLabel = side === "draw" ? "Empate" : side === "red" ? "Rojo" : "Azul";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={flagBtnClass(side, active)}
    >
      {active && <Check className="size-3 shrink-0 md:size-4" aria-hidden="true" />}
      <span className="md:hidden">{plainLabel}</span>
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

function FlagVoteRow({
  judgeId, vote, disabled, onVote, hideDraw,
}: Readonly<{
  judgeId: string;
  vote: string | undefined;
  disabled: boolean;
  onVote: (jid: string, v: FlagSide) => void;
  hideDraw?: boolean;
}>) {
  return (
    <fieldset className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-1 rounded-lg bg-secondary/20 px-2 py-2 md:flex md:flex-col">
      <legend className="sr-only">Voto {judgeId}</legend>
      <span className="text-xs font-bold text-muted-foreground text-center">{judgeId}</span>
      <div className={cn("grid min-w-0 gap-1 md:flex md:w-full", hideDraw ? "grid-cols-2" : "grid-cols-3")}>
        <FlagButton side="red" active={vote === "red"} disabled={disabled} onClick={() => onVote(judgeId, "red")} />
        {!hideDraw && <FlagButton side="draw" active={vote === "draw"} disabled={disabled} onClick={() => onVote(judgeId, "draw")} />}
        <FlagButton side="blue" active={vote === "blue"} disabled={disabled} onClick={() => onVote(judgeId, "blue")} />
      </div>
    </fieldset>
  );
}

function RoundHistoryBadge({ round, idx }: Readonly<{ round: { red: number; blue: number; winner: string }; idx: number }>) {
  return (
    <span className={cn("px-2.5 py-1 rounded text-xs font-bold border", roundBadgeClass(round.winner))}>
      R{idx + 1}: {round.red}🔴 − {round.blue}🔵
    </span>
  );
}

function FlagPanelFooter({ canVote, roundActive, roundNum, onEmit }: Readonly<{
  canVote: boolean;
  roundActive: boolean;
  roundNum: number;
  onEmit: (event: string, data?: unknown) => void;
}>) {
  if (canVote) return null;
  if (roundActive) {
    return (
      <p className="text-center text-xs text-muted-foreground pt-1">
        ⏱ Round en curso — terminá el round para registrar las banderas
      </p>
    );
  }
  return (
    <Button
      size="lg"
      variant="outline"
      className="w-full border-dashed"
      onClick={() => onEmit("match:skipToFlags")}
    >
      📋 Registrar banderas del Round {roundNum}
    </Button>
  );
}

export function JefeMesaPanel({
  judgesCount, judgeVotes, roundFlags, phase, pendingJuryDecision, onEmit, mode, tulMode, goldenPoint,
  onGoldenVote, onConfirmGoldenOutcome, goldenActionPending = false,
}: Readonly<{
  judgesCount: number;
  judgeVotes: Record<string, string>;
  roundFlags: Array<{ red: number; blue: number; winner: string }>;
  phase: string;
  pendingJuryDecision: boolean;
  onEmit: (event: string, data?: unknown) => void;
  mode: "mesa" | "porjuez";
  tulMode?: boolean;
  goldenPoint?: { attempt: number; votes: Record<string, "red" | "blue"> };
  onGoldenVote?: (judgeId: string, competitor: "red" | "blue", attempt: number) => void;
  onConfirmGoldenOutcome?: (attempt: number) => void;
  goldenActionPending?: boolean;
}>) {
  const ids = Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`);
  if (phase === "golden_point" && goldenPoint) {
    const redVotes = Object.values(goldenPoint.votes).filter((vote) => vote === "red").length;
    const blueVotes = Object.values(goldenPoint.votes).filter((vote) => vote === "blue").length;
    const majority = Math.floor(judgesCount / 2) + 1;
    const winner = redVotes >= majority ? "red" : blueVotes >= majority ? "blue" : null;
    const isDraw = !winner && redVotes + blueVotes === judgesCount && redVotes === blueVotes;
    return (
      <div className="space-y-3">
        <p className="text-center font-bold text-yellow-300">
          ⚡ Punto de Oro · Intento {goldenPoint.attempt} · Sin reloj
        </p>
        <p className="text-center text-xs text-muted-foreground">
          Marcá cada juez por separado. Podés cambiar un voto antes de confirmar el intento;
          se necesita mayoría de {majority}.
        </p>
        <p
          data-testid="gp-provisional"
          className="rounded-md border border-yellow-700/50 bg-yellow-950/30 px-3 py-2 text-center text-sm font-semibold text-yellow-200"
        >
          Resultado provisional · todavía no confirmado
        </p>
        <p data-testid="gp-votes" className="text-center font-bold">
          🔴 {redVotes} — {blueVotes} 🔵
        </p>
        {ids.map((judgeId) => (
          <div key={judgeId} className="flex items-center gap-2">
            <span className="w-9 text-xs font-bold">{judgeId}</span>
            <Button
              data-testid={`gp-vote-${judgeId}-red`}
              aria-pressed={goldenPoint.votes[judgeId] === "red"}
              className="min-h-11 flex-1 bg-red-800 hover:bg-red-700"
              disabled={goldenActionPending || goldenPoint.votes[judgeId] === "red" || !onGoldenVote}
              onClick={() => onGoldenVote?.(judgeId, "red", goldenPoint.attempt)}
            >
              Punto rojo
            </Button>
            <Button
              data-testid={`gp-vote-${judgeId}-blue`}
              aria-pressed={goldenPoint.votes[judgeId] === "blue"}
              className="min-h-11 flex-1 bg-blue-800 hover:bg-blue-700"
              disabled={goldenActionPending || goldenPoint.votes[judgeId] === "blue" || !onGoldenVote}
              onClick={() => onGoldenVote?.(judgeId, "blue", goldenPoint.attempt)}
            >
              Punto azul
            </Button>
            <span className="w-5">
              {goldenPoint.votes[judgeId] === "red"
                ? "🔴"
                : goldenPoint.votes[judgeId] === "blue" ? "🔵" : "—"}
            </span>
          </div>
        ))}
        <p className="text-center text-xs text-muted-foreground">
          {winner
            ? `Mayoría provisional para ${winner === "red" ? "rojo" : "azul"}. Revisá los votos antes de confirmar.`
            : isDraw
              ? "Empate provisional: confirmar abre otro intento sin reloj."
              : "Esperando votos para definir mayoría o empate."}
        </p>
        <Button
          data-testid="gp-confirm-outcome"
          className="min-h-11 w-full bg-yellow-600 hover:bg-yellow-500 text-white"
          disabled={goldenActionPending || (!winner && !isDraw) || !onConfirmGoldenOutcome}
          onClick={() => onConfirmGoldenOutcome?.(goldenPoint.attempt)}
        >
          {goldenActionPending
            ? "Guardando..."
            : winner
              ? `Confirmar ganador ${winner === "red" ? "rojo" : "azul"}`
              : isDraw ? "Confirmar empate y seguir" : "Faltan votos"}
        </Button>
      </div>
    );
  }
  const roundActive = tulMode ? false : (phase === "round" || phase === "golden_point");
  const canVote = tulMode ? true : ((phase !== "idle" && phase !== "finished") || (phase === "finished" && pendingJuryDecision));
  const canConfirm = tulMode ? true : (canVote && !roundActive);
  const flags = countFlags(judgesCount, judgeVotes);
  const roundWinner = flagRoundWinner(flags);
  const allVoted = ids.every((jid) => judgeVotes[jid] === "red" || judgeVotes[jid] === "blue" || judgeVotes[jid] === "draw");
  const roundNum = roundFlags.length + 1;

  function voteSingle(side: FlagSide) {
    ids.forEach((jid) => { onEmit("mesa:flagVote", { judgeId: jid, vote: side }); });
    setTimeout(() => onEmit(tulMode ? "tul:finish" : "mesa:confirmRound"), 80);
  }

  return (
    <div className="space-y-3">
      {/* Historial de rounds */}
      {!tulMode && roundFlags.length > 0 && (
        <div className="space-y-1.5">
          {/* Resumen: rounds ganados */}
          {(() => {
            const rw = countRoundsWon(roundFlags);
            return (
              <div className="flex items-center gap-2 text-sm font-black">
                <span className={rw.red > rw.blue ? "text-red-300" : "text-muted-foreground/40"}>
                  🔴 {rw.red} round{rw.red !== 1 ? "s" : ""}
                </span>
                <span className="text-muted-foreground/25">|</span>
                <span className={rw.blue > rw.red ? "text-blue-300" : "text-muted-foreground/40"}>
                  🔵 {rw.blue} round{rw.blue !== 1 ? "s" : ""}
                </span>
              </div>
            );
          })()}
          {/* Badges por round + botón deshacer */}
          <div className="flex flex-wrap items-center gap-2">
            {roundFlags.map((r, i) => (
              <RoundHistoryBadge key={`r${i + 1}-${r.red}-${r.blue}`} round={r} idx={i} />
            ))}
            {!roundActive && phase !== "finished" && (
              <button
                type="button"
                onClick={() => onEmit("mesa:undoRound")}
                className="min-h-11 rounded border border-red-900/50 px-2 py-1 text-xs font-medium text-red-400/60 transition-colors hover:bg-red-950/40 hover:text-red-300 md:min-h-0"
                title="Deshacer el último round confirmado"
              >
                ↩ Deshacer R{roundFlags.length}
              </button>
            )}
          </div>
        </div>
      )}

      {mode === "mesa" ? (
        /* ── MESA DECIDE: 3 botones grandes, 1 clic confirma ── */
        canVote ? (
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => voteSingle("red")}
              className={cn(
                "min-h-11 min-w-0 flex-1 rounded-xl border-2 px-1 py-3 text-sm font-black uppercase tracking-wide transition-all md:py-5 md:text-xl md:tracking-wider",
                canConfirm
                  ? "bg-red-700 hover:bg-red-600 border-red-600 text-white"
                  : "bg-red-950/20 border-red-900/30 text-red-400/40 cursor-not-allowed",
              )}
            >
              🔴 Rojo
            </button>
            {!tulMode && (
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => voteSingle("draw")}
              className={cn(
                "min-h-11 min-w-0 flex-1 rounded-xl border-2 px-1 py-3 text-sm font-black uppercase tracking-wide transition-all md:py-5 md:text-xl md:tracking-wider",
                canConfirm
                  ? "bg-secondary hover:bg-secondary/80 border-border text-foreground"
                  : "bg-secondary/20 border-border/30 text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              🤝 Empate
            </button>
            )}
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => voteSingle("blue")}
              className={cn(
                "min-h-11 min-w-0 flex-1 rounded-xl border-2 px-1 py-3 text-sm font-black uppercase tracking-wide transition-all md:py-5 md:text-xl md:tracking-wider",
                canConfirm
                  ? "bg-blue-700 hover:bg-blue-600 border-blue-600 text-white"
                  : "bg-blue-950/20 border-blue-900/30 text-blue-400/40 cursor-not-allowed",
              )}
            >
              🔵 Azul
            </button>
          </div>
        ) : (
          <FlagPanelFooter canVote={canVote} roundActive={roundActive} roundNum={roundNum} onEmit={onEmit} />
        )
      ) : (
        /* ── POR JUEZ: filas individuales ── */
        <>
          {/* Banner de estado de fase */}
          {canVote && !tulMode && (
            <div className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium",
              roundActive
                ? "bg-secondary/30 text-muted-foreground/60"
                : "bg-amber-950/40 border border-amber-700/40 text-amber-200"
            )}>
              <span className={roundActive ? "" : "animate-pulse"}>
                {roundActive ? "⏱" : "🏁"}
              </span>
              <span>
                {roundActive
                  ? "Round en curso — podés pre-votar mientras mirás las banderas"
                  : `Round ${roundNum} terminado — registrá las banderas de los ${judgesCount} jueces`}
              </span>
            </div>
          )}
          {canVote && (
            <div className="flex items-center gap-3 py-1">
              <span className={cn("text-3xl font-black tabular-nums", roundWinner === "red" ? "text-red-400" : "text-muted-foreground")}>
                {flags.red} 🔴
              </span>
              <span className="text-xl font-black text-muted-foreground">vs</span>
              <span className={cn("text-3xl font-black tabular-nums", roundWinner === "blue" ? "text-blue-400" : "text-muted-foreground")}>
                {flags.blue} 🔵
              </span>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {ids.map((jid) => (
              <FlagVoteRow
                key={jid}
                judgeId={jid}
                vote={judgeVotes[jid]}
                disabled={!canVote}
                hideDraw={tulMode}
                onVote={(jid, v) => onEmit("mesa:flagVote", { judgeId: jid, vote: v })}
              />
            ))}
          </div>
          {canVote ? (
            <Button
              size="lg"
              disabled={!allVoted || !canConfirm || (tulMode && roundWinner === "draw")}
              onClick={() => tulMode ? onEmit("tul:finish") : onEmit("mesa:confirmRound")}
              title={roundActive ? "Terminá el round para confirmar" : undefined}
              className={cn(
                "w-full",
                roundWinner === "red" && !roundActive && "bg-red-700 hover:bg-red-600",
                roundWinner === "blue" && !roundActive && "bg-blue-700 hover:bg-blue-600",
              )}
            >
              {roundActive ? "⏱ Votando… terminá el round para confirmar" : confirmBtnLabel(roundWinner)}
            </Button>
          ) : null}
          {!tulMode && <FlagPanelFooter canVote={canVote} roundActive={roundActive} roundNum={roundNum} onEmit={onEmit} />}
        </>
      )}

    </div>
  );
}

function JudgeQrCode({ url, size = 120 }: { url: string; size?: number }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    import("qrcode").then((QRCode) => {
      QRCode.toCanvas(canvas, url, {
        width: size,
        margin: 1,
        color: { dark: "#ffffff", light: "#00000000" },
      });
    });
  }, [url, size]);
  return <canvas ref={canvasRef} className="rounded" />;
}

// biome-ignore lint/correctness/noUnusedVariables: component defined but not yet rendered — kept for planned future use
function JuecesMovilPanel({
  judgesCount, serverUrl, connectedJudges,
}: Readonly<{
  judgesCount: number;
  serverUrl: string;
  connectedJudges: string[];
}>) {
  const [showQr, setShowQr] = React.useState(false);
  const base = serverUrl.replace(/\/$/, "");
  const ids = Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`);
  return (
    <div className="space-y-2">
      {/* Toggle Link / QR */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {showQr ? "Escanear QR desde el dispositivo:" : "Abrir link desde el dispositivo:"}
        </p>
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          className="text-xs font-semibold text-primary border border-primary/40 rounded px-2 py-0.5 hover:bg-primary/10 transition-colors"
        >
          {showQr ? "Ver link" : "Ver QR"}
        </button>
      </div>

      {showQr ? (
        /* ── Modo QR ── */
        <div className="grid grid-cols-2 gap-3">
          {ids.map((jid, i) => {
            const url = `${base}/judge?id=${i + 1}`;
            const isConn = connectedJudges.includes(jid);
            return (
              <div key={jid} className="flex flex-col items-center gap-1.5 rounded-lg border border-border p-3">
                <div className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full shrink-0", isConn ? "bg-green-500" : "bg-muted-foreground/30")} />
                  <span className="text-xs font-bold">{jid}</span>
                  {isConn && <span className="text-xs text-green-400">✓ conectado</span>}
                </div>
                <JudgeQrCode url={url} />
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Modo link ── */
        <div className="grid grid-cols-2 gap-2">
          {ids.map((jid, i) => {
            const url = `${base}/judge?id=${i + 1}`;
            const isConn = connectedJudges.includes(jid);
            return (
              <a
                key={jid}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 hover:bg-secondary transition-colors"
              >
                <span className={cn("size-2 rounded-full shrink-0", isConn ? "bg-green-500" : "bg-muted-foreground/30")} />
                <span className="text-xs font-bold w-6">{jid}</span>
                <span className="text-xs text-muted-foreground truncate flex-1">{url}</span>
                <ExternalLink className="size-3 text-muted-foreground shrink-0" />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function JudgeCard({
  jid,
  index,
  isConn,
  hasMobile,
  vote,
  totals,
  judgeUrl,
  cardBg,
  isColored,
  onQrClick,
}: Readonly<{
  jid: string;
  index: number;
  isConn: boolean;
  hasMobile: boolean;
  vote: string | undefined;
  totals: { red: number; blue: number };
  judgeUrl: string | null;
  cardBg: string;
  isColored: boolean;
  onQrClick?: (url: string, jid: string) => void;
}>) {
  const hasPoints = totals.red > 0 || totals.blue > 0;
  const leading: "red" | "blue" | "tied" =
    totals.red > totals.blue ? "red" :
    totals.blue > totals.red ? "blue" : "tied";

  return (
    <div className="flex flex-col gap-0">
      {/* Carta del juez */}
      <div
        className={cn(
          "border-x border-t px-4 py-4 flex flex-col items-center gap-2 transition-all min-h-[90px] justify-center",
          judgeUrl ? "rounded-t-xl" : "rounded-xl border-b",
          cardBg,
        )}
      >
        <div className="flex items-center justify-between w-full">
          <span className={cn(
            "text-sm font-black",
            isColored ? "text-white/80" : "text-muted-foreground",
          )}>{jid}</span>
          {hasMobile && (
            <span className={cn(
              "size-2.5 rounded-full",
              isConn ? "bg-green-400" : "bg-muted-foreground/20",
            )} />
          )}
        </div>
        {hasPoints ? (
          <div className="flex items-center gap-3">
            <span className={cn(
              "text-2xl font-black tabular-nums",
              leading === "red" ? "text-white" : "text-white/35",
            )}>R {totals.red}</span>
            <span className="text-white/25 text-sm">·</span>
            <span className={cn(
              "text-2xl font-black tabular-nums",
              leading === "blue" ? "text-white" : "text-white/35",
            )}>B {totals.blue}</span>
          </div>
        ) : (
          <div className={cn(
            "text-center font-black tracking-widest uppercase text-lg leading-none",
            isColored ? "text-white" : "text-muted-foreground/30",
          )}>
            {vote === "red" ? "🔴 ROJO" : vote === "blue" ? "🔵 AZUL" : vote === "draw" ? "🤝 EMP." : "—"}
          </div>
        )}
      </div>

      {/* Link + botón QR */}
      {judgeUrl && (
        <div className="flex items-center gap-1.5 border border-t-0 border-border px-3 py-1.5 bg-card rounded-b-xl">
          <span className={cn("size-1.5 rounded-full shrink-0", isConn ? "bg-green-400" : "bg-muted-foreground/20")} />
          <a
            href={judgeUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-muted-foreground truncate flex-1 hover:text-primary transition-colors"
          >
            {judgeUrl}
          </a>
          <ExternalLink className="size-2.5 text-muted-foreground shrink-0" />
          {onQrClick && (
            <button
              type="button"
              onClick={() => onQrClick(judgeUrl, jid)}
              className="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:bg-secondary transition-colors"
            >
              QR
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function JudgeCornerGrid({
  judgesCount,
  connectedJudges,
  judgeTotals,
  judgeVotes,
  serverUrl,
  ringToken,
}: Readonly<{
  judgesCount: number;
  connectedJudges: string[];
  judgeTotals: Record<string, { red: number; blue: number }>;
  judgeVotes: Record<string, string>;
  serverUrl?: string;
  ringToken?: string;
}>) {
  const ids = Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`);
  const hasMobile = connectedJudges.length > 0;
  const base = serverUrl ? serverUrl.replace(/\/$/, "") : "";
  const [qrModal, setQrModal] = React.useState<{ url: string; jid: string; isConn: boolean } | null>(null);

  return (
    <>
      <div
        className="grid gap-2 w-full"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
      >
        {ids.map((jid, i) => {
          const isConn = connectedJudges.includes(jid);
          const vote = judgeVotes?.[jid];
          const totals = judgeTotals?.[jid] ?? { red: 0, blue: 0 };
          const hasPoints = totals.red > 0 || totals.blue > 0;
          const leading: "red" | "blue" | "tied" =
            totals.red > totals.blue ? "red" :
            totals.blue > totals.red ? "blue" : "tied";
          const cardBg =
            hasPoints && leading === "red"
              ? "bg-red-700 border-red-600"
              : hasPoints && leading === "blue"
              ? "bg-blue-700 border-blue-600"
              : vote === "red"
              ? "bg-red-700 border-red-600"
              : vote === "blue"
              ? "bg-blue-700 border-blue-600"
              : vote === "draw"
              ? "bg-secondary border-border"
              : "bg-card border-border";
          const isColored = hasPoints || vote === "red" || vote === "blue" || vote === "draw";
          const tokenSuffix = ringToken ? `&token=${ringToken}` : "";
          const judgeUrl = base ? `${base}/judge?id=${i + 1}${tokenSuffix}` : null;

          return (
            <JudgeCard
              key={jid}
              jid={jid}
              index={i}
              isConn={isConn}
              hasMobile={hasMobile}
              vote={vote}
              totals={totals}
              judgeUrl={judgeUrl}
              cardBg={cardBg}
              isColored={isColored}
              onQrClick={judgeUrl ? (url, id) => setQrModal({ url, jid: id, isConn }) : undefined}
            />
          );
        })}
      </div>

      {/* Modal QR fullscreen */}
      <Dialog open={qrModal !== null} onOpenChange={() => setQrModal(null)}>
        <DialogContent className="max-w-xs sm:max-w-sm mx-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className={cn("size-2.5 rounded-full shrink-0", qrModal?.isConn ? "bg-green-400" : "bg-muted-foreground/30")} />
              {qrModal?.jid}
              {qrModal?.isConn && <span className="text-xs font-normal text-green-400">· conectado</span>}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            {qrModal && <JudgeQrCode url={qrModal.url} size={260} />}
            {qrModal && (
              <a
                href={qrModal.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground text-center break-all hover:text-primary transition-colors"
              >
                {qrModal.url}
              </a>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="w-full" onClick={() => setQrModal(null)}>Cerrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function warnDeductions(warnings: number): number {
  return Math.floor(warnings / 3);
}

function totalPenaltyPoints(warnings: number, fouls: number): number {
  return warnDeductions(warnings) + fouls;
}

// biome-ignore lint/correctness/noUnusedVariables: component defined but not yet rendered — kept for planned future use
function PenaltyInfo({ fouls, warnings }: Readonly<{ fouls: number; warnings: number }>) {
  if (fouls === 0 && warnings === 0) return null;
  const total = totalPenaltyPoints(warnings, fouls);
  return (
    <>
      {warnings > 0 && <p className="text-xs text-yellow-500 mt-1">Advert.: {warnings}</p>}
      {total > 0 && <p className="text-xs text-red-500 mt-0.5">Pts. menos: {total}</p>}
    </>
  );
}

type PenaltyPanelProps = {
  phase: string;
  redName: string;
  blueName: string;
  penaltyCounts: { warnings: { red: number; blue: number }; fouls: { red: number; blue: number } };
  onEmit: (event: string, data?: unknown) => void;
  onClose: () => void;
};

function CompetitorPenaltyBlock({ name, color, warnings, fouls, canAdd, onWarning, onMinusPoint, onRemoveWarning, onRemoveMinusPoint }: Readonly<{
  name: string;
  color: "red" | "blue";
  warnings: number;
  fouls: number;
  canAdd: boolean;
  onWarning: () => void;
  onMinusPoint: () => void;
  onRemoveWarning?: () => void;
  onRemoveMinusPoint?: () => void;
}>) {
  const warnPts = warnDeductions(warnings);
  const total = totalPenaltyPoints(warnings, fouls);
  const colorClass = color === "red" ? "text-red-400" : "text-blue-400";
  const btnBorder = color === "red" ? "border-red-800 hover:bg-red-900/30 text-red-400" : "border-blue-800 hover:bg-blue-900/30 text-blue-400";
  return (
    <div className="space-y-1.5">
      <p className={cn("text-xs font-semibold uppercase tracking-wider", colorClass)}>{name}</p>
      <div className="text-xs text-muted-foreground">
        Advertencias: <span className={cn("font-bold", warnPts > 0 ? "text-orange-400" : "text-yellow-400")}>{warnings}</span>
        {" · "}Pts. directos: <span className={cn("font-bold", colorClass)}>{fouls}</span>
      </div>
      {(warnPts > 0 || fouls > 0) && (
        <p className="text-xs font-semibold text-red-400 bg-red-950/40 rounded px-2 py-1">
          {warnPts > 0 && `${warnings} advert. = ${warnPts} pts.`}
          {warnPts > 0 && fouls > 0 && " + "}
          {fouls > 0 && `${fouls} directos`}
          {" = "}<span className="text-white">{total} pts. menos</span>
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!canAdd}
          className="flex-1 text-yellow-400 border-yellow-700 hover:bg-yellow-900/30"
          onClick={onWarning}>
          + Advertencia
        </Button>
        {onRemoveWarning && (
          <Button size="sm" variant="outline" disabled={!canAdd || warnings === 0}
            className="text-yellow-600 border-yellow-800/50 hover:bg-yellow-900/20 px-2.5"
            onClick={onRemoveWarning}>
            ↩ Adv
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={!canAdd}
          className={cn("flex-1", btnBorder)}
          onClick={onMinusPoint}>
          − Punto
        </Button>
        {onRemoveMinusPoint && (
          <Button size="sm" variant="outline" disabled={!canAdd || fouls === 0}
            className="text-muted-foreground border-border hover:bg-secondary px-2.5"
            onClick={onRemoveMinusPoint}>
            ↩ Pto
          </Button>
        )}
      </div>
    </div>
  );
}

function PenaltyFloatPanel({ phase, redName, blueName, penaltyCounts, onEmit, onClose }: Readonly<PenaltyPanelProps>) {
  const canAdd = phase !== "idle" && phase !== "finished";

  function addEvent(competitor: "red" | "blue", type: string) {
    onEmit("match:event", { judgeId: "arbiter", competitor, type });
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-border bg-background shadow-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm">⚠️ Penalizaciones</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">✕</button>
      </div>
      <p className="text-[10px] text-muted-foreground">3 advertencias = 1 punto menos automático</p>

      {!canAdd && (
        <p className="text-xs text-muted-foreground text-center italic">Seleccioná un combate primero</p>
      )}

      <CompetitorPenaltyBlock
        name={redName} color="red"
        warnings={penaltyCounts.warnings.red} fouls={penaltyCounts.fouls.red}
        canAdd={canAdd}
        onWarning={() => addEvent("red", "warning_minor")}
        onMinusPoint={() => addEvent("red", "minus_point")}
        onRemoveWarning={() => addEvent("red", "remove_warning")}
        onRemoveMinusPoint={() => addEvent("red", "remove_minus_point")}
      />

      <Separator />

      <CompetitorPenaltyBlock
        name={blueName} color="blue"
        warnings={penaltyCounts.warnings.blue} fouls={penaltyCounts.fouls.blue}
        canAdd={canAdd}
        onWarning={() => addEvent("blue", "warning_minor")}
        onMinusPoint={() => addEvent("blue", "minus_point")}
        onRemoveWarning={() => addEvent("blue", "remove_warning")}
        onRemoveMinusPoint={() => addEvent("blue", "remove_minus_point")}
      />
    </div>
  );
}

export function ScoreSanctionControls({
  side,
  fighterName,
  layout,
  counts,
  enabled,
  busy,
  onAdjust,
}: Readonly<{
  side: SanctionSide;
  fighterName: string;
  layout: "desktop" | "mobile";
  counts: PenaltyCounts;
  enabled: boolean;
  busy: boolean;
  onAdjust: (side: SanctionSide, kind: SanctionKind, delta: -1 | 1) => void;
}>) {
  const warnings = counts.warnings[side];
  const directPoints = counts.fouls[side];
  const canAdjust = enabled && !busy;
  const mobile = layout === "mobile";
  const testId = (kind: SanctionKind, action: "add" | "remove") =>
    `score-sanction-${side}-${kind}-${action}-${layout}`;
  const buttonClass = mobile
    ? "min-h-11 text-xs font-bold py-1.5 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    : "text-sm font-bold py-2 rounded-xl disabled:opacity-30 disabled:cursor-not-allowed transition-colors";
  const subject = `${fighterName} (${side === "red" ? "rojo" : "azul"})`;
  return (
    <div className={mobile ? "grid grid-cols-2 gap-1 w-full" : "w-full space-y-2 mt-1"}
      data-testid={`score-sanctions-${side}-${layout}`}>
      <div className={mobile ? "contents" : "flex gap-2"}>
        <button type="button" data-testid={testId("warning", "add")}
          aria-label={`${subject}: agregar advertencia`}
          disabled={!canAdjust || warnings >= 99}
          onClick={() => onAdjust(side, "warning", 1)}
          className={cn(buttonClass, mobile ? "" : "flex-1",
            "border border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/30")}>
          {mobile ? "+Adv" : "+ Advertencia"}
        </button>
        <button type="button" data-testid={testId("warning", "remove")}
          aria-label={`${subject}: quitar advertencia`}
          disabled={!canAdjust || warnings === 0}
          onClick={() => onAdjust(side, "warning", -1)}
          className={cn(buttonClass, mobile ? "" : "px-4",
            "border border-yellow-800/40 text-yellow-600 hover:bg-yellow-900/20")}
          title="Deshacer advertencia">
          {mobile ? "↩Adv" : "↩ Adv"}
        </button>
      </div>
      <div className={mobile ? "contents" : "flex gap-2"}>
        <button type="button" data-testid={testId("minus_point", "add")}
          aria-label={`${subject}: agregar punto en contra directo`}
          disabled={!canAdjust || directPoints >= 99}
          onClick={() => onAdjust(side, "minus_point", 1)}
          className={cn(buttonClass, mobile ? "" : "flex-1",
            side === "red"
              ? "border border-red-600 text-red-300 bg-red-950/40 hover:bg-red-900/50"
              : "border border-blue-600 text-blue-300 bg-blue-950/40 hover:bg-blue-900/50")}>
          {mobile ? "−Pto" : "− Punto directo"}
        </button>
        <button type="button" data-testid={testId("minus_point", "remove")}
          aria-label={`${subject}: quitar punto en contra directo`}
          disabled={!canAdjust || directPoints === 0}
          onClick={() => onAdjust(side, "minus_point", -1)}
          className={cn(buttonClass, mobile ? "" : "px-4",
            "border border-border text-muted-foreground hover:bg-secondary")}
          title="Deshacer punto directo">
          {mobile ? "↩Pto" : "↩ Pto"}
        </button>
      </div>
    </div>
  );
}

export function PostClockSanctionReview({
  redName,
  blueName,
  counts,
  busy,
  editable,
  stage,
  onAdjust,
}: Readonly<{
  redName: string;
  blueName: string;
  counts: PenaltyCounts;
  busy: boolean;
  editable: boolean;
  stage: "voting" | "result";
  onAdjust: (side: SanctionSide, kind: SanctionKind, delta: -1 | 1) => void;
}>) {
  return (
    <section className="space-y-2 rounded-xl border border-amber-700/40 bg-amber-950/20 p-3"
      data-testid="sanction-review-pending">
      <div className="space-y-0.5">
        <p className="text-sm font-bold text-amber-300">
          {stage === "result" ? "Resultado sin confirmar · revisar sanciones" : "Reloj finalizado · sin confirmar · revisar sanciones"}
        </p>
        <p className="text-xs text-muted-foreground">
          {stage === "result"
            ? "Podés corregirlas antes de confirmar oficialmente el fallo. No cambian un empate 2–2 de banderines."
            : "Registrá advertencias y puntos en contra antes de cerrar el fallo. No cambian los votos de los jueces."}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(["red", "blue"] as const).map((side) => {
          const warnings = counts.warnings[side];
          const directPoints = counts.fouls[side];
          return (
            <div key={side} className={cn(
              "space-y-2 rounded-lg border p-2",
              side === "red" ? "border-red-900/60 bg-red-950/20" : "border-blue-900/60 bg-blue-950/20",
            )}>
              <p className={cn("truncate text-xs font-bold", side === "red" ? "text-red-300" : "text-blue-300")}
                title={side === "red" ? redName : blueName}>
                {side === "red" ? redName : blueName}
              </p>
              <div className="flex items-center justify-between gap-1 text-xs">
                <span>Advertencias</span>
                <strong data-testid={`sanction-${side}-warning-count`}>{warnings}</strong>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button size="sm" variant="outline" className="min-h-11 px-1 text-xs md:min-h-0 md:h-8"
                  data-testid={`sanction-${side}-warning-add`} disabled={busy || !editable || warnings >= 99}
                  onClick={() => onAdjust(side, "warning", 1)}>+ Adv</Button>
                <Button size="sm" variant="outline" className="min-h-11 px-1 text-xs md:min-h-0 md:h-8"
                  data-testid={`sanction-${side}-warning-remove`} disabled={busy || !editable || warnings === 0}
                  onClick={() => onAdjust(side, "warning", -1)}>− Adv</Button>
              </div>
              <div className="flex items-center justify-between gap-1 text-xs">
                <span>Puntos en contra directos</span>
                <strong data-testid={`sanction-${side}-minus_point-count`}>{directPoints}</strong>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button size="sm" variant="outline" className="min-h-11 px-1 text-xs md:min-h-0 md:h-8"
                  data-testid={`sanction-${side}-minus_point-add`} disabled={busy || !editable || directPoints >= 99}
                  onClick={() => onAdjust(side, "minus_point", 1)}>+ Punto</Button>
                <Button size="sm" variant="outline" className="min-h-11 px-1 text-xs md:min-h-0 md:h-8"
                  data-testid={`sanction-${side}-minus_point-remove`} disabled={busy || !editable || directPoints === 0}
                  onClick={() => onAdjust(side, "minus_point", -1)}>− Punto</Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Descuento total: {totalPenaltyPoints(warnings, directPoints)}
              </p>
            </div>
          );
        })}
      </div>
      {busy && <p className="text-center text-xs text-amber-200">Guardando y verificando en el servidor…</p>}
      {!editable && <p className="text-center text-xs text-red-300">Sin conexión o pelea ya confirmada: no se pueden cambiar sanciones.</p>}
    </section>
  );
}

function ServerStatus({ connected, judgesCount }: Readonly<{ connected: boolean; judgesCount: number }>) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 text-xs px-3 py-1 rounded-full",
      connected ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
    )}>
      {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
      {connected ? `Servidor OK · ${judgesLabel(judgesCount)}` : "Sin servidor"}
    </div>
  );
}

function fightResultLabel(f: FightEntry): string {
  if (!f.completed || !f.winner) return "";
  if (f.winner === "draw") return "Empate";
  const winner = f.winner === "red" ? f.red.name : f.blue.name;
  return `✓ ${winner}`;
}

function FightListRow({ fight, index, active, onSelect }: Readonly<{
  fight: FightEntry;
  index: number;
  active: boolean;
  onSelect: (i: number) => void;
}>) {
  return (
    <button
      type="button"
      onClick={() => onSelect(index)}
      className={cn(
        "w-full text-left rounded-lg px-3 py-2.5 text-sm transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-secondary text-muted-foreground",
      )}
    >
      <span className={cn(fight.completed && "line-through opacity-50")}>
        {index + 1}. {fight.red.name} vs {fight.blue.name}
      </span>
      {fight.completed && (
        <span className={cn(
          "ml-2 font-semibold not-italic",
          fight.winner === "red" && "text-red-400",
          fight.winner === "blue" && "text-blue-400",
          fight.winner === "draw" && "text-yellow-400",
        )}>
          {fightResultLabel(fight)}
        </span>
      )}
    </button>
  );
}

function FightProgressStrip({ fights, currentIndex, onSelect }: Readonly<{
  fights: FightEntry[];
  currentIndex: number;
  onSelect: (i: number) => void;
}>) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  React.useEffect(() => {
    refs.current[currentIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentIndex]);

  const groupIds = [...new Set(fights.map((f) => f.groupId).filter((id): id is string => Boolean(id)))];
  const hasMultipleGroups = groupIds.length > 1;

  function groupLabel(groupId: string | undefined): string {
    if (!groupId) return "";
    if (groupId === "FINAL") return "Final";
    if (groupId.startsWith("EXT:")) {
      const name = groupId.slice(4).replace(/-/g, " ");
      return `🏁 ${name}`;
    }
    // "G1" → "Llave 1", "G2" → "Llave 2", etc.
    const num = groupId.replace(/\D/g, "");
    return num ? `Llave ${num}` : groupId;
  }

  type StripItem =
    | { type: "fight"; fight: FightEntry; index: number }
    | { type: "label"; groupId: string; first: boolean; index: number };

  const items: StripItem[] = [];
  let lastGroupId: string | null = null;
  for (let i = 0; i < fights.length; i++) {
    const fight = fights[i];
    if (hasMultipleGroups && fight.groupId && fight.groupId !== lastGroupId) {
      items.push({ type: "label", groupId: fight.groupId, first: lastGroupId === null, index: i });
      lastGroupId = fight.groupId;
    }
    items.push({ type: "fight", fight, index: i });
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto px-4 pb-2.5 pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item) => {
        if (item.type === "label") {
          return (
            <span
              key={`label-${item.groupId}-${item.index}`}
              className={cn(
                "shrink-0 flex items-center gap-1 self-center",
                !item.first && "ml-1",
              )}
            >
              {!item.first && <span className="w-px h-3.5 bg-border/50" />}
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                {groupLabel(item.groupId)}
              </span>
            </span>
          );
        }

        const { fight, index: i } = item;
        const isCurrent = i === currentIndex;
        const isDone = fight.completed;
        const winner = fight.winner;

        let btnCls: string;
        if (isCurrent) {
          btnCls = "size-11 md:size-8 bg-primary text-primary-foreground ring-2 ring-primary/30";
        } else if (isDone) {
          if (winner === "red") {
            btnCls = "size-11 md:size-7 bg-red-950/60 border border-red-700/60 text-red-300 hover:bg-red-900/60";
          } else if (winner === "blue") {
            btnCls = "size-11 md:size-7 bg-blue-950/60 border border-blue-700/60 text-blue-300 hover:bg-blue-900/60";
          } else {
            btnCls = "size-11 md:size-7 bg-yellow-950/70 border border-yellow-600/60 text-yellow-300 hover:bg-yellow-900/60";
          }
        } else {
          btnCls = "size-11 md:size-6 border border-border/50 text-muted-foreground/60 hover:bg-secondary";
        }

        const tooltipParts = [`${i + 1}. ${fight.red.name} vs ${fight.blue.name}`];
        if (isDone && winner) {
          const winName = winner === "red" ? fight.red.name : winner === "blue" ? fight.blue.name : "Empate";
          const flags = (fight.flagsRed != null && fight.flagsBlue != null)
            ? ` (${fight.flagsRed}-${fight.flagsBlue})`
            : "";
          tooltipParts.push(`✓ ${winName}${flags}`);
        }

        return (
          <button
            key={fight.id}
            ref={(el) => { refs.current[i] = el; }}
            data-testid={`fight-progress-${fight.id}`}
            aria-current={isCurrent ? "step" : undefined}
            type="button"
            onClick={() => onSelect(i)}
            title={tooltipParts.join(" — ")}
            className={cn(
              "shrink-0 rounded-full font-bold tabular-nums transition-all text-xs flex items-center justify-center",
              btnCls,
            )}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
}

// biome-ignore lint/correctness/noUnusedVariables: component defined but not yet rendered — kept for planned future use
function FightPicker({
  fights,
  currentIndex,
  loaded,
  connected,
  onPrev,
  onNext,
  onLoad,
  onReset,
  onSelectIndex,
}: Readonly<{
  fights: FightEntry[];
  currentIndex: number;
  loaded: boolean;
  connected: boolean;
  onPrev: () => void;
  onNext: () => void;
  onLoad: () => void;
  onReset: () => void;
  onSelectIndex: (i: number) => void;
}>) {
  const current = fights[currentIndex];
  const [confirmRedo, setConfirmRedo] = React.useState(false);
  const isTulMode = useTournamentStore((s) => s.config.matchType) === 'tul';
  React.useEffect(() => { setConfirmRedo(false); }, [currentIndex]);
  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>
            Combate {currentIndex + 1} / {fights.length}
          </span>
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" className="size-7" disabled={currentIndex === 0} onClick={onPrev}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" disabled={currentIndex === fights.length - 1} onClick={onNext}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {current && (
          <>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="font-bold text-red-400">{current.red.name}</p>
                {current.red.team && <p className="text-xs text-muted-foreground">{current.red.team}</p>}
              </div>
              <span className="text-muted-foreground text-xs font-medium px-2">vs</span>
              <div className="text-right">
                <p className="font-bold text-blue-400">{current.blue.name}</p>
                {current.blue.team && <p className="text-xs text-muted-foreground">{current.blue.team}</p>}
              </div>
            </div>
            {current.completed && !loaded && (() => {
              const isDraw = current.winner === "draw";
              const winnerName = current.winner === "red" ? current.red.name
                : current.winner === "blue" ? current.blue.name
                : null;
              const flagsText = (current.flagsRed != null && current.flagsBlue != null)
                ? `${current.flagsRed} — ${current.flagsBlue}`
                : null;
              return (
                <div className={cn(
                  "rounded-xl border-2 px-4 py-4 flex flex-col items-center gap-2 text-center",
                  isDraw
                    ? "border-yellow-500/60 bg-yellow-950/30"
                    : current.winner === "red"
                    ? "border-red-600/60 bg-red-950/30"
                    : "border-blue-600/60 bg-blue-950/30"
                )}>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Resultado</p>
                  {isDraw ? (
                    <>
                      <p className="text-3xl font-black text-yellow-400 leading-none">⚖ Empate</p>
                      {flagsText && (
                        <p className="text-sm font-bold text-muted-foreground">
                          <span className="text-red-400">{current.flagsRed}</span>
                          {" — "}
                          <span className="text-blue-400">{current.flagsBlue}</span>
                          <span className="text-xs font-normal text-muted-foreground/60 ml-1">banderas</span>
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p className={cn(
                        "text-2xl font-black leading-none",
                        current.winner === "red" ? "text-red-400" : "text-blue-400"
                      )}>
                        {current.winner === "red" ? "🔴" : "🔵"} {winnerName}
                      </p>
                      <p className="text-xs text-muted-foreground">ganó el combate</p>
                      {flagsText && (
                        <p className="text-sm font-bold">
                          <span className="text-red-400">{current.flagsRed}</span>
                          {" — "}
                          <span className="text-blue-400">{current.flagsBlue}</span>
                          <span className="text-xs font-normal text-muted-foreground/60 ml-1">banderas</span>
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
            {loaded ? (
              <Button size="lg" variant="outline" className="w-full" onClick={onReset}>
                <RotateCcw className="size-4" />
                Reiniciar
              </Button>
            ) : current.completed ? (
              confirmRedo ? (
                <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 space-y-3">
                  <div className="flex items-start gap-2">
                    <span className="text-destructive text-lg leading-none mt-0.5">⚠</span>
                    <div className="space-y-1">
                      <p className="text-sm font-bold text-destructive">Acción irreversible</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Borrar este resultado puede alterar la clasificación, desempates y la Fase Final. Solo hacelo si el resultado fue cargado por error.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => { setConfirmRedo(false); onLoad(); }}>
                      Sí, resetear
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmRedo(false)}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="lg" variant="outline" className="w-full border-amber-700/50 text-amber-400 hover:bg-amber-950/40 hover:text-amber-300" onClick={() => setConfirmRedo(true)}>
                  ⚠ Rehacer combate
                </Button>
              )
            ) : (
              <Button size="lg" className="w-full" onClick={onLoad}>
                {isTulMode ? 'Iniciar competencia' : 'Cargar combate'}
              </Button>
            )}
          </>
        )}
        <Separator />
        <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
          {(() => {
            const localFights = fights.filter((f) => !f.importedFrom);
            const regular = localFights.filter((f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight);
            const finals = localFights.filter((f) => f.isFinalFight);
            const tiebreaks = localFights.filter((f) => f.isTiebreakExtra || f.isGoldenPointFight);
            const isGrouped = regular.some((fight) => fight.groupId);
            let previousGroupId: string | undefined;
            const regularSection = regular.map((fight) => {
              const index = fights.indexOf(fight);
              const showLabel = isGrouped && fight.groupId !== previousGroupId;
              previousGroupId = fight.groupId;
              return (
                <React.Fragment key={fight.id}>
                  {showLabel && (
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-1 pt-1 pb-0.5">
                      Llave {fight.groupId ?? "—"}
                    </p>
                  )}
                  <FightListRow fight={fight} index={index} active={index === currentIndex} onSelect={onSelectIndex} />
                </React.Fragment>
              );
            });

            const finalSection = finals.length > 0
              ? (
                <div key="__finals__">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400/80 px-1 pt-2 pb-0.5">
                    🏆 Final
                  </p>
                  {finals.map((f) => {
                    const i = fights.indexOf(f);
                    return <FightListRow key={f.id} fight={f} index={i} active={i === currentIndex} onSelect={onSelectIndex} />;
                  })}
                </div>
              )
              : null;

            const tbSection = tiebreaks.length > 0
              ? (
                <div key="__tiebreaks__">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-400/70 px-1 pt-2 pb-0.5">
                    ⚡ Desempate
                  </p>
                  {tiebreaks.map((f) => {
                    const i = fights.indexOf(f);
                    return <FightListRow key={f.id} fight={f} index={i} active={i === currentIndex} onSelect={onSelectIndex} />;
                  })}
                </div>
              )
              : null;

            return [...regularSection, finalSection, tbSection];
          })()}
        </div>
      </CardContent>
    </Card>
  );
}

function matchPts(winner: string, side: "red" | "blue"): number {
  if (winner === side) return 3;
  if (winner === "draw") return 1;
  return 0;
}

function ResultBanner({ winner, reason, fight, state, onFinishAndNext }: Readonly<{
  winner: string;
  reason: string;
  fight: FightEntry | undefined;
  state: ServerState;
  onFinishAndNext: () => void;
}>) {
  const flagsRed = (state.roundFlags ?? []).reduce((s, r) => s + r.red, 0);
  const flagsBlue = (state.roundFlags ?? []).reduce((s, r) => s + r.blue, 0);
  const redPts = matchPts(winner, "red");
  const bluePts = matchPts(winner, "blue");

  const judgeTotals = state.judgeTotals ?? {};
  const judgeVotes = state.judgeVotes ?? {};
  const judgeIds = Object.keys(judgeTotals).length > 0
    ? Object.keys(judgeTotals).sort()
    : Object.keys(judgeVotes).sort();
  const hasMobileScores = Object.values(judgeTotals).some((j) => j.red > 0 || j.blue > 0);

  return (
    <div className={cn("rounded-xl p-4 text-center space-y-3", resultBannerClass(winner))}>
      <div className="text-2xl font-black flex items-center justify-center gap-2">
        <Trophy className="size-6" />
        {winnerName(winner, state, fight)}
      </div>
      <p className="text-muted-foreground text-sm">
        {WIN_REASON_LABELS[reason] ?? reason}
      </p>

      {/* Puntajes por juez */}
      {judgeIds.length > 0 && (
        <div className="flex justify-center gap-2 flex-wrap">
          {judgeIds.map((jid, i) => {
            const t = judgeTotals[jid] ?? { red: 0, blue: 0 };
            const vote = judgeVotes[jid];
            const label = `J${i + 1}`;
            const leading = t.red > t.blue ? "red" : t.blue > t.red ? "blue" : vote === "draw" ? "draw" : null;
            return (
              <div key={jid} className={cn(
                "rounded-lg px-2.5 py-1.5 border text-xs font-semibold min-w-[60px]",
                leading === "red" ? "bg-red-800/60 border-red-600" :
                leading === "blue" ? "bg-blue-800/60 border-blue-600" :
                "bg-secondary border-border",
              )}>
                <p className="text-muted-foreground/70 text-[10px] mb-0.5">{label}</p>
                {hasMobileScores
                  ? <p><span className="text-red-300">{t.red}</span><span className="text-muted-foreground/50 mx-0.5">·</span><span className="text-blue-300">{t.blue}</span></p>
                  : <p className={vote === "red" ? "text-red-300" : vote === "blue" ? "text-blue-300" : "text-muted-foreground"}>
                      {vote === "red" ? "🔴" : vote === "blue" ? "🔵" : vote === "draw" ? "🤝" : "—"}
                    </p>
                }
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-center gap-6">
        <span className="text-red-400 font-bold text-sm">
          {fight?.red.name ?? "Rojo"} — {redPts} pts · {flagsRed} 🔴
        </span>
        <span className="text-blue-400 font-bold text-sm">
          {fight?.blue.name ?? "Azul"} — {bluePts} pts · {flagsBlue} 🔵
        </span>
      </div>
      <Button className="mt-1" onClick={onFinishAndNext}>
        Siguiente pelea →
      </Button>
    </div>
  );
}

interface MatchControlsProps {
  loaded: boolean;
  isFinished: boolean;
  phase: string;
  matchPaused: boolean;
  fight: FightEntry | undefined;
  isLast: boolean;
  state: ServerState;
  isTul?: boolean;
  onEmit: (event: string, data?: unknown) => void;
  onFinishAndNext: () => void;
  startBlocked?: boolean;
}

function MatchControls({
  loaded,
  isFinished,
  phase,
  matchPaused,
  fight,
  isLast,
  state,
  isTul,
  onEmit,
  onFinishAndNext,
  startBlocked,
}: Readonly<MatchControlsProps>) {
  if (!loaded) return null;

  // ── Modo Tul ────────────────────────────────────────────────
  if (isTul) {
    if (isFinished && state.matchState?.result) {
      const { winner, reason } = state.matchState.result;
      return (
        <ResultBanner
          winner={winner}
          reason={reason}
          fight={fight}
          state={state}
          onFinishAndNext={onFinishAndNext}
        />
      );
    }
    const votes = state.judgeVotes ?? {};
    const redVotes = Object.values(votes).filter((v) => v === "red").length;
    const blueVotes = Object.values(votes).filter((v) => v === "blue").length;
    const totalVoted = redVotes + blueVotes;
    const judgesCount = state.rules?.judgesCount ?? 3;
    const tulPhase = state.tulPhase ?? "idle";

    if (tulPhase === "voting") {
      return (
        <div className="flex flex-col items-center gap-4 w-full">
          {/* Conteo en tiempo real */}
          <div className="flex items-center gap-6">
            <span className="text-5xl font-black text-red-400">{redVotes}</span>
            <span className="text-lg text-muted-foreground">vs</span>
            <span className="text-5xl font-black text-blue-400">{blueVotes}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {totalVoted} / {judgesCount} jueces votaron
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
            <Button
              size="xl"
              className="bg-green-700 hover:bg-green-600"
              disabled={totalVoted === 0 || redVotes === blueVotes}
              title={totalVoted === 0 ? "Cargá al menos un voto" : redVotes === blueVotes ? "En formas no puede haber empate — desempatá antes de confirmar" : undefined}
              onClick={() => onEmit("tul:finish")}
            >
              <Check />
              Confirmar resultado
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEmit("tul:retry")}>
              ↺ Nueva votación
            </Button>
          </div>
          {redVotes === blueVotes && totalVoted > 0 && (
            <p className="text-xs text-amber-400 text-center">
              ⚠ Empate {redVotes}-{blueVotes} — en formas no se permite empate. Agregá o cambiá votos antes de confirmar.
            </p>
          )}
          {/* Zona de peligro */}
          <div className="flex items-center gap-2 w-full max-w-xs">
            <div className="h-px flex-1 bg-border/30" />
            <Button
              size="sm" variant="ghost"
              className="text-red-400/40 hover:text-white hover:bg-red-700/80 text-xs h-7 px-2.5 border border-red-900/30 hover:border-red-600 transition-all"
              onClick={() => onEmit("match:dq", { competitor: "red" })}>
              <UserX className="size-3 mr-1" />DQ Rojo
            </Button>
            <Button
              size="sm" variant="ghost"
              className="text-blue-400/40 hover:text-white hover:bg-blue-700/80 text-xs h-7 px-2.5 border border-blue-900/30 hover:border-blue-600 transition-all"
              onClick={() => onEmit("match:dq", { competitor: "blue" })}>
              <UserX className="size-3 mr-1" />DQ Azul
            </Button>
            <div className="h-px flex-1 bg-border/30" />
          </div>
        </div>
      );
    }
    // tulPhase === 'idle'
    return (
      <div className="flex flex-col items-center gap-3 w-full">
        <Button size="xl" className="bg-green-700 hover:bg-green-600" disabled={startBlocked} onClick={() => onEmit("match:start")}>
          <Play />
          Iniciar votación
        </Button>
      </div>
    );
  }

  // ── Modo Sparring ────────────────────────────────────────────
  const totalRounds = state.rules?.rounds.count ?? 2;
  const currentRound = state.matchState?.currentRound ?? 1;
  const isLastRound = currentRound >= totalRounds;
  const isRunning = phase === "round" || phase === "overtime" || phase === "golden_point";
  // In rest after last round (flags voting), don't offer to start another round
  const canStart = phase === "idle" || (phase === "rest" && !isLastRound);
  const canPause = isRunning && !matchPaused;
  const canResume = isRunning && matchPaused;
  const canFinish =
    (isRunning || matchPaused) && (phase === "round" || phase === "overtime");

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const [dqConfirm, setDqConfirm] = React.useState<"red" | "blue" | null>(null);

  if (isFinished && state.matchState?.result) {
    const { winner, reason } = state.matchState.result;
    return (
      <ResultBanner
        winner={winner}
        reason={reason}
        fight={fight}
        state={state}
        onFinishAndNext={onFinishAndNext}
      />
    );
  }

  if (phase === "golden_point") {
    return <p className="text-center text-sm font-semibold text-yellow-300">⚡ Punto de Oro activo: sin reloj ni finalización manual. Esperando mayoría de jueces.</p>;
  }

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      {/* Acciones primarias */}
      <div className="flex w-full flex-wrap justify-center gap-2 md:w-auto">
        {canStart && (
          <Button size="xl" className="min-h-11 w-full bg-green-700 hover:bg-green-600 md:w-auto" disabled={startBlocked} onClick={() => onEmit("match:start")}>
            <Play />
            Iniciar combate
          </Button>
        )}
        {canPause && (
          <Button size="xl" variant="outline" className="min-h-11 min-w-0 flex-1 md:flex-none" onClick={() => onEmit("match:pause")}>
            <Pause />
            Pausar
          </Button>
        )}
        {canResume && (
          <Button size="xl" className="min-h-11 min-w-0 flex-1 bg-yellow-700 hover:bg-yellow-600 md:flex-none" onClick={() => onEmit("match:resume")}>
            <Play />
            Reanudar
          </Button>
        )}
        {canFinish && (
          <Button size="xl" variant="secondary" className="min-h-11 min-w-0 flex-1 md:flex-none" aria-label="Finalizar combate" onClick={() => onEmit("match:finishRound")}>
            <SkipForward />
            <span className="md:hidden">Finalizar</span><span className="hidden md:inline">Finalizar combate</span>
          </Button>
        )}
        {phase === "penalties" && (
          <Button size="xl" className="min-h-11 w-full bg-orange-700 hover:bg-orange-600 md:w-auto" onClick={() => onEmit("match:confirmPenalties")}>
            Confirmar penalizaciones
          </Button>
        )}
      </div>
      {/* Ajuste fino de tiempo — solo cuando el combate está pausado */}
      {canResume && (
        <div className="flex w-full max-w-xs flex-col items-center gap-1.5 md:w-auto md:max-w-none">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Ajustar tiempo</span>
          <div className="grid w-full grid-cols-3 gap-1.5 md:flex md:w-auto md:items-center md:gap-1">
            {[-15, -5, -1].map((s) => (
              <Button
                key={s}
                size="sm" variant="outline"
                className="min-h-11 px-2 text-xs border-dashed text-red-300 hover:bg-red-950/40 md:min-h-0 md:h-7"
                onClick={() => onEmit("timer:addSeconds", { seconds: s })}
              >
                {s}s
              </Button>
            ))}
            <span className="mx-1 hidden text-muted-foreground/50 md:inline">·</span>
            {[1, 5, 15].map((s) => (
              <Button
                key={s}
                size="sm" variant="outline"
                className="min-h-11 px-2 text-xs border-dashed text-green-300 hover:bg-green-950/40 md:min-h-0 md:h-7"
                onClick={() => onEmit("timer:addSeconds", { seconds: s })}
              >
                +{s}s
              </Button>
            ))}
          </div>
        </div>
      )}
      {/* Zona de descalificación */}
      {!isFinished && (
        <div className="flex flex-col items-center gap-1 w-full max-w-xs">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-widest">Descalificación</p>
          <div className="flex items-center gap-2 w-full">
            <Button
              size="sm" variant="ghost"
              className="min-h-11 flex-1 border border-red-900/30 px-2 text-xs text-red-400/50 transition-all hover:border-red-600 hover:bg-red-700/80 hover:text-white md:min-h-0 md:h-7"
              onClick={() => setDqConfirm("red")}>
              <UserX className="size-3 mr-1" />Descalif. Rojo
            </Button>
            <Button
              size="sm" variant="ghost"
              className="min-h-11 flex-1 border border-blue-900/30 px-2 text-xs text-blue-400/50 transition-all hover:border-blue-600 hover:bg-blue-700/80 hover:text-white md:min-h-0 md:h-7"
              onClick={() => setDqConfirm("blue")}>
              <UserX className="size-3 mr-1" />Descalif. Azul
            </Button>
          </div>
        </div>
      )}
      {/* Diálogo de confirmación DQ */}
      <Dialog open={dqConfirm !== null} onOpenChange={(o) => !o && setDqConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserX className={cn("size-5", dqConfirm === "red" ? "text-red-400" : "text-blue-400")} />
              Confirmar descalificación
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-sm">
              Vas a descalificar a{" "}
              <strong className={cn(dqConfirm === "red" ? "text-red-400" : "text-blue-400")}>
                {dqConfirm === "red" ? (fight?.red.name ?? "Rojo") : (fight?.blue.name ?? "Azul")}
              </strong>
              . El combate finalizará y se otorgará la victoria al rival.
            </p>
            <p className="text-xs text-amber-400/80">
              ⚠ Esta acción no puede deshacerse fácilmente. Asegurate antes de confirmar.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDqConfirm(null)}>
              Cancelar
            </Button>
            <Button
              className={cn(
                "text-white",
                dqConfirm === "red" ? "bg-red-700 hover:bg-red-600" : "bg-blue-700 hover:bg-blue-600",
              )}
              onClick={() => {
                if (dqConfirm) onEmit("match:dq", { competitor: dqConfirm });
                setDqConfirm(null);
              }}
            >
              <UserX className="size-4 mr-1" />
              Descalificar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FlagCounterField({
  isMesa,
  value,
  onChange,
  color,
  name,
  max,
}: Readonly<{
  isMesa: boolean;
  value: number;
  onChange: (v: number) => void;
  color: "red" | "blue";
  name: string;
  max: number;
}>) {
  const textClass = color === "red" ? "text-red-400" : "text-blue-400";
  return (
    <div className="space-y-1">
      <p className={`text-xs font-medium ${textClass}`}>{name}</p>
      {isMesa ? (
        <div className="flex items-center gap-1.5">
          <Button size="icon" variant="outline" className="size-8 shrink-0"
            onClick={() => onChange(Math.max(0, value - 1))}>−</Button>
          <span className={`flex-1 text-center text-2xl font-black ${textClass}`}>{value}</span>
          <Button size="icon" variant="outline" className="size-8 shrink-0"
            onClick={() => onChange(Math.min(max, value + 1))}>+</Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border p-3 text-center">
          <span className={`text-3xl font-black ${textClass}`}>{value}</span>
        </div>
      )}
    </div>
  );
}

export interface FightPageProps {
  navigationIntent?: unknown;
  navigationEntryKey?: string;
}

export function FightPage({ navigationIntent, navigationEntryKey = "direct" }: FightPageProps = {}): React.JSX.Element {
  const { connected, stateReady, state: socketState, emit: emitSocket, request, socket } = useSocket();
  const latestConnectionRef = React.useRef({ connected, stateReady, state: socketState });
  latestConnectionRef.current = { connected, stateReady, state: socketState };
  const navigate = useNavigate();
  const { fights, groups, currentFightIndex, setCurrentFightIndex, completeFight, completeBracketMatch, reconcileFightColors, setPhase, config, bracketMatches, addImportedFights, addTiebreakFights, postponeFight, resetFight, addGuestFight } =
    useTournamentStore(
      useShallow((s) => ({
        fights: s.fights,
        groups: s.groups,
        currentFightIndex: s.currentFightIndex,
        setCurrentFightIndex: s.setCurrentFightIndex,
        completeFight: s.completeFight,
        completeBracketMatch: s.completeBracketMatch,
        reconcileFightColors: s.reconcileFightColors,
        setPhase: s.setPhase,
        config: s.config,
        bracketMatches: s.bracketMatches,
        addImportedFights: s.addImportedFights,
        addTiebreakFights: s.addTiebreakFights,
        postponeFight: s.postponeFight,
        resetFight: s.resetFight,
        addGuestFight: s.addGuestFight,
      }))
    );

  const selectedFight = fights[currentFightIndex];
  const selectedMatchesServer = socketState.categoryId === config.id &&
    socketState.match?.id === selectedFight?.id;
  // An operative server bout remains reviewable even if a stale local snapshot says completed.
  const currentFight = selectedFight?.completed && selectedMatchesServer && !socketState.resultConfirmed
    ? { ...selectedFight, completed: false } : selectedFight;
  const entry = getFightPageEntry(navigationIntent, config.id, fights);
  const passiveEntryRef = React.useRef(entry.mode !== "normal");
  const previousIntentRef = React.useRef(navigationIntent);
  const previousEntryKeyRef = React.useRef(navigationEntryKey);
  const resolvedEntryRef = React.useRef<{ key: string | null; fresh: boolean }>({ key: null, fresh: false });
  if (previousIntentRef.current !== navigationIntent || previousEntryKeyRef.current !== navigationEntryKey) {
    previousIntentRef.current = navigationIntent;
    previousEntryKeyRef.current = navigationEntryKey;
    if (entry.mode !== "normal") passiveEntryRef.current = true;
  }
  const entryInvalid = entry.mode === "invalid";
  // The socket describes the operational bout, not whichever result is being reviewed.
  const state = !selectedMatchesServer
    ? {
        ...socketState,
        rules: null,
        match: null,
        matchState: null,
        matchPaused: false,
        judges: [],
        judgeVotes: {},
        judgeTotals: {},
        penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
        roundFlags: [],
        tulPhase: "idle" as const,
      }
    : socketState;

  const [matchLoaded, setLoaded] = React.useState(false);
  const loaded = matchLoaded && selectedMatchesServer && !currentFight?.completed;
  const userSelectedFightRef = React.useRef<string | null>(null);
  const [confirmRedo, setConfirmRedo] = React.useState(false);
  const [bottomTab, setBottomTab] = React.useState<"mesa" | "porjuez" | "remotos">(
    () => (useTournamentStore.getState().config.matchType === "tul" ? "mesa" : "porjuez")
  );
  // Round Robin rankings use the real flags of each judge. A single "Mesa decide"
  // choice would copy one vote to every judge and corrupt that tiebreak criterion.
  const tableChiefRoundRobin = config.mode !== "elimination" && config.matchType === "sparring";
  const selectedBottomTab = tableChiefRoundRobin ? "porjuez" : bottomTab;
  React.useEffect(() => {
    if (tableChiefRoundRobin && bottomTab !== "porjuez") setBottomTab("porjuez");
  }, [tableChiefRoundRobin, bottomTab]);
  const [showFightList, setShowFightList] = React.useState(false);
  const [restPrompt, setRestPrompt] = React.useState<RestPrompt | null>(null);
  const restOverrideRef = React.useRef<{ categoryId: string; fightId: string; readKey: string } | null>(null);
  const [loadRefusal, setLoadRefusal] = React.useState<{
    categoryId: string; matchId: string; serverState: ServerState; info: BlockedFightInfo;
  } | null>(null);
  const [resultDialogOpen, setResultDialogOpen] = React.useState(false);
  const resultDialogContextRef = React.useRef<{ categoryId: string; matchId: string; revision: number } | null>(null);
  const [isConfirmingResult, setIsConfirmingResult] = React.useState(false);
  const continuationActionRef = React.useRef(false);
  const [resultFlagsRed, setResultFlagsRed] = React.useState(0);
  const [resultFlagsBlue, setResultFlagsBlue] = React.useState(0);
  const [winnerOverlayOpen, setWinnerOverlayOpen] = React.useState(false);
  const [goldenActionPending, setGoldenActionPending] = React.useState(false);
  const goldenActionRef = React.useRef(false);
  const [tulFinishPending, setTulFinishPending] = React.useState(false);
  const [tulFinishError, setTulFinishError] = React.useState<string | null>(null);
  const tulFinishRef = React.useRef(false);
  const [flagCorrectionPending, setFlagCorrectionPending] = React.useState(false);
  const [flagCorrectionView, setFlagCorrectionView] = React.useState<ServerState | null>(null);
  const [flagCorrectionError, setFlagCorrectionError] = React.useState<string | null>(null);
  const flagCorrectionRef = React.useRef(false);
  const [sanctionActionPending, setSanctionActionPending] = React.useState(false);
  const sanctionActionRef = React.useRef(false);
  const [guestDialogOpen, setGuestDialogOpen] = React.useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = React.useState(false);
  const mobileActionsButtonRef = React.useRef<HTMLButtonElement>(null);
  const desktopGuestButtonRef = React.useRef<HTMLButtonElement>(null);
  const guestRedNameRef = React.useRef<HTMLInputElement>(null);
  const guestOpenedFromMobileActionsRef = React.useRef(false);
  const [guestForm, setGuestForm] = React.useState({ red: "", blue: "", category: "", ring: "" });
  // Default: tiebreakerSeconds del config (configurado en Settings), luego overtime_seconds de las reglas, luego 30s
  const [tiebreakerDuration, setTiebreakerDuration] = React.useState(() => {
    const cfg = useTournamentStore.getState().config;
    return cfg.tiebreakerSeconds ?? (cfg.ruleSet as RuleSetSparring)?.rounds?.overtime_seconds ?? 30;
  });
  const draftKey = `${config.id}:${currentFight?.id ?? ""}`;
  const [timingDraft, setTimingDraft] = React.useState<{ key: string; seconds: string | null; rounds: number | null } | null>(null);
  const preloadDurationInput = timingDraft?.key === draftKey ? timingDraft.seconds : null;
  const preloadRounds = timingDraft?.key === draftKey ? timingDraft.rounds : null;
  const [timingSaving, setTimingSaving] = React.useState(false);
  const timingSavingRef = React.useRef(false);
  const [postponePending, setPostponePending] = React.useState(false);
  const [postponeError, setPostponeError] = React.useState<string | null>(null);
  const postponeBusyRef = React.useRef(false);
  const postponeRequestRef = React.useRef<{requestId:string;categoryId:string;matchId:string;expectedRevision:number;expectedLoadId:string} | null>(null);
  const [swapPending, setSwapPending] = React.useState(false);
  const [swapError, setSwapError] = React.useState<string | null>(null);
  const swapBusyRef = React.useRef(false);
  const swapRequestRef = React.useRef<MatchSwapRequest | null>(null);
  React.useEffect(() => () => {
    const pending = swapRequestRef.current;
    if (pending) markLocalSwapPending(pending.categoryId, pending.matchId, false);
  }, []);
  const [timingRecovery, setTimingRecovery] = React.useState<string | null>(null);
  const prevIsFinishedRef = React.useRef<boolean | null>(null);
  const prevPhaseRef = React.useRef<string>("idle");

  function selectFight(index: number): void {
    const selected = fights[index];
    if (!selected) return;
    userSelectedFightRef.current = selected.id;
    restOverrideRef.current = null;
    setRestPrompt(null);
    setLoaded(false);
    setWinnerOverlayOpen(false);
    setFlagCorrectionView(null);
    setFlagCorrectionError(null);
    setResultDialogOpen(false);
    setLoadRefusal(null);
    setCurrentFightIndex(index);
  }
  // History navigation is explicit local selection, not bout loading or queue progression.
  // A later fresh broadcast may resolve the own loaded bout once, unless the user browsed away.
  React.useLayoutEffect(() => {
    if (entry.mode !== "passive") return;
    const previous = resolvedEntryRef.current;
    const newEntry = previous.key !== navigationEntryKey;
    const fresh = connected && stateReady;
    if (!newEntry && (previous.fresh || !fresh || userSelectedFightRef.current !== null)) return;
    const latest = useTournamentStore.getState();
    if (latest.config.id !== config.id) return;
    const validated = getFightPageEntry(navigationIntent, latest.config.id, latest.fights);
    if (validated.mode !== "passive") return;
    const lock = describeFightLock(socketState, latest.config.id, latest.fights);
    const targetId = fresh && lock?.categoryId === latest.config.id && lock.localIndex !== null
      ? lock.fightId : validated.intent.fightId;
    const index = latest.fights.findIndex((fight) => fight.id === targetId);
    resolvedEntryRef.current = { key: navigationEntryKey, fresh };
    if (newEntry) userSelectedFightRef.current = null;
    if (index >= 0 && latest.currentFightIndex !== index) latest.setCurrentFightIndex(index);
  }, [navigationEntryKey, navigationIntent, entry.mode, config.id, connected, stateReady, socketState]);
  const refusedInfo = loadRefusal?.categoryId === config.id && loadRefusal.matchId === currentFight?.id &&
    loadRefusal.serverState === socketState ? loadRefusal.info : null;
  const fightLockNotice = describeFightLock(socketState, config.id, fights, refusedInfo);
  const otherFightLocked = !!fightLockNotice &&
    (fightLockNotice.categoryId !== config.id || fightLockNotice.fightId !== currentFight?.id);
  const reviewingOtherFight = otherFightLocked;
  const categoryInteractionBlocked = useCategoryInteractionBlocked();
  const canLoadFight = connected && stateReady && !otherFightLocked && !entryInvalid && !categoryInteractionBlocked;
  const colorsAligned = !selectedMatchesServer || fightColorsMatch(selectedFight, socketState.match);
  const swapUnresolved = swapRequestRef.current !== null;
  const canOperateFight = canLoadFight && selectedMatchesServer && colorsAligned && !swapUnresolved &&
    socketState.matchState !== null
    && !socketState.resultConfirmed;
  const canRedoFight = canLoadFight;

  function beginExplicitOperation(requireLoaded = true): boolean {
    if (categoryRestartInteractionBlocked()) return false;
    const latest = latestConnectionRef.current;
    const local = useTournamentStore.getState();
    const selected = local.fights[local.currentFightIndex];
    const lock = describeFightLock(latest.state, local.config.id, local.fights);
    if (!latest.connected || !latest.stateReady || categoryExecutionUnavailable(local.config.id) || local.config.id !== config.id
      || selected?.id !== currentFight?.id || !selected
      || getFightPageEntry(navigationIntent, local.config.id, local.fights).mode === "invalid"
      || (lock && (lock.categoryId !== local.config.id || lock.fightId !== selected.id))
      || (requireLoaded && (latest.state.categoryId !== local.config.id
        || latest.state.match?.id !== selected.id || !latest.state.matchState
        || !fightColorsMatch(selected, latest.state.match) || !!swapRequestRef.current
        || (!!latest.state.match.preFight && (latest.state.match.preFight.swapCount ?? 0) > 0 &&
          !latest.state.match.preFight.loadId)
        || latest.state.resultConfirmed))) return false;
    passiveEntryRef.current = false;
    return true;
  }

  function returnToLockedFight(): void {
    if (!fightLockNotice || fightLockNotice.categoryId !== config.id) return;
    const latest = useTournamentStore.getState();
    if (latest.config.id !== config.id) return;
    const index = latest.fights.findIndex((fight) => fight.id === fightLockNotice.fightId);
    if (index === -1 || fights[index]?.id !== fightLockNotice.fightId) return;
    selectFight(index);
  }
  async function handlePostpone(): Promise<void> {
    if (postponeBusyRef.current || !currentFight || !beginExplicitOperation(false)) return;
    const timing = state.match?.preFight;
    const cached = postponeRequestRef.current;
    const retry = cached?.categoryId === config.id && cached.matchId === currentFight.id;
    if (!retry && (!beginExplicitOperation() || !timing?.loadId || timing.started || state.matchPaused || phase !== "idle")) return;
    const payload = retry ? cached : { requestId: crypto.randomUUID(), categoryId: config.id,
      matchId: currentFight.id, expectedRevision: timing!.revision, expectedLoadId: timing!.loadId! };
    postponeRequestRef.current = payload;
    postponeBusyRef.current = true; setPostponePending(true); setPostponeError(null);
    type Reply = {ok:boolean;error?:string};
    try {
      // An uncertain ACK must retry the same durable receipt, never a new release.
      const response = await request<Reply>("match:postpone", payload)
        .catch(() => request<Reply>("match:postpone", payload));
      if (!response?.ok) { postponeRequestRef.current = null; throw new Error(response?.error ?? "No se pudo postergar el combate."); }
      const latest = useTournamentStore.getState();
      const active = latestConnectionRef.current.state;
      if (latest.config.id !== payload.categoryId || latest.fights[latest.currentFightIndex]?.id !== payload.matchId
        || categoryRestartInteractionBlocked()
        || (active.match && (active.match.id !== payload.matchId || active.categoryId !== payload.categoryId
          || active.match.preFight?.loadId !== payload.expectedLoadId))) throw new Error("El tatami liberó el combate, pero la selección cambió. Revisá la lista antes de continuar.");
      postponeFight(payload.matchId);
      postponeRequestRef.current = null; setLoaded(false);
    } catch (error) {
      setPostponeError(error instanceof Error ? error.message : "No hubo confirmación. Revisá la conexión y reintentá Postergar.");
    } finally { postponeBusyRef.current = false; setPostponePending(false); }
  }
  async function handleSwapCompetitors(): Promise<void> {
    if (swapBusyRef.current || !currentFight || !connected || !stateReady || !loaded ||
      !selectedMatchesServer || !untouchedPreStart(state) || config.matchType !== "sparring" ||
      currentFight.isTiebreakExtra || currentFight.isGoldenPointFight ||
      timingKind === "continuation" || categoryRestartInteractionBlocked()) return;
    const previous = swapRequestRef.current;
    const retry = previous?.categoryId === config.id && previous.matchId === currentFight.id;
    if (previous && !retry) return;
    const match = state.match;
    const preFight = match?.preFight;
    if (!match || !preFight?.loadId || (!retry && !canOperateFight)) return;
    const requestPayload: MatchSwapRequest = retry ? previous : {
      requestId: crypto.randomUUID(), categoryId: config.id, matchId: currentFight.id,
      expectedRevision: preFight.revision,
      expectedLoadId: preFight.loadId,
      expectedRedId: match.red.id, expectedBlueId: match.blue.id,
    };
    swapRequestRef.current = requestPayload;
    markLocalSwapPending(requestPayload.categoryId, requestPayload.matchId, true);
    swapBusyRef.current = true;
    setSwapPending(true);
    setSwapError(null);
    try {
      const reply = await request<MatchSwapReply>("match:swapCompetitors", requestPayload);
      // A newer canonical state may have superseded this in-flight ACK.
      if (swapRequestRef.current !== requestPayload) return;
      if (!reply) throw new Error("No llegó la confirmación. Reintentá con el mismo pedido; no inicies el combate.");
      if (!reply.ok) {
        swapRequestRef.current = null;
        markLocalSwapPending(requestPayload.categoryId, requestPayload.matchId, false);
        throw new Error(reply.error ?? "El servidor rechazó el intercambio de competidores.");
      }
      const canonical = reply.match;
      if (canonical && (canonical.id !== requestPayload.matchId ||
        canonical.red.id !== requestPayload.expectedBlueId ||
        canonical.blue.id !== requestPayload.expectedRedId ||
        canonical.preFight?.loadId !== requestPayload.expectedLoadId ||
        canonical.preFight.revision <= requestPayload.expectedRevision)) {
        throw new Error("La respuesta no coincide con el intercambio esperado. Revisá el tatami.");
      }
      const synced = await waitForSocketState((next) =>
        next.categoryId === requestPayload.categoryId && next.match?.id === requestPayload.matchId &&
        next.match.red.id === requestPayload.expectedBlueId &&
        next.match.blue.id === requestPayload.expectedRedId &&
        next.match.preFight?.loadId === requestPayload.expectedLoadId &&
        next.match.preFight.revision > requestPayload.expectedRevision);
      if (swapRequestRef.current !== requestPayload) return;
      if (!synced) throw new Error("El servidor aceptó el intercambio, pero falta sincronizar esta pantalla. Reintentá antes de iniciar.");
      const local = useTournamentStore.getState();
      if (local.config.id !== requestPayload.categoryId ||
        local.fights[local.currentFightIndex]?.id !== requestPayload.matchId ||
        !reconcileFightColors(requestPayload.categoryId, requestPayload.matchId,
          requestPayload.expectedBlueId, requestPayload.expectedRedId)) {
        throw new Error("La selección cambió. Revisá el combate antes de iniciar.");
      }
      swapRequestRef.current = null;
      markLocalSwapPending(requestPayload.categoryId, requestPayload.matchId, false);
      toast.success("Competidores intercambiados. Rojo sigue a la izquierda y azul a la derecha.");
    } catch (error) {
      setSwapError(error instanceof Error ? error.message : "No se pudo verificar el intercambio.");
    } finally {
      swapBusyRef.current = false;
      setSwapPending(false);
    }
  }
  const currentGroupIds = currentFight
    ? groups.find((group) => group.id === (currentFight.groupId ?? "G1"))?.competitors.map((competitor) => competitor.id)
    : undefined;
  const isMiniPlayoff = currentFight ? isMiniRoundRobinBout(currentFight, fights) : false;
  const configuredFightRules = currentFight
    ? applyFightTiming((config.ruleSet as RuleSetSparring) ?? DEFAULT_RULES, config, currentFight, bracketMatches)
    : DEFAULT_RULES;
  const timingKind = currentFight ? preFightTimingKind(currentFight, bracketMatches) : "regular";
  const allowTimingRounds = (selectedMatchesServer ? state.match?.preFight?.timingKind : timingKind) === "elimination-final";
  const baseTimingRules = selectedMatchesServer && state.rules ? state.rules : configuredFightRules;
  const effectiveTimingRounds = preloadRounds ?? (!selectedMatchesServer && config.mode !== "elimination" && timingKind === "regular" ? 1 : baseTimingRules.rounds.count);
  const effectiveTimingSeconds = preloadDurationInput ?? String(baseTimingRules.rounds.duration_seconds);
  const timingDirty = selectedMatchesServer && (effectiveTimingSeconds !== String(state.rules?.rounds.duration_seconds) || effectiveTimingRounds !== state.rules?.rounds.count);
  const timingStartBlocked = (config.matchType === "sparring" && timingKind !== "continuation" &&
    (timingSaving || timingDirty || timingRecovery === draftKey)) ||
    !colorsAligned || !!swapUnresolved || swapPending;
  function emit(event: string, data?: unknown): void {
    if (!beginExplicitOperation() || tulFinishRef.current) return;
    if (event === "tul:finish") { void handleFinishTul(); return; }
    if (event === "match:start" && (timingSavingRef.current || timingStartBlocked ||
      !fightColorsMatch(useTournamentStore.getState().fights[useTournamentStore.getState().currentFightIndex],
        latestConnectionRef.current.state.match))) return;
    emitSocket(event, currentFight
      ? withMatchContext(event, event === "match:start" && state.match?.preFight
        ? { ...(data && typeof data === "object" ? data : {}), expectedTimingRevision: state.match.preFight.revision } : data,
        config.id, currentFight.id, state.match?.preFight)
      : data);
  }
  const { matchState, matchPaused, judges } = state;
  const penaltyCounts = currentFight?.completed
    ? {
        warnings: { red: currentFight.warningsRed ?? 0, blue: currentFight.warningsBlue ?? 0 },
        fouls: { red: currentFight.foulsRed ?? 0, blue: currentFight.foulsBlue ?? 0 },
      }
    : state.penaltyCounts ?? { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } };
  const phase = currentFight?.completed ? "finished" : matchState?.phase ?? "idle";
  const isFinished = phase === "finished";
  const _roundsWon = countRoundsWon(state.roundFlags ?? []);
  // Cuántos jueces van ganando por puntos acumulados (móvil)
  const judgeLeadCount = Object.values(state.judgeTotals ?? {}).reduce(
    (acc, j) => {
      if ((j.red ?? 0) > (j.blue ?? 0)) acc.red += 1;
      else if ((j.blue ?? 0) > (j.red ?? 0)) acc.blue += 1;
      return acc;
    },
    { red: 0, blue: 0 },
  );
  // Banderines manuales del round actual
  const flagCount = (() => {
    const votes = state.judgeVotes ?? {};
    const red = Object.values(votes).filter((v) => v === "red").length;
    const blue = Object.values(votes).filter((v) => v === "blue").length;
    const draw = Object.values(votes).filter((v) => v === "draw").length;
    // Si el resultado es empate pero los votos crudos son asimétricos, ocultar (engañoso)
    const resolved = flagRoundWinner({ red, blue, draw });
    if (resolved === "draw" && red !== blue) return { red: 0, blue: 0 };
    return { red, blue };
  })();
  // Solo muestra número cuando alguien tiene mayoría estricta de jueces
  const hasMobileData = Object.values(state.judgeTotals ?? {}).some(
    (j) => (j.red ?? 0) > 0 || (j.blue ?? 0) > 0,
  );
  const _judgesCount = config.judgesCount ?? 4;
  const scoreDisplay = hasMobileData ? judgeLeadCount : flagCount;
  // Si el combate ya está completado y no está cargado, mostrar el resultado guardado en los paneles
  const displayScore = (currentFight?.completed && !loaded)
    ? { red: currentFight.flagsRed ?? 0, blue: currentFight.flagsBlue ?? 0 }
    : scoreDisplay;
  const timeLeft = currentFight?.completed ? 0 : matchState?.timeLeft ?? 0;
  const currentRound = matchState?.currentRound ?? 1;
  const totalRounds = state.rules?.rounds.count ?? 2;
  const isLastRound = currentRound >= totalRounds;
  const isRunning = phase === "round" || phase === "overtime" || phase === "golden_point";
  // Última pelea pendiente de su llave (solo si tiene groupId y no está completada)
  const isLastInGroup = (() => {
    if (!currentFight || currentFight.completed) return false;
    const gid = currentFight.groupId;
    if (!gid) return false;
    const groupFights = fights.filter(
      (f) => f.groupId === gid && !f.importedFrom && !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight
    );
    return groupFights.filter((f) => f.id !== currentFight.id && !f.completed).length === 0;
  })();
  /** Modo Tul: los competidores ejecutan formas, los jueces votan rojo/azul */
  const isTul = config.matchType === 'tul';
  const canEditLiveSanctions = loaded && !isTul && canOperateFight &&
    (phase === "round" || phase === "overtime");
  const canReviewSanctions = loaded && !isTul && canOperateFight && !state.resultConfirmed &&
    state.categoryId === config.id && state.match?.id === currentFight?.id &&
    canReviewPostClockSanctions(phase, matchState?.result?.reason);
  const canEditPreloadDuration = !isTul && !currentFight?.isGoldenPointFight &&
    !currentFight?.isTiebreakExtra &&
    !(state.match?.id === currentFight?.id && state.categoryId === config.id);
  const tulPhase = state.tulPhase ?? "idle";
  const canEditLoadedTiming = loaded && !isTul && !!state.rules && timingKind !== "continuation" && phase === "idle" &&
    state.match?.preFight?.started === false && state.match.preFight.timingKind !== "continuation" &&
    !state.matchState?.firstPoint && state.matchState?.rounds.every((round) => round.events.length === 0) &&
    Object.keys(state.judgeVotes ?? {}).length === 0 && (state.roundFlags?.length ?? 0) === 0 &&
    Object.values(state.penaltyCounts?.warnings ?? {}).every((count) => count === 0) &&
    Object.values(state.penaltyCounts?.fouls ?? {}).every((count) => count === 0) &&
    Object.values(state.judgeTotals ?? {}).every((totals) => Object.values(totals).every((count) => count === 0));

  React.useEffect(() => {
    if (timingRecovery === draftKey && connected && stateReady && selectedMatchesServer && !timingDirty) {
      setTimingRecovery(null);
    }
  }, [timingRecovery, draftKey, connected, stateReady, selectedMatchesServer, timingDirty]);

  function renderTimingSettings(inputId: string): React.JSX.Element {
    return <PreFightSettings seconds={effectiveTimingSeconds} rounds={effectiveTimingRounds}
      allowRounds={allowTimingRounds} inputId={inputId}
      whiteBand={config.gradeSystem === "GUPS" && config.gupBand === "Blancos y Puntas Amarillas"}
      disabled={loaded && !canOperateFight} busy={timingSaving}
      dirty={loaded ? timingDirty : preloadDurationInput !== null || preloadRounds !== null}
      onChange={(seconds, rounds) => setTimingDraft({key:draftKey,seconds,rounds})}
      onReset={() => setTimingDraft({key:draftKey,seconds:String(configuredFightRules.rounds.duration_seconds),
        rounds:allowTimingRounds ? configuredFightRules.rounds.count : null})}
      onSave={loaded ? () => { void saveTimingSettings(); } : undefined} />;
  }

  function renderMobileTimingSettings(inputId: string): React.JSX.Element {
    const duration = /^\d+$/.test(effectiveTimingSeconds)
      ? `${effectiveTimingSeconds} s` : "duración pendiente";
    return (
      <details key={`${draftKey}-${inputId}`} data-testid="mobile-timing-details"
        className="w-full rounded-xl border border-border bg-card/40 px-3 py-2">
        <summary className="flex min-h-11 cursor-pointer items-center rounded-md text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Ajustes de este combate · {effectiveTimingRounds} {effectiveTimingRounds === 1 ? "round" : "rounds"} · {duration}
          {(timingDirty || timingRecovery === draftKey) && <span className="ml-1 text-amber-300">· Revisar antes de iniciar</span>}
        </summary>
        <div className="flex justify-center border-t border-border/50 pt-3">
          {renderTimingSettings(inputId)}
        </div>
      </details>
    );
  }

  async function saveTimingSettings(): Promise<void> {
    if (timingSavingRef.current || !canEditLoadedTiming || !currentFight || !beginExplicitOperation()) return;
    const revision = state.match?.preFight?.revision;
    if (revision == null) return;
    let rules: RuleSetSparring;
    try { rules = applyPreFightSettings(baseTimingRules, effectiveTimingSeconds, allowTimingRounds ? effectiveTimingRounds : null, timingKind, config.mode); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Ajustes inv\u00e1lidos."); return; }
    timingSavingRef.current = true; setTimingSaving(true);
    type Reply = {ok: boolean; error?: string; rules?: RuleSetSparring; preFight?: {revision:number;started:boolean}};
    const payload = {categoryId:config.id,matchId:currentFight.id,expectedRevision:revision,
      ...((state.match?.preFight?.swapCount ?? 0) > 0
        ? { expectedLoadId: state.match?.preFight?.loadId } : {}),
      durationSeconds:rules.rounds.duration_seconds,rounds:rules.rounds.count};
    try {
      let response = await request<Reply>("match:configure", payload, 7000).catch(() => null);
      if (!response) {
        setTimingRecovery(draftKey);
        response = await request<Reply>("match:configuration", {categoryId:config.id,matchId:currentFight.id}, 7000);
        if (!response?.ok || response.preFight?.started || response.rules?.rounds.duration_seconds !== payload.durationSeconds || response.rules?.rounds.count !== payload.rounds) {
          throw new Error("No se pudo verificar el guardado. Reconect\u00e1 y revis\u00e1 los ajustes antes de iniciar.");
        }
      }
      if (!response.ok) {
        await request<Reply>("match:configuration", {categoryId:config.id,matchId:currentFight.id}, 7000);
        throw new Error(response.error ?? "El servidor rechaz\u00f3 los ajustes.");
      }
      setTimingRecovery(null);
      // Keep draft until the canonical broadcast matches; never set clock or reset the bout locally.
      toast.success("Ajustes guardados en el servidor.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo guardar. Revis\u00e1 la conexi\u00f3n.");
    } finally { timingSavingRef.current=false; setTimingSaving(false); }
  }


  React.useEffect(() => {
    const displayed = resultDialogContextRef.current;
    if (!resultDialogOpen || !displayed) return;
    if (state.categoryId === displayed.categoryId && state.match?.id === displayed.matchId &&
      (state.resultRevision ?? 0) === displayed.revision && state.matchState?.result &&
      state.matchState.phase === "finished") return;
    resultDialogContextRef.current = null;
    setResultDialogOpen(false);
    toast.warning("El resultado cambió en el tatami. Revisá la votación actual antes de confirmar.");
  }, [resultDialogOpen, state.categoryId, state.match?.id, state.resultRevision, state.matchState?.phase, state.matchState?.result]);



  // biome-ignore lint/correctness/useExhaustiveDependencies: setLoaded/setConfirmRedo are stable state setters — no need in deps
  React.useEffect(() => {
    setLoaded(false);
    setConfirmRedo(false);
  }, [config.id, currentFight?.id]);

  // Reconnect is recovery again; an ordinary click is only navigation.
  React.useEffect(() => {
    if (!connected) userSelectedFightRef.current = null;
  }, [connected]);

  // Chicharra de campana al terminar el round (round → rest/penalties/finished)
  React.useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    if (!loaded) return;
    const endingPhases = ["round", "overtime", "golden_point"];
    const finishedPhases = ["rest", "penalties", "finished"];
    if (endingPhases.includes(prev) && finishedPhases.includes(phase)) {
      playBell();
    }
  }, [phase, loaded]);

  // Mostrar overlay de ganador cuando el combate termina (solo en la transición false→true Y si el combate está cargado)
  React.useEffect(() => {
    const prev = prevIsFinishedRef.current;
    prevIsFinishedRef.current = isFinished;
    if (prev === false && isFinished && matchState?.result != null && loaded && !tulFinishRef.current) {
      setWinnerOverlayOpen(true);
    }
    if (!isFinished && !flagCorrectionRef.current) {
      setWinnerOverlayOpen(false);
    }
  // biome-ignore lint/correctness/useExhaustiveDependencies: matchState.result identity changes on every broadcast — use isFinished as proxy
  }, [isFinished, matchState?.result, loaded]);

  // Listen for fights imported by Mesa Central from another tatami.
  // The server emits 'fights:imported' after a successful import-fights call.
  React.useEffect(() => {
    if (!socket) return;
    function onFightsImported(payload: { categoryId?: string | null; fights: Array<{ id: string; red: { id: string; name: string }; blue: { id: string; name: string }; completed: boolean; groupId?: string }>; sourceRingLabel?: string | null }) {
      if (passiveEntryRef.current) return;
      if (payload.categoryId !== config.id) return;
      const srcLabel = payload.sourceRingLabel ?? "Mesa Central";
      addImportedFights(
        payload.fights.map((f) => ({
          id: f.id,
          red: { id: f.red.id, name: f.red.name },
          blue: { id: f.blue.id, name: f.blue.name },
          completed: false,
          groupId: f.groupId,
          importedFrom: srcLabel,
        }))
      );
      toast.warning(
        `📥 ${payload.fights.length} pelea${payload.fights.length !== 1 ? "s" : ""} de ${srcLabel}`,
        { description: "Las peleas se agregaron a la lista de este tatami.", duration: 8000 }
      );
    }
    socket.on('fights:imported', onFightsImported);
    return () => { socket.off('fights:imported', onFightsImported); };
  }, [socket, addImportedFights, config.id]);

  // Listen 'fight:remote-completed': el tatami destino terminó una pelea reasignada
  // y nos notifica el resultado para que podamos completarla en nuestro Zustand.
  React.useEffect(() => {
    if (!socket) return;
    function onRemoteCompleted(payload: {
      fightId: string;
      categoryId?: string | null;
      winner: string;
      flagsRed: number;
      flagsBlue: number;
      completedIn: string;
    }) {
      if (passiveEntryRef.current) return;
      if (payload.categoryId !== config.id) return;
      const localFight = useTournamentStore.getState().fights.find((fight) => fight.id === payload.fightId);
      if (!localFight || localFight.completed) return;
      completeFight(
        payload.fightId,
        payload.winner as "red" | "blue" | "draw",
        `Jugada en ${payload.completedIn}`,
        { flagsRed: payload.flagsRed, flagsBlue: payload.flagsBlue },
      );
      const winnerLabel = payload.winner === "red" ? "Rojo" : payload.winner === "blue" ? "Azul" : "Empate";
      toast.success(`✅ Resultado de ${payload.completedIn}: ${winnerLabel} ganó`, {
        description: "Pelea marcada como completada.",
      });
    }
    socket.on('fight:remote-completed', onRemoteCompleted);
    return () => { socket.off('fight:remote-completed', onRemoteCompleted); };
  }, [socket, completeFight, config.id]);

  // Strip any leftover 'importedFrom' fights persisted from a previous session.
  // Guest fights (EXT: prefix) are intentional and stay.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount to clear stale imported fights
  React.useEffect(() => {
    if (passiveEntryRef.current || categoryRestartInteractionBlocked()) return;
    useTournamentStore.setState((s) => ({
      fights: s.fights.filter((f) => !f.importedFrom || f.groupId?.startsWith("EXT:")),
    }));
  }, []);

  // Auto-load desde DB del servidor al montar. Siempre se ejecuta para detectar
  // peleas importadas mientras la FightPage no estaba abierta (socket event perdido).
  // addImportedFights deduplica por ID, así que es seguro llamarlo aunque el store
  // ya tenga peleas de un torneo local.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed category remounts this page to sync its server queue
  React.useEffect(() => {
    if (passiveEntryRef.current) return;
    fetch(`/api/ring/queue?categoryId=${encodeURIComponent(config.id)}`)
      .then((r) => r.json())
      .then((queue: Array<{ fight: { id: string; categoryId?: string | null; sourceRing: string | null; red: { id: string; name: string }; blue: { id: string; name: string } } }>) => {
        if (passiveEntryRef.current || useTournamentStore.getState().config.id !== config.id) return;
        if (!Array.isArray(queue) || queue.length === 0) return;
        // Only import fights that came from another ring (sourceRing != null).
        // Local fights (sourceRing == null) already live in the Zustand store — importing
        // them here would duplicate them and show them as "Reasignadas desde Mesa Central".
        const fromOtherRing = queue.filter(({ fight }) => fight.categoryId === config.id && !!fight.sourceRing);
        if (fromOtherRing.length === 0) return;
        addImportedFights(
          fromOtherRing.map(({ fight: f }) => ({
            id: f.id,
            red: { id: f.red.id, name: f.red.name },
            blue: { id: f.blue.id, name: f.blue.name },
            completed: false,
            importedFrom: f.sourceRing!,
          }))
        );
      })
      .catch(() => { /* non-critical */ });
  }, [config.id]);

  const loadingMatchRef = React.useRef<string | null>(null);
  function waitForSocketState(predicate: (next: ServerState) => boolean, timeoutMs = 5000): Promise<boolean> {
    if (predicate(latestConnectionRef.current.state)) return Promise.resolve(true);
    if (!socket) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        socket.off("state:update", onStateUpdate);
        resolve(false);
      }, timeoutMs);
      const onStateUpdate = (next: ServerState) => {
        if (!predicate(next)) return;
        window.clearTimeout(timeout);
        socket.off("state:update", onStateUpdate);
        resolve(true);
      };
      socket.on("state:update", onStateUpdate);
    });
  }

  function requestMatchAction(
    event: "mesa:goldenVote" | "mesa:confirmGoldenOutcome" | "mesa:undoRound" | "tul:finish" | "tul:undoFinish",
    payload: Record<string, unknown>,
    matchesUpdate: (next: ServerState) => boolean,
    actionLabel = "Punto de Oro",
  ): Promise<void> {
    if (!socket || !currentFight || !beginExplicitOperation()) {
      return Promise.reject(new Error("No hay conexión con el tatami; no se registró la acción."));
    }
    return new Promise((resolve, reject) => {
      let acknowledged = false;
      let updated = false;
      let settled = false;
      let timeoutId = 0;
      const cleanup = (): void => {
        window.clearTimeout(timeoutId);
        socket.off("state:update", onStateUpdate);
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };
      const complete = (): void => {
        if (settled || !acknowledged || !updated) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onStateUpdate = (next: ServerState): void => {
        if (!matchesUpdate(next)) return;
        updated = true;
        complete();
      };
      socket.on("state:update", onStateUpdate);
      timeoutId = window.setTimeout(() => {
        fail(acknowledged
          ? "El servidor aceptó la acción, pero la pantalla no recibió el estado actualizado. Revisá antes de repetir."
          : "El servidor no confirmó la acción. El voto no avanzó en esta pantalla.");
      }, 6500);
      void request<GoldenActionReply>(event, withMatchContext(event, payload, config.id,
        currentFight.id, state.match?.preFight))
        .then((reply) => {
          if (!reply?.ok) {
            fail(reply?.error ?? "El servidor rechazó la acción de Punto de Oro.");
            return;
          }
          acknowledged = true;
          complete();
        })
        .catch((error: unknown) => {
          fail(error instanceof Error ? error.message : `No se pudo registrar ${actionLabel}.`);
        });
    });
  }

  async function handleGoldenVote(judgeId: string, competitor: "red" | "blue", attempt: number): Promise<void> {
    if (!beginExplicitOperation()) return;
    if (goldenActionRef.current) return;
    if (!currentFight || state.categoryId !== config.id || state.match?.id !== currentFight.id ||
      phase !== "golden_point" || matchState?.goldenPoint?.attempt !== attempt) {
      toast.error("El Punto de Oro cambió de pelea o intento. Revisá el estado antes de votar.");
      return;
    }
    goldenActionRef.current = true;
    setGoldenActionPending(true);
    try {
      await requestMatchAction("mesa:goldenVote", { judgeId, competitor, attempt }, (next) =>
        next.categoryId === config.id && next.match?.id === currentFight.id &&
        next.matchState?.phase === "golden_point" &&
        next.matchState.goldenPoint?.attempt === attempt &&
        next.matchState.goldenPoint.votes[judgeId] === competitor);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo registrar el voto.");
    } finally {
      goldenActionRef.current = false;
      setGoldenActionPending(false);
    }
  }

  async function handleConfirmGoldenOutcome(attempt: number): Promise<void> {
    if (!beginExplicitOperation()) return;
    if (goldenActionRef.current) return;
    const votes = matchState?.goldenPoint?.votes;
    if (!currentFight || state.categoryId !== config.id || state.match?.id !== currentFight.id ||
      phase !== "golden_point" || matchState?.goldenPoint?.attempt !== attempt || !votes) {
      toast.error("El Punto de Oro cambió de pelea o intento. Revisá antes de confirmar.");
      return;
    }
    const judgeCount = state.rules?.judgesCount ?? config.judgesCount;
    const redVotes = Object.values(votes).filter((vote) => vote === "red").length;
    const blueVotes = Object.values(votes).filter((vote) => vote === "blue").length;
    const majority = Math.floor(judgeCount / 2) + 1;
    const winner = redVotes >= majority ? "red" : blueVotes >= majority ? "blue" : null;
    const isDraw = !winner && redVotes + blueVotes === judgeCount && redVotes === blueVotes;
    if (!winner && !isDraw) {
      toast.error("Todavía no hay mayoría ni empate completo para confirmar.");
      return;
    }
    goldenActionRef.current = true;
    setGoldenActionPending(true);
    try {
      await requestMatchAction("mesa:confirmGoldenOutcome", { attempt }, (next) =>
        hasConfirmedGoldenOutcomeUpdate(next, config.id, currentFight.id, attempt, winner));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo confirmar el intento.");
    } finally {
      goldenActionRef.current = false;
      setGoldenActionPending(false);
    }
  }

  function requestSanctionAction(
    side: SanctionSide,
    kind: SanctionKind,
    expectedCount: number,
    count: number,
  ): Promise<SanctionActionReply> {
    if (!socket || !currentFight || !beginExplicitOperation()) {
      return Promise.reject(new Error("Sin conexión con el tatami; no se registró la sanción."));
    }
    const categoryId = config.id;
    const matchId = currentFight.id;
    return new Promise((resolve, reject) => {
      let reply: SanctionActionReply | null = null;
      let updated = false;
      let settled = false;
      const cleanup = (): void => {
        window.clearTimeout(timeoutId);
        socket.off("state:update", onStateUpdate);
      };
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(message));
      };
      const complete = (): void => {
        if (settled || !reply || !updated) return;
        settled = true;
        cleanup();
        resolve(reply);
      };
      const onStateUpdate = (next: ServerState): void => {
        if (!hasSanctionCountUpdate(next, categoryId, matchId, side, kind, count)) return;
        updated = true;
        complete();
      };
      socket.on("state:update", onStateUpdate);
      const timeoutId = window.setTimeout(() => fail(reply
        ? "La sanción se aceptó, pero no llegó el estado actualizado. Revisá antes de reintentar."
        : "El servidor no confirmó la sanción. Revisá antes de reintentar."), 7500);
      void request<SanctionActionReply>("mesa:setSanctionCount", withMatchContext("mesa:setSanctionCount", {
        categoryId,
        matchId,
        competitor: side,
        kind,
        expectedCount,
        count,
      }, categoryId, matchId, state.match?.preFight), 7000).then((response) => {
        if (!response?.ok) {
          fail(response?.error ?? (response?.code === "stale_count"
            ? "Otra mesa cambió la sanción. Revisá los valores actuales antes de reintentar."
            : "El servidor rechazó el cambio de sanción."));
          return;
        }
        if (!response.counts || sanctionCount(response.counts, side, kind) !== count) {
          fail("La respuesta del servidor no coincide con el valor solicitado. Revisá la sanción.");
          return;
        }
        reply = response;
        complete();
      }).catch((error: unknown) => {
        fail(error instanceof Error ? error.message : "No se pudo guardar la sanción.");
      });
    });
  }

  async function handleReviewSanction(
    side: SanctionSide,
    kind: SanctionKind,
    delta: -1 | 1,
  ): Promise<void> {
    if (sanctionActionRef.current) return;
    if (!canReviewSanctions || !currentFight) {
      toast.error("La revisión de sanciones ya no está disponible para esta pelea.");
      return;
    }
    const expectedCount = sanctionCount(penaltyCounts, side, kind);
    const count = expectedCount + delta;
    if (count < 0) return;
    sanctionActionRef.current = true;
    setSanctionActionPending(true);
    try {
      const reply = await requestSanctionAction(side, kind, expectedCount, count);
      if (phase === "finished") {
        const checked = await request<{ ok: boolean; result: MatchResultRecord | null }>(
          "match:result:get", { categoryId: config.id, matchId: currentFight.id },
        );
        const result = checked?.result;
        if (!checked?.ok || !result || result.fightId !== currentFight.id ||
          result.categoryId !== config.id || !reply.counts ||
          result.warningsRed !== reply.counts.warnings.red ||
          result.warningsBlue !== reply.counts.warnings.blue ||
          result.foulsRed !== reply.counts.fouls.red ||
          result.foulsBlue !== reply.counts.fouls.blue) {
          throw new Error("El estado cambió, pero no se pudo verificar el fallo guardado. Revisá antes de confirmar.");
        }
      }
      toast.success("Sanción guardada y verificada en el servidor.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo confirmar la sanción.");
    } finally {
      sanctionActionRef.current = false;
      setSanctionActionPending(false);
    }
  }

  function handleScoreSanction(
    side: SanctionSide,
    kind: SanctionKind,
    delta: -1 | 1,
  ): void {
    dispatchScoreSanctionAction(side, kind, delta, canEditLiveSanctions, canReviewSanctions,
      (competitor, type) => emit("match:event", { judgeId: "arbiter", competitor, type }),
      (competitor, sanctionKind, adjustment) => {
        void handleReviewSanction(competitor, sanctionKind, adjustment);
      });
  }

  async function checkRestBeforeLoad(fightId: string): Promise<boolean> {
    if (config.mode === "elimination" || config.matchType !== "sparring" || selectedFight?.completed) {
      return true;
    }
    const live = latestConnectionRef.current.state;
    if (live.categoryId === config.id && live.match?.id === fightId && !live.resultConfirmed) {
      if (live.matchState?.phase !== "idle") {
        toast.warning("El combate ya está activo o pendiente de confirmación; no se volvió a cargar.");
        return false;
      }
      // Changing pre-fight settings on this already loaded bout is not a new scheduling choice.
      if (live.match.preFight?.loadId) return true;
    }
    let read: LastConfirmedRestRead;
    try {
      const response = await fetch(`/api/ring/categories/${encodeURIComponent(config.id)}/last-confirmed`,
        { cache: "no-store" });
      read = response.ok ? parseLastConfirmedRestReply(await response.json()) : { kind: "unavailable" };
    } catch {
      read = { kind: "unavailable" };
    }
    const latest = useTournamentStore.getState();
    if (latest.config.id !== config.id || latest.fights[latest.currentFightIndex]?.id !== fightId ||
      !beginExplicitOperation(false)) return false;
    if (read.kind === "known" && read.last?.categoryId !== undefined &&
      read.last.categoryId !== config.id) read = { kind: "unavailable" };
    const advisory = read.kind === "known" && read.last
      ? findRoundRobinRestAdvisory(latest.fights, fightId, read.last, (fight) => {
          const expectedIds = latest.groups.find((group) => group.id === (fight.groupId ?? "G1"))
            ?.competitors.map((competitor) => competitor.id);
          return isAuthorizedPlayoffFight(fight, latest.fights, expectedIds);
        })
      : { kind: "none" } as const;
    if (read.kind === "known" && advisory.kind === "none") {
      setRestPrompt(null);
      return true;
    }
    const readKey = restReadKey(read);
    const override = restOverrideRef.current;
    if (override?.categoryId === config.id && override.fightId === fightId &&
      override.readKey === readKey) {
      setRestPrompt(null);
      return true;
    }
    setRestPrompt({ categoryId: config.id, fightId, read, advisory });
    return false;
  }

  async function handleLoad(): Promise<boolean> {
    if (!currentFight) return false;
    if (!beginExplicitOperation(false)) return false;
    if (config.mode !== "elimination" && !isAuthorizedPlayoffFight(currentFight, fights, currentGroupIds)) {
      toast.error("Esta pelea extra no fue creada después de cerrar la llave. Revisá la clasificación antes de cargarla.");
      return false;
    }
    try {
      if (canEditPreloadDuration) applyPreFightSettings(configuredFightRules, preloadDurationInput, preloadRounds, timingKind, config.mode);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Duración inválida.");
      return false;
    }
    if (!canLoadFight) {
      toast.error(otherFightLocked ? fightLockNotice?.message : "No hay conexión sincronizada con el tatami. La pelea no se cargó.");
      return false;
    }
    const recordRefusal = (info: BlockedFightInfo): string => {
      const latest = useTournamentStore.getState();
      const latestState = latestConnectionRef.current.state;
      // A refusal belongs to the attempted selection, not a different tab/fight
      // opened while its acknowledgement was in flight. A new broadcast supersedes it.
      if (latest.config.id === config.id && latest.fights[latest.currentFightIndex]?.id === currentFight.id &&
        !(latestState.match?.id === info.blockedFightId && latestState.categoryId === info.blockedCategoryId && latestState.resultConfirmed)) {
        setLoadRefusal({ categoryId: config.id, matchId: currentFight.id, serverState: latestState, info });
      }
      return describeFightLock(latestState, config.id, latest.fights, info)?.message ?? "Otro combate ocupa el tatami.";
    };
    const requestKey = `${config.id}:${currentFight.id}`;
    if (loadingMatchRef.current === requestKey) return false;
    loadingMatchRef.current = requestKey;
    if (!await checkRestBeforeLoad(currentFight.id)) {
      loadingMatchRef.current = null;
      return false;
    }
    useTournamentStore.getState().setCategoryOperationReason("Confirmando la carga del combate con el servidor…");
    try {
      const statusResponse = await fetch("/api/ring/status");
      if (!statusResponse.ok) throw new Error("No se pudo verificar el estado del tatami.");
      const status = await statusResponse.json() as {
        activeMatchLock?: { categoryId: string | null; fightId?: string; resultStatus?: string | null } | null;
      };
      if (status.activeMatchLock && (status.activeMatchLock.categoryId !== config.id ||
        (status.activeMatchLock.fightId && status.activeMatchLock.fightId !== currentFight.id))) {
        const lock = status.activeMatchLock;
        throw new Error(lock.fightId ? recordRefusal({ blockedFightId: lock.fightId,
          blockedCategoryId: lock.categoryId, pendingConfirmation: lock.resultStatus === "pending_confirmation" })
          : "Otro combate ocupa este tatami. Volvé a su categoría para revisar su estado antes de cargar otra pelea.");
      }
      const uniqueCompetitors = Array.from(new Map(fights.flatMap((fight) => [
        [fight.red.id, { id: fight.red.id, name: fight.red.name, team: fight.red.team }],
        [fight.blue.id, { id: fight.blue.id, name: fight.blue.name, team: fight.blue.team }],
      ])).values());
      if (!beginExplicitOperation(false)) throw new Error("El estado del tatami cambió; no se cargó el combate.");
      const syncResponse = await fetch("/api/ring/sync-fights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryId: config.id,
          categoryName: config.categoryName,
          tournamentName: config.tournamentName,
          competitors: uniqueCompetitors,
          fights: fights.map((fight) => ({
            id: fight.id, red_id: fight.red.id, blue_id: fight.blue.id, completed: fight.completed,
          })),
        }),
      });
      if (!syncResponse.ok) {
        const result = await syncResponse.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "El servidor rechazó la sincronización de peleas.");
      }
    } catch (error) {
      loadingMatchRef.current = null;
      useTournamentStore.getState().setCategoryOperationReason(null);
      toast.error(error instanceof Error ? error.message : "No se pudo sincronizar la categoría.");
      return false;
    }
    if (!beginExplicitOperation(false)) {
      loadingMatchRef.current = null;
      useTournamentStore.getState().setCategoryOperationReason(null);
      return false;
    }
    if (!await checkRestBeforeLoad(currentFight.id)) {
      loadingMatchRef.current = null;
      useTournamentStore.getState().setCategoryOperationReason(null);
      return false;
    }
    if (!beginExplicitOperation(false)) {
      loadingMatchRef.current = null;
      useTournamentStore.getState().setCategoryOperationReason(null);
      return false;
    }
    const baseRules = (config.ruleSet as RuleSetSparring) ?? DEFAULT_RULES;
    // judgingMode must match the UI mode: mobile judges score points, mesa judges vote flags
    let rules: RuleSetSparring = {
      ...baseRules,
      judgingMode: selectedBottomTab === "remotos" ? "points" : "flags",
    };
    rules = applyFightTiming(rules, config, currentFight, bracketMatches);
    if (!isTul) rules = applyPreFightSettings(rules, canEditPreloadDuration ? preloadDurationInput : null, preloadRounds, timingKind, config.mode);
    // A normal round-robin draw is a valid result. Never let a legacy ruleset
    // start an overtime or Golden Point inside that ordinary bout.
    rules = withoutRegularRoundRobinTiebreak(rules, config.mode, currentFight);
    if (currentFight.isGoldenPointFight) {
      rules = { ...rules, rounds: { ...rules.rounds, golden_point: true, overtime_seconds: 0 } };
    }
    // Consent applies to this single load attempt only. A failed or later load is checked again.
    restOverrideRef.current = null;
    const response = await request<MatchLoadReply>("match:load", {
      categoryId: config.id,
      tournamentName: config.tournamentName,
      rules,
      match: {
        id: currentFight.id,
        ...(!isTul ? { timingKind } : {}),
        goldenPoint: currentFight.isGoldenPointFight || undefined,
        requireIndividualFlags: requiresIndividualFlagsForBout(config.mode, currentFight),
        ringId: "ring-1",
        category: config.categoryName || undefined,
    matchMode: (rules as { mode?: string }).mode === 'patterns' ? 'patterns' : config.matchType === 'tul' ? 'tul' : 'sparring',
        red: { id: currentFight.red.id, name: currentFight.red.name, club: currentFight.red.team },
        blue: { id: currentFight.blue.id, name: currentFight.blue.name, club: currentFight.blue.team },
      },
    });
    loadingMatchRef.current = null;
    if (!response?.ok) {
      useTournamentStore.getState().setCategoryOperationReason(null);
      const info = response?.blockedFightId &&
        (typeof response.blockedCategoryId === "string" || response.blockedCategoryId === null)
        ? { blockedFightId: response.blockedFightId, blockedCategoryId: response.blockedCategoryId,
          pendingConfirmation: !!response.pendingConfirmation, blockedRedName: response.blockedRedName,
          blockedBlueName: response.blockedBlueName } : null;
      toast.error(info ? recordRefusal(info) : response?.error ?? "No se pudo confirmar la carga del combate. El estado local no avanzó.");
      return false;
    }
    setLoadRefusal(null);
    if (response.warning) toast.warning(response.warning);
    const stateSynced = await waitForSocketState((next) =>
      next.categoryId === config.id && next.match?.id === currentFight.id && !next.resultConfirmed,
    );
    useTournamentStore.getState().setCategoryOperationReason(null);
    if (!stateSynced) {
      toast.warning("El servidor aceptó la carga, pero todavía no confirmó su estado en esta pantalla. Se conserva el bloqueo del servidor.");
      return false;
    }
    const selectedFight = useTournamentStore.getState().fights[useTournamentStore.getState().currentFightIndex];
    if (selectedFight?.id === currentFight.id && useTournamentStore.getState().config.id === config.id) {
      setLoaded(true);
      return true;
    }
    return false;
  }

  async function handleRedoFight(): Promise<void> {
    if (!beginExplicitOperation(false)) return;
    const latest = latestConnectionRef.current;
    const local = useTournamentStore.getState();
    const selected = local.fights[local.currentFightIndex];
    const lock = latest.state.activeMatchLock;
    const anotherLock = !!lock && (lock.categoryId !== config.id || lock.fightId !== currentFight?.id);
    const anotherMatch = !!latest.state.match && !latest.state.resultConfirmed &&
      (latest.state.categoryId !== config.id || latest.state.match.id !== currentFight?.id);
    if (!latest.connected || !latest.stateReady || anotherLock || anotherMatch ||
      local.config.id !== config.id || selected?.id !== currentFight?.id || !selected?.completed) {
      toast.warning("No se puede rehacer este resultado mientras el tatami está ocupado o sin sincronizar.");
      return;
    }
    // The server may reject a durable completed result. Never erase it locally
    // until it has accepted and broadcast the replacement bout.
    if (!await handleLoad()) return;
    const afterLoad = useTournamentStore.getState();
    if (afterLoad.config.id !== config.id || afterLoad.fights[afterLoad.currentFightIndex]?.id !== selected.id) return;
    resetFight(selected.id);
    setConfirmRedo(false);
  }

  // Auto-cargar combates de desempate y Punto de Oro cuando se convierten en el combate activo
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentFight.id change is the signal; handleLoad uses latest closure
  React.useEffect(() => {
    if (passiveEntryRef.current) return;
    if (userSelectedFightRef.current === currentFight?.id) return;
    if ((currentFight?.isTiebreakExtra || currentFight?.isGoldenPointFight) && !loaded && !currentFight.completed && connected &&
      (config.mode === "elimination" || isAuthorizedPlayoffFight(currentFight, fights, currentGroupIds))) {
      handleLoad();
    }
  }, [currentFight?.id, connected]);

  // Rehidratar `loaded` desde el servidor: si el server ya tiene este combate cargado
  // (porque el usuario navegó a otra página y volvió mientras el match estaba en curso),
  // sincronizar el estado local en vez de mostrar "Cargar combate" — lo cual borraría el match.
  React.useEffect(() => {
    if (loaded) return;
    if (!connected) return;
    if (!currentFight || currentFight.completed) return;
    if (state.categoryId === config.id && state.match?.id === currentFight.id &&
      state.matchState != null && !state.resultConfirmed) {
      setLoaded(true);
      if (passiveEntryRef.current && state.matchState.phase === "finished" && state.matchState.result) {
        setWinnerOverlayOpen(true);
      }
    }
  }, [connected, config.id, currentFight?.id, currentFight?.completed, state.categoryId,
    state.match?.id, state.matchState, state.resultConfirmed, loaded]);

  // Another table-chief tab may have swapped this loaded bout. Persist its canonical
  // operative colors before enabling any color-sensitive action on this tab.
  React.useEffect(() => {
    if (!connected || !stateReady || !selectedMatchesServer || !selectedFight ||
      !state.match || fightColorsMatch(selectedFight, state.match) ||
      swapRequestRef.current?.matchId === selectedFight.id) return;
    reconcileFightColors(config.id, selectedFight.id, state.match.red.id, state.match.blue.id);
  }, [connected, stateReady, selectedMatchesServer, selectedFight, state.match, config.id,
    reconcileFightColors]);

  // A lost ACK cannot be retried once another chief has started or superseded
  // the bout. The fresh server assignment is then authoritative: reconcile it
  // before releasing the local uncertainty gate, never re-send the old swap.
  React.useEffect(() => {
    const pending = swapRequestRef.current;
    if (!pending || !connected || !stateReady || !selectedMatchesServer ||
      selectedFight?.id !== pending.matchId || state.categoryId !== pending.categoryId ||
      state.match?.id !== pending.matchId) return;
    const preFight = state.match.preFight;
    const advanced = !!preFight?.started ||
      (state.matchState != null && state.matchState.phase !== "idle") ||
      !!state.resultConfirmed ||
      (!!preFight?.loadId && preFight.loadId !== pending.expectedLoadId) ||
      (preFight != null && preFight.revision > pending.expectedRevision + 1);
    if (!advanced) return;
    if (!reconcileFightColors(pending.categoryId, pending.matchId,
      state.match.red.id, state.match.blue.id)) {
      setSwapError("El combate avanzó, pero no se pudo verificar quién ocupa cada color. Recargá y revisá el tatami.");
      return;
    }
    swapRequestRef.current = null;
    markLocalSwapPending(pending.categoryId, pending.matchId, false);
    setSwapPending(false);
    setSwapError(null);
    toast.info("El combate avanzó en otro dispositivo. Colores sincronizados con el tatami.");
  }, [connected, stateReady, selectedMatchesServer, selectedFight?.id, state.categoryId,
    state.match, state.matchState, state.resultConfirmed, reconcileFightColors]);

  // Reconcile a durable server result after reload/reconnect before allowing local progression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect and selected fight identify the recovery request
  React.useEffect(() => {
    if (passiveEntryRef.current) return;
    if (!connected || !stateReady || !currentFight || currentFight.completed) return;
    if (userSelectedFightRef.current === currentFight.id) return;
    if (config.mode !== "elimination" && !isAuthorizedPlayoffFight(currentFight, fights, currentGroupIds)) return;
    let cancelled = false;
    function canApplyRecovery(): boolean {
      const latest = useTournamentStore.getState();
      return !cancelled && latest.config.id === config.id &&
        !passiveEntryRef.current &&
        latest.fights[latest.currentFightIndex]?.id === currentFight?.id &&
        !latest.fights.find((fight) => fight.id === currentFight?.id)?.completed &&
        userSelectedFightRef.current !== currentFight?.id;
    }
    void (async () => {
      const identity = { categoryId: config.id, matchId: currentFight.id };
      const response = await request<MatchResultReply>("match:result:get", identity);
      if (cancelled || !response?.ok || !response.result) return;
      // A late acknowledgement must not advance a result that was completed or
      // deliberately selected for review while the recovery request was in flight.
      if (!canApplyRecovery()) return;
      let result = response.result;
      if (result.status === "pending_confirmation"
        && (state.match?.id !== currentFight.id || state.categoryId !== config.id)) {
        const recovered = await requestConfirmedResult(currentFight.id, undefined);
        if (!recovered) return;
        result = recovered;
      }
      if (canApplyRecovery() && result.status === "confirmed" &&
        (result !== response.result || reconcileResultColors(response, currentFight.id)) &&
        applyConfirmedResult(result)) {
        advanceAfterConfirmedResult(result.fightId);
      }
    })();
    return () => { cancelled = true; };
  }, [connected, stateReady, config.id, currentFight?.id]);

  // When judge mode changes while a fight is loaded in "idle", reload so judgingMode matches.
  // If mid-fight, just warn — change takes effect on next fight.
  // In Tul mode, skip: tab changes don't affect judgingMode (always flags), and reloading would reset tulPhase.
  const prevBottomTabRef = React.useRef(selectedBottomTab);
  React.useEffect(() => {
    if (prevBottomTabRef.current === selectedBottomTab) return;
    prevBottomTabRef.current = selectedBottomTab;
    if (passiveEntryRef.current) return;
    if (isTul) return;
    if (!loaded || !currentFight) return;
    if (phase === "idle") {
      handleLoad();
    } else if (phase !== "finished") {
      toast.info("Cambiar modo tiene efecto en la próxima pelea");
    }
  });

  async function handleFinishTul(): Promise<void> {
    if (tulFinishRef.current || !currentFight || !beginExplicitOperation() || state.tulPhase !== "voting") return;
    const categoryId = config.id;
    const matchId = currentFight.id;
    const revision = state.resultRevision ?? 0;
    // Read the latest authoritative votes: single-choice controls may have sent votes just before this request.
    const votes = Object.values(latestConnectionRef.current.state.judgeVotes);
    const red = votes.filter((vote) => vote === "red").length;
    const blue = votes.filter((vote) => vote === "blue").length;
    if (red === blue) {
      setTulFinishError("En formas no se permite empate. Corregí los votos antes de confirmar.");
      return;
    }
    tulFinishRef.current = true;
    setTulFinishPending(true);
    setTulFinishError(null);
    try {
      await requestMatchAction("tul:finish", { expectedRevision: revision }, (next) =>
        next.categoryId === categoryId && next.match?.id === matchId && next.resultRevision === revision &&
        next.tulPhase === "finished" && next.matchState?.phase === "finished" &&
        next.matchState.result?.winner === (red > blue ? "red" : "blue"), "resultado de formas");
      const latest = useTournamentStore.getState();
      if (latest.config.id === categoryId && latest.fights[latest.currentFightIndex]?.id === matchId) setWinnerOverlayOpen(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo guardar el resultado de formas.";
      setTulFinishError(message);
      toast.error(message);
    } finally {
      tulFinishRef.current = false;
      setTulFinishPending(false);
    }
  }

  async function handleCorrectFlags(): Promise<void> {
    if (flagCorrectionRef.current || !currentFight || !loaded || !connected || !stateReady ||
      state.resultConfirmed || state.matchState?.phase !== "finished" ||
      state.matchState.result?.reason !== "points") return;
    if (!beginExplicitOperation()) return;
    const categoryId = config.id;
    const matchId = currentFight.id;
    const revision = state.resultRevision ?? 0;
    flagCorrectionRef.current = true;
    setFlagCorrectionView(state);
    setFlagCorrectionError(null);
    setFlagCorrectionPending(true);
    try {
      await requestMatchAction(isTul ? "tul:undoFinish" : "mesa:undoRound", { expectedRevision: revision },
        (next) => hasReopenedFlagUpdate(next, categoryId, matchId, revision + 1) && (!isTul || next.tulPhase === "voting"),
        "corrección de banderines");
      const latest = useTournamentStore.getState();
      if (latest.config.id !== categoryId || latest.fights[latest.currentFightIndex]?.id !== matchId) return;
      setResultDialogOpen(false);
      setWinnerOverlayOpen(false);
      setFlagCorrectionView(null);
      toast.info("Corregí los banderines de cada juez y volvé a confirmar la votación.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "No se pudo reabrir la votación; el resultado sigue intacto.";
      setFlagCorrectionError(message);
      toast.error(message);
    } finally {
      flagCorrectionRef.current = false;
      setFlagCorrectionPending(false);
    }
  }

  function reconcileResultColors(reply: MatchResultReply, matchId: string): boolean {
    const local = useTournamentStore.getState();
    const fight = local.fights.find((entry) => entry.id === matchId);
    if (!fight || local.config.id !== config.id) return false;
    if (reply.redId || reply.blueId) {
      if (!reply.redId || !reply.blueId ||
        !reconcileFightColors(config.id, matchId, reply.redId, reply.blueId)) {
        toast.error("Los colores del resultado no coinciden con el combate local. No se aplicó el fallo.");
        return false;
      }
      return true;
    }
    // Legacy/mocked replies lack canonical IDs. A matching live bout still lets
    // us validate color mapping, but never trust a known mismatch.
    const live = latestConnectionRef.current.state;
    if (live.categoryId === config.id && live.match?.id === matchId) {
      if (reconcileFightColors(config.id, matchId, live.match.red.id, live.match.blue.id)) return true;
      toast.error("Los colores del tatami no coinciden con el resultado local.");
      return false;
    }
    toast.error("No hay asignación de colores verificable para este resultado. No se avanzó la llave.");
    return false;
  }

  async function requestConfirmedResult(matchId: string, expectedRevision: number | undefined): Promise<MatchResultRecord | null> {
    const identity = { categoryId: config.id, matchId };
    // Confirm exactly the revision displayed to this chief; never silently adopt a newer winner.
    if (expectedRevision === undefined) {
      const recovered = await request<MatchResultReply>("match:result:get", identity);
      // Read-only recovery may apply an already confirmed result, never approve a
      // newly discovered pending revision that this chief has not reviewed.
      if (recovered?.ok && recovered.result?.status === "confirmed" &&
        reconcileResultColors(recovered, matchId)) return recovered.result;
      toast.error("Volvé al combate activo y revisá su resultado antes de confirmarlo.");
      return null;
    }
    if (!beginExplicitOperation()) return null;
    const confirmation = await request<{ ok: boolean; error?: string; result?: MatchResultRecord }>(
      "match:saveFallo",
      withMatchContext("match:saveFallo", { ...identity, expectedRevision },
        config.id, matchId, state.match?.preFight),
    );
    // This active bout could start only after a live pair match. A pre-start
    // swap cannot occur once started, so the confirmation retains that mapping.
    if (confirmation?.ok && confirmation.result?.status === "confirmed") return confirmation.result;

    const recovered = await request<MatchResultReply>(
      "match:result:get",
      identity,
    );
    if (recovered?.ok && recovered.result?.status === "confirmed" &&
      reconcileResultColors(recovered, matchId)) return recovered.result;
    if (confirmation?.error) toast.error(confirmation.error);
    else toast.error("No se pudo verificar el guardado. El combate sigue bloqueado y podés reintentar.");
    return null;
  }

  function applyConfirmedResult(result: MatchResultRecord): boolean {
    if (result.categoryId !== config.id) return false;
    const before = useTournamentStore.getState();
    const target = before.fights.find((fight) => fight.id === result.fightId);
    if (!target) return false;
    const active = latestConnectionRef.current.state;
    if (active.categoryId === config.id && active.match?.id === result.fightId &&
      !fightColorsMatch(target, active.match)) {
      toast.error("El resultado no coincide con los colores activos; no se aplicó el fallo.");
      return false;
    }
    if (target.completed && target.winner !== result.winner) {
      toast.error("El resultado durable no coincide con el resultado local; no se sobrescribió la llave.");
      return false;
    }
    if (!target.completed) {
      restOverrideRef.current = null;
      setRestPrompt(null);
      completeFight(result.fightId, result.winner, result.reason, {
        flagsRed: result.flagsRed,
        flagsBlue: result.flagsBlue,
        warningsRed: result.warningsRed,
        warningsBlue: result.warningsBlue,
        foulsRed: result.foulsRed,
        foulsBlue: result.foulsBlue,
      });
    }
    if (target.bracketMatchId && result.winner !== "draw") {
      const bracketMatch = useTournamentStore.getState().bracketMatches.find((match) => match.id === target.bracketMatchId);
      const winnerId = result.winner === "red" ? target.red.id : target.blue.id;
      if (bracketMatch?.completed && bracketMatch.winnerId !== winnerId) {
        toast.error("La llave ya tiene un ganador distinto; se conservó el estado local para revisión.");
        return false;
      }
      if (bracketMatch && !bracketMatch.completed) completeBracketMatch(target.bracketMatchId, winnerId);
    }
    return true;
  }

  function advanceAfterConfirmedResult(matchId: string) {
    const latest = useTournamentStore.getState();
    const targetIndex = latest.fights.findIndex((fight) => fight.id === matchId);
    if (targetIndex === -1 || latest.currentFightIndex !== targetIndex) return;
    const remainingIncomplete = latest.fights.some((fight) => !fight.completed);
    if (!remainingIncomplete) {
      const bracketStillPending = config.mode === "elimination" && latest.bracketMatches.some((match) => !match.completed);
      if (bracketStillPending) {
        navigate("/bracket");
      } else {
        setPhase("results");
        navigate("/standings");
      }
    } else {
      const nextIndex = latest.fights.findIndex((fight) => !fight.completed);
      if (nextIndex !== -1) setCurrentFightIndex(nextIndex);
    }
    setLoaded(false);
  }

  async function handleStartTiebreaker() {
    if (!currentFight || !beginExplicitOperation(!selectedFight?.completed)) return;
    if (config.mode !== "elimination" &&
      (!currentFight.isFinalFight && !currentFight.isTiebreakExtra && !currentFight.isGoldenPointFight ||
        !isAuthorizedPlayoffFight(currentFight, fights, currentGroupIds))) return;
    if (isMiniPlayoff) return;
    if (continuationActionRef.current || isConfirmingResult || sanctionActionRef.current ||
      flagCorrectionRef.current) return;
    continuationActionRef.current = true;
    setIsConfirmingResult(true);
    const operationReason = "Confirmando el empate antes de continuar…";
    useTournamentStore.getState().setCategoryOperationReason(operationReason);
    try {
      let result: MatchResultRecord | null = null;
      if (config.mode !== "elimination") {
        result = await requestConfirmedResult(currentFight.id,
          resultDialogContextRef.current?.revision);
        if (!result || result.winner !== "draw" || !applyConfirmedResult(result)) return;
      }
      // En una llave: pelea extra, desempate cronometrado y luego Punto de Oro.
      // En la final directa: final, desempate cronometrado y luego Punto de Oro.
      const isGoldenPoint = config.mode === "elimination"
        ? Boolean(currentFight.isTiebreakExtra || currentFight.isGoldenPointFight)
        : nextDirectFightIsGoldenPoint(currentFight, useTournamentStore.getState().fights);
      const playoffBasis = config.mode === "elimination" ? undefined :
        currentFight.playoffBasis ?? closedGroupBasis(currentFight.groupId ?? "G1", useTournamentStore.getState().fights, currentGroupIds);
      if (config.mode !== "elimination" && !playoffBasis) return;

      const proposalStage = JSON.stringify({
        kind: "direct-continuation", currentFightId: currentFight.id,
        playoffBasis, isGoldenPoint,
      });
      const [nextFight] = getOrCreateFightProposal(config.id, proposalStage, () => [{
        id: crypto.randomUUID(),
        red: currentFight.red,
        blue: currentFight.blue,
        completed: false,
        isTiebreakExtra: !isGoldenPoint,
        isGoldenPointFight: isGoldenPoint || undefined,
        playoffKind: "direct",
        playoffBasis: playoffBasis ?? undefined,
        bracketMatchId: currentFight.bracketMatchId ?? currentFight.id,
        tiebreakerSeconds: isGoldenPoint ? undefined : tiebreakerDuration,
        groupId: currentFight.groupId,
        isFinalFight: currentFight.isFinalFight || undefined,
        ...(config.mode === "elimination" ? {
          continuationParentFightId: currentFight.id,
          continuationStage: isGoldenPoint ? "golden-point" as const : "timed-extra" as const,
        } : {}),
      }]);
      if (config.mode === "elimination" && !eliminationContinuationSchema.safeParse({
        parentFightId: currentFight.id, parentRevision: 0,
        proposedFight: { id: nextFight.id, red_id: nextFight.red.id,
          blue_id: nextFight.blue.id,
          stage: isGoldenPoint ? "golden-point" : "timed-extra" },
      }).success) {
        throw new Error("La propuesta de desempate guardada no es válida; revisá el historial antes de confirmar.");
      }
      // Journal and validate the proposed identity before confirming the drawn result.
      if (config.mode === "elimination") {
        result = await requestConfirmedResult(currentFight.id,
          selectedFight?.completed ? undefined : resultDialogContextRef.current?.revision);
        if (!result || result.winner !== "draw" || !applyConfirmedResult(result)) return;
      }
      const beforeAppend = useTournamentStore.getState();
      const sameGroupFights = config.mode === "elimination"
        ? beforeAppend.fights.filter((fight) => fight.id === currentFight.id) :
        beforeAppend.fights.filter((fight) =>
          (fight.groupId ?? "G1") === (currentFight.groupId ?? "G1") &&
          !fight.importedFrom && !fight.groupId?.startsWith("EXT:"));
      if (sameGroupFights.some((fight) => !fight.completed || !fight.winner))
        throw new Error("Faltan peleas de la llave por confirmar antes de continuar.");
      const requiredConfirmedFightIds = sameGroupFights.map((fight) => fight.id);
      let durableFight = nextFight;
      if (config.mode === "elimination") {
        const stage = isGoldenPoint ? "golden-point" as const : "timed-extra" as const;
        const revision = result?.revision ?? 0;
        const canonical = await getCanonicalEliminationContinuation(config.id, currentFight.id) ??
          await syncProposedFights(config, [...beforeAppend.fights, nextFight],
            requiredConfirmedFightIds, { parentFightId: currentFight.id,
              parentRevision: revision, proposedFight: { id: nextFight.id,
                red_id: nextFight.red.id, blue_id: nextFight.blue.id, stage } });
        if (!canonical || canonical.parentFightId !== currentFight.id ||
          canonical.parentRevision !== revision || canonical.stage !== stage ||
          canonical.red_id !== nextFight.red.id || canonical.blue_id !== nextFight.blue.id)
          throw new Error("El desempate canónico no coincide con el empate confirmado.");
        durableFight = { ...nextFight, id: canonical.id,
          continuationParentFightId: canonical.parentFightId,
          continuationStage: canonical.stage };
      } else {
        await syncProposedFights(config, [...beforeAppend.fights, nextFight],
          requiredConfirmedFightIds);
      }
      if (useTournamentStore.getState().config.id !== config.id ||
        useTournamentStore.getState().fights !== beforeAppend.fights) {
        toast.warning("La categoría cambió durante la sincronización; no se avanzó localmente.");
        return;
      }
      if (beforeAppend.fights.some((fight) => fight.id === durableFight.id)) return;
      addTiebreakFights([durableFight]);
      clearFightProposal(config.id, proposalStage, [nextFight]);
      setResultDialogOpen(false);
      setLoaded(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo confirmar el empate.");
    } finally {
      continuationActionRef.current = false;
      setIsConfirmingResult(false);
      if (useTournamentStore.getState().categoryOperationReason === operationReason) {
        useTournamentStore.getState().setCategoryOperationReason(null);
      }
    }
  }

  function handleOpenResultDialog() {
    if (!matchState?.result) return;
    if (!currentFight || state.categoryId !== config.id || state.match?.id !== currentFight.id) return;
    resultDialogContextRef.current = { categoryId: config.id, matchId: currentFight.id,
      revision: state.resultRevision ?? 0 };
    const goldenVotes = matchState.result.reason === "golden_point"
      ? Object.values(matchState.goldenPoint?.votes ?? {})
      : null;
    let fr = goldenVotes
      ? goldenVotes.filter((vote) => vote === "red").length
      : (state.roundFlags ?? []).reduce((s, r) => s + r.red, 0);
    let fb = goldenVotes
      ? goldenVotes.filter((vote) => vote === "blue").length
      : (state.roundFlags ?? []).reduce((s, r) => s + r.blue, 0);
    // En modo puntos (jueces móviles) roundFlags no se llena — usar conteo de jueces líderes
    if (!goldenVotes && fr === 0 && fb === 0) {
      const jt = state.judgeTotals ?? {};
      for (const t of Object.values(jt)) {
        if ((t.red ?? 0) > (t.blue ?? 0)) fr++;
        else if ((t.blue ?? 0) > (t.red ?? 0)) fb++;
      }
    }
    // Mostrar los números reales — el motor ya garantiza que el ganador tiene mayoría estricta.
    // Si llega aquí como empate, los números pueden ser cualquier combinación válida (ej. 2-1-1).
    setResultFlagsRed(fr);
    setResultFlagsBlue(fb);
    setResultDialogOpen(true);
  }

  async function handleConfirmResult() {
    if (!beginExplicitOperation()) return;
    if (!currentFight) return;
    if (config.mode !== "elimination" && !isAuthorizedPlayoffFight(currentFight, fights, currentGroupIds)) {
      toast.error("La pelea extra requiere revisión; no se confirmó ni avanzó la llave.");
      return;
    }
    if (isConfirmingResult || sanctionActionRef.current || flagCorrectionRef.current) return;
    const winner = matchState?.result?.winner;
    if (!winner) return;
    // En eliminación, final, desempate y Punto de Oro: los empates deben seguir peleando — nunca confirmar directo
    const requiresWinner = config.mode === "elimination" || currentFight.isGoldenPointFight ||
      ((currentFight.isFinalFight || currentFight.isTiebreakExtra) && !isMiniPlayoff);
    if (winner === "draw" && requiresWinner) return;
    setIsConfirmingResult(true);
    const operationReason = "Guardando el resultado confirmado…";
    useTournamentStore.getState().setCategoryOperationReason(operationReason);
    try {
      const result = await requestConfirmedResult(currentFight.id, resultDialogContextRef.current?.revision);
      if (!result || result.winner !== winner || !applyConfirmedResult(result)) return;
      setResultDialogOpen(false);
      advanceAfterConfirmedResult(currentFight.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo confirmar el resultado.");
    } finally {
      setIsConfirmingResult(false);
      if (useTournamentStore.getState().categoryOperationReason === operationReason) {
        useTournamentStore.getState().setCategoryOperationReason(null);
      }
    }
  }

  if (fights.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
        <p>No hay combates. Configura la categoría primero.</p>
        {entry.mode === "normal" && <button
          type="button"
          onClick={async () => {
            try {
              if (!connected || !stateReady || socketState.activeMatchLock) return;
              const response = await fetch("/api/ring/full-reset", { method: "POST" });
              if (!response.ok) toast.error("El servidor rechazó el reinicio; no se borraron datos locales.");
            } catch { toast.error("No se pudo reiniciar el tatami."); }
          }}
          className="text-xs text-destructive underline underline-offset-2 hover:opacity-80"
        >
          Limpiar estado anterior y empezar de cero
        </button>}
      </div>
    );
  }

  // Solo usar los nombres del servidor cuando el combate está cargado — si no, usar los locales
  const redName = (loaded ? state.match?.red.name : undefined) ?? currentFight?.red.name ?? "Rojo";
  const blueName = (loaded ? state.match?.blue.name : undefined) ?? currentFight?.blue.name ?? "Azul";

  const overlayState = flagCorrectionView ?? state;
  const overlayMatchState = overlayState.matchState;

  return (
    <div data-testid="fight-content-scroll" className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain scroll-pt-24 pb-3 md:overflow-hidden md:pb-0">
      {tulFinishError && <p role="alert" className="px-4 py-2 text-sm text-destructive">{tulFinishError}</p>}
      {tulFinishPending && <p role="status" className="px-4 py-2 text-sm">Guardando resultado de formas...</p>}

      {/* ── WINNER OVERLAY ──────────────────────────────────── */}
      <Dialog open={loaded && winnerOverlayOpen} onOpenChange={(open) => {
        if (flagCorrectionPending) return;
        setWinnerOverlayOpen(open);
        if (!open) { setFlagCorrectionView(null); setFlagCorrectionError(null); }
      }}>
        <DialogContent className="max-w-sm p-0 overflow-hidden border-0 [&>button:last-child]:hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Resultado del combate</DialogTitle>
          </DialogHeader>
          {overlayMatchState?.result && (() => {
            const { winner, reason } = overlayMatchState.result;
            const isGoldenPointResult = reason === "golden_point";
            const label = winner === "draw" ? "Empate" : winner === "red" ? redName : blueName;
            const lastRound = overlayState.roundFlags[overlayState.roundFlags.length - 1];
            const votes = isGoldenPointResult
              ? overlayMatchState.goldenPoint?.votes ?? {}
              : overlayState.judgeVotes ?? {};
            const hasIndividualVotes = Object.keys(votes).length > 0;
            const judgeIds = Array.from({
              length: isGoldenPointResult
                ? state.rules?.judgesCount ?? config.judgesCount
                : config.judgesCount,
            }, (_, i) => `J${i + 1}`);
            return (
              <div className={cn(
                "flex flex-col items-center gap-6 py-10 px-8 text-center",
                winner === "red" ? "bg-red-950" : winner === "blue" ? "bg-blue-950" : "bg-secondary"
              )}>
                {/* Trofeo */}
                <div className="text-7xl leading-none">🏆</div>

                {/* Nombre ganador */}
                <div className={cn(
                  "text-5xl font-black uppercase tracking-widest leading-none",
                  winner === "red" ? "text-red-100" : winner === "blue" ? "text-blue-100" : "text-foreground"
                )}>
                  {label}
                </div>

                {/* Razón */}
                <p className="text-base text-white/50 -mt-2">
                  {reason === "points" && tableChiefRoundRobin
                    ? "Banderines de los jueces"
                    : WIN_REASON_LABELS[reason] ?? reason}
                </p>
                {isGoldenPointResult && !state.resultConfirmed && (
                  <p data-testid="gp-pending-result" className="rounded-md border border-yellow-400/40 bg-yellow-950/50 px-3 py-2 text-sm font-semibold text-yellow-100">
                    Resultado pendiente de confirmación oficial. El intento de Punto de Oro ya fue cerrado.
                  </p>
                )}

                {/* Banderas */}
                {isGoldenPointResult && (
                  <p data-testid="gp-result-votes" className="text-xl font-bold text-white">
                    🔴 {Object.values(votes).filter((vote) => vote === "red").length} — {Object.values(votes).filter((vote) => vote === "blue").length} 🔵
                  </p>
                )}
                {lastRound && reason === "points" && (
                  <div className={cn(
                    "flex items-center gap-5 rounded-2xl px-8 py-4 text-3xl font-black",
                    winner === "red" ? "bg-red-900/60" : winner === "blue" ? "bg-blue-900/60" : "bg-white/10"
                  )}>
                    <span className={lastRound.red > lastRound.blue ? "text-red-200" : "text-white/30"}>
                      🔴 {lastRound.red}
                    </span>
                    <span className="text-white/20 text-lg font-normal">—</span>
                    <span className={lastRound.blue > lastRound.red ? "text-blue-200" : "text-white/30"}>
                      {lastRound.blue} 🔵
                    </span>
                  </div>
                )}

                {/* Votos individuales — solo si están registrados */}
                {hasIndividualVotes && (
                  <div className="flex justify-center gap-2 flex-wrap">
                    {judgeIds.map((jid) => {
                      const vote = votes[jid];
                      return (
                        <div key={jid} className={cn(
                          "rounded-xl px-3 py-2 border text-sm font-bold min-w-[56px] flex flex-col items-center",
                          vote === "red" ? "bg-red-800/60 border-red-500 text-red-200" :
                          vote === "blue" ? "bg-blue-800/60 border-blue-500 text-blue-200" :
                          "bg-white/10 border-white/20 text-white/50"
                        )}>
                          <p className="text-[10px] text-white/40 mb-0.5">{jid}</p>
                          {vote === "red" || vote === "blue" ? (
                            <FlagIcon side={vote} size={28} />
                          ) : (
                            <p>{vote === "draw" ? "🤝" : "—"}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Acciones */}
                <div className="flex flex-col gap-2 w-full pt-2">
                  {flagCorrectionError && <p role="alert" className="text-sm text-yellow-200">{flagCorrectionError}</p>}
                  <Button
                    size="lg"
                    className={cn(
                      "w-full text-base font-bold",
                      winner === "red" ? "bg-red-600 hover:bg-red-500 text-white" :
                      winner === "blue" ? "bg-blue-600 hover:bg-blue-500 text-white" :
                      "bg-primary hover:bg-primary/90"
                    )}
                    disabled={flagCorrectionPending || state.matchState?.phase !== "finished"}
                    onClick={() => { setWinnerOverlayOpen(false); handleOpenResultDialog(); }}
                  >
                    {isGoldenPointResult ? "Revisar y confirmar resultado →" : "Confirmar resultado →"}
                  </Button>
                  {!isGoldenPointResult && <Button
                    variant="ghost"
                    size="lg"
                    className="w-full text-white/60 hover:text-white hover:bg-white/10"
                    disabled={flagCorrectionPending || !canOperateFight || !connected || !stateReady || !!state.resultConfirmed || state.matchState?.phase !== "finished"}
                    onClick={() => void handleCorrectFlags()}
                  >
                    {flagCorrectionPending ? "Reabriendo votación..." : "↩ Corregir banderines"}
                  </Button>}
                  {flagCorrectionError && !flagCorrectionPending && state.matchState?.phase === "rest" && <Button
                    variant="outline"
                    onClick={() => { setWinnerOverlayOpen(false); setFlagCorrectionView(null); setFlagCorrectionError(null); }}
                  >Cerrar y revisar votación</Button>}
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── GUEST FIGHT DIALOG ─────────────────────────────────── */}
      <Dialog open={guestDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setGuestDialogOpen(false);
          setGuestForm({ red: "", blue: "", category: "", ring: "" });
        }
      }}>
      {(() => {
        // Categorías huésped ya existentes, deduplicadas por groupId
        const existingGuest = Array.from(
          fights
            .filter((f) => f.groupId?.startsWith("EXT:"))
            .reduce((map, f) => {
              if (!map.has(f.groupId!)) {
                const displayName = f.groupId!.slice(4).replace(/-/g, " ")
                  .replace(/\b\w/g, (c) => c.toUpperCase());
                map.set(f.groupId!, { groupId: f.groupId!, displayName, ring: f.importedFrom ?? "" });
              }
              return map;
            }, new Map<string, { groupId: string; displayName: string; ring: string }>())
            .values()
        );

        const isNewMode = guestForm.category !== "" || guestForm.ring !== "" ||
          !existingGuest.some((g) => g.displayName === guestForm.category && g.ring === guestForm.ring);
        const selectedChip = existingGuest.find(
          (g) => g.displayName === guestForm.category && g.ring === guestForm.ring
        ) ?? null;
        const canSubmit = guestForm.red.trim() && guestForm.blue.trim() &&
          guestForm.category.trim() && guestForm.ring.trim();

        return (
          <DialogContent data-testid="guest-fight-dialog"
            className="max-h-[85dvh] w-[calc(100vw-2rem)] max-w-sm overflow-y-auto p-5 [&>button:last-child]:flex [&>button:last-child]:size-11 [&>button:last-child]:items-center [&>button:last-child]:justify-center md:[&>button:last-child]:size-6"
            onOpenAutoFocus={(event) => { event.preventDefault(); guestRedNameRef.current?.focus(); }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (guestOpenedFromMobileActionsRef.current) mobileActionsButtonRef.current?.focus();
              else desktopGuestButtonRef.current?.focus();
              guestOpenedFromMobileActionsRef.current = false;
            }}>
            <DialogHeader className="pr-10 text-left md:pr-0">
              <DialogTitle className="text-sm font-bold uppercase tracking-widest text-purple-300">🏁 Pelea huésped</DialogTitle>
              <DialogDescription>Se agrega al final de la cola. No afecta tu clasificación.</DialogDescription>
            </DialogHeader>

              {/* Chips de categorías existentes */}
              {existingGuest.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Categoría reciente:</p>
                  <div className="flex flex-wrap gap-2">
                    {existingGuest.map((g) => (
                      <button
                        key={g.groupId}
                        type="button"
                        onClick={() => setGuestForm((f) => ({ ...f, category: g.displayName, ring: g.ring }))}
                        className={[
                          "min-h-11 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                          selectedChip?.groupId === g.groupId
                            ? "bg-purple-700 border-purple-500 text-white"
                            : "bg-purple-900/30 border-purple-700/50 text-purple-300 hover:bg-purple-800/40",
                        ].join(" ")}
                      >
                        🏁 {g.displayName} · {g.ring}
                      </button>
                    ))}
                    {selectedChip && (
                      <button
                        type="button"
                        onClick={() => setGuestForm((f) => ({ ...f, category: "", ring: "" }))}
                        className="min-h-11 rounded-full border border-dashed border-muted-foreground/40 px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-muted-foreground/70"
                      >
                        + nueva
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {/* Rojo / Azul — siempre visibles */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="guest-red-name" className="text-xs text-muted-foreground">Rojo</label>
                    <input
                      ref={guestRedNameRef}
                      id="guest-red-name"
                      className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      placeholder="Nombre rojo"
                      value={guestForm.red}
                      onChange={(e) => setGuestForm((f) => ({ ...f, red: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label htmlFor="guest-blue-name" className="text-xs text-muted-foreground">Azul</label>
                    <input
                      id="guest-blue-name"
                      className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      placeholder="Nombre azul"
                      value={guestForm.blue}
                      onChange={(e) => setGuestForm((f) => ({ ...f, blue: e.target.value }))}
                    />
                  </div>
                </div>

                {/* Categoría + ring: solo si no hay chip seleccionado */}
                {!selectedChip && (
                  <>
                    <div>
                      <label htmlFor="guest-category" className="text-xs text-muted-foreground">Categoría (de ese cuadrilátero)</label>
                      <input
                        id="guest-category"
                        className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        placeholder="ej: Infantil B Varones"
                        value={guestForm.category}
                        onChange={(e) => setGuestForm((f) => ({ ...f, category: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label htmlFor="guest-ring" className="text-xs text-muted-foreground">Cuadrilátero de origen</label>
                      <input
                        id="guest-ring"
                        className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        placeholder="ej: Cuadrilátero 2"
                        value={guestForm.ring}
                        onChange={(e) => setGuestForm((f) => ({ ...f, ring: e.target.value }))}
                      />
                    </div>
                  </>
                )}

                {/* Resumen cuando hay chip seleccionado */}
                {selectedChip && (
                  <div className="rounded-lg bg-purple-900/20 border border-purple-700/30 px-3 py-2 text-xs text-purple-300 space-y-0.5">
                    <p><span className="text-muted-foreground">Categoría:</span> {selectedChip.displayName}</p>
                    <p><span className="text-muted-foreground">Origen:</span> {selectedChip.ring}</p>
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  className="min-h-11 flex-1"
                  onClick={() => { setGuestDialogOpen(false); setGuestForm({ red: "", blue: "", category: "", ring: "" }); }}
                >
                  Cancelar
                </Button>
                <Button
                  className="min-h-11 flex-1 bg-purple-700 hover:bg-purple-600"
                  disabled={!canSubmit}
                  onClick={() => {
                    const latest = useTournamentStore.getState();
                    if (latest.config.id !== config.id || getFightPageEntry(navigationIntent, latest.config.id, latest.fights).mode === "invalid") return;
                    addGuestFight(guestForm.red, guestForm.blue, guestForm.category, guestForm.ring);
                    // Mantener la categoría seleccionada para el próximo, solo limpiar nombres
                    setGuestForm((f) => ({ ...f, red: "", blue: "" }));
                    setGuestDialogOpen(false);
                    toast.success("Pelea huésped agregada al final de la cola");
                  }}
                >
                  Agregar pelea
                </Button>
              </div>
          </DialogContent>
        );
      })()}
      </Dialog>

      {/* ── FIGHT LIST DIALOG ──────────────────────────────────── */}
      <Dialog open={!!restPrompt && restPrompt.categoryId === config.id &&
        restPrompt.fightId === selectedFight?.id} onOpenChange={(open) => {
          if (!open) setRestPrompt(null);
        }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Descanso entre combates</DialogTitle>
            <DialogDescription>Verificá el descanso antes de cargar el siguiente combate.</DialogDescription>
          </DialogHeader>
          {restPrompt?.read.kind === "known" && restPrompt.read.last && (
            <p className="text-sm text-muted-foreground">
              Último combate confirmado: {competitorNameInFights(fights, restPrompt.read.last.redId)} vs
              {" "}{competitorNameInFights(fights, restPrompt.read.last.blueId)}.
            </p>
          )}
          {restPrompt?.advisory.kind === "suggest" && (() => {
            const alternativeId = restPrompt?.advisory.kind === "suggest"
              ? restPrompt.advisory.alternativeFightId : "";
            const suggested = fights.find((fight) => fight.id === alternativeId);
            return <p className="text-sm">La pelea prevista repite competidor. Se sugiere cargar primero
              {suggested ? ` ${suggested.red.name} vs ${suggested.blue.name}` : " otra pelea"} para dar descanso.
              La lista guardada no cambiará de orden.</p>;
          })()}
          {restPrompt?.advisory.kind === "unavoidable" && (
            <p className="text-sm">La pelea prevista repite competidor y no hay otra pelea pendiente y
              elegible sin repetirlo. El descanso es inevitable.</p>
          )}
          {restPrompt?.read.kind === "ambiguous" && (
            <p className="text-sm">Los últimos resultados confirmados tienen el mismo horario. No es
              posible determinar con certeza quién peleó último.</p>
          )}
          {restPrompt?.read.kind === "unavailable" && (
            <p className="text-sm">No se pudo verificar el último combate confirmado. No se asumirá que
              la pelea prevista cumple el descanso.</p>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={() => setRestPrompt(null)}>Cancelar</Button>
            {restPrompt?.advisory.kind === "suggest" && (
              <Button type="button" variant="outline" onClick={() => {
                const latest = useTournamentStore.getState();
                const alternativeId = restPrompt.advisory.kind === "suggest"
                  ? restPrompt.advisory.alternativeFightId : "";
                const index = latest.fights.findIndex((fight) => fight.id === alternativeId && !fight.completed);
                if (latest.config.id !== restPrompt.categoryId ||
                  latest.fights[latest.currentFightIndex]?.id !== restPrompt.fightId || index < 0) {
                  setRestPrompt(null);
                  toast.warning("La selección cambió; revisá la lista antes de cargar.");
                  return;
                }
                selectFight(index);
              }}>Usar sugerida</Button>
            )}
            <Button type="button" onClick={() => {
              if (!restPrompt || useTournamentStore.getState().config.id !== restPrompt.categoryId ||
                useTournamentStore.getState().fights[useTournamentStore.getState().currentFightIndex]?.id !==
                  restPrompt.fightId) {
                setRestPrompt(null);
                return;
              }
              restOverrideRef.current = { categoryId: restPrompt.categoryId,
                fightId: restPrompt.fightId, readKey: restReadKey(restPrompt.read) };
              setRestPrompt(null);
            }}>
              {restPrompt?.advisory.kind === "suggest" ? "Mantener prevista" :
                restPrompt?.advisory.kind === "unavoidable" ? "Cargar igual" :
                "Continuar sin verificación"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showFightList} onOpenChange={setShowFightList}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Combates · {config.categoryName || "Categoría"}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-0.5 pr-1">
            {(() => {
              const regular = fights.filter((f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight);
              const finals = fights.filter((f) => f.isFinalFight);
              const tiebreaks = fights.filter((f) => f.isTiebreakExtra || f.isGoldenPointFight);
              const isGrouped = regular.some((fight) => fight.groupId);

              const mkRow = (f: FightEntry) => {
                const i = fights.indexOf(f);
                return (
                  <FightListRow
                    key={f.id} fight={f} index={i} active={i === currentFightIndex}
                    onSelect={(idx) => { selectFight(idx); setShowFightList(false); }}
                  />
                );
              };

              let previousGroupId: string | undefined;
              const regularSection = regular.map((fight) => {
                const showLabel = isGrouped && fight.groupId !== previousGroupId;
                previousGroupId = fight.groupId;
                return (
                  <React.Fragment key={fight.id}>
                    {showLabel && (
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-1 pt-2 pb-1">
                        Llave {fight.groupId ?? "—"}
                      </p>
                    )}
                    {mkRow(fight)}
                  </React.Fragment>
                );
              });

              return [
                ...regularSection,
                finals.length > 0 && (
                  <div key="__finals__">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-yellow-400/80 px-1 pt-2 pb-1">🏆 Final</p>
                    {finals.map(mkRow)}
                  </div>
                ),
                tiebreaks.length > 0 && (
                  <div key="__tiebreaks__">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-400/70 px-1 pt-2 pb-1">⚡ Desempate</p>
                    {tiebreaks.map(mkRow)}
                  </div>
                ),
              ];
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── TOP BAR ─────────────────────────────────────────────── */}
      <div id="tour-fight-header" className="shrink-0 border-b border-border">

        {/* En móvil la navegación y las acciones secundarias no compiten con los nombres del marcador. */}
        <div data-testid="mobile-fight-toolbar" className="flex min-w-0 flex-wrap items-center justify-between gap-1 px-2 py-1.5 md:hidden">
          <div className="flex min-w-40 flex-1 items-center justify-center gap-0.5">
            <Button size="icon" variant="ghost" className="size-11 shrink-0" aria-label="Combate anterior"
              disabled={currentFightIndex === 0} onClick={() => selectFight(currentFightIndex - 1)}>
              <ChevronLeft className="size-5" />
            </Button>
            <span className="min-w-0 text-center text-xs font-bold leading-tight tabular-nums">
              Combate {currentFightIndex + 1} de {fights.length}
            </span>
            <Button size="icon" variant="ghost" className="size-11 shrink-0" aria-label="Combate siguiente"
              disabled={currentFightIndex === fights.length - 1} onClick={() => selectFight(currentFightIndex + 1)}>
              <ChevronRight className="size-5" />
            </Button>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Button size="icon" variant="ghost" className="size-11" aria-label="Ver lista de combates"
              onClick={() => setShowFightList(true)}>
              <List className="size-5" />
            </Button>
            <Button ref={mobileActionsButtonRef} size="sm" variant="outline" className="min-h-11 px-2.5" aria-haspopup="dialog"
              aria-expanded={mobileActionsOpen} onClick={() => setMobileActionsOpen(true)}>
              Más
            </Button>
          </div>
        </div>
        {(currentFight?.completed || !connected) && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-1.5 md:hidden">
            {currentFight?.completed && <Badge variant="secondary" className="text-xs">Completado</Badge>}
            {!connected && <Badge variant="outline" className="text-xs text-red-400 border-red-800"><WifiOff className="size-3 mr-1" />Sin servidor</Badge>}
          </div>
        )}

        {/* Fila 1: navegación + nombres + acciones */}
        <div className="hidden items-center gap-2 px-3 py-2 md:flex">

          {/* Izquierda: flechas + contador */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="icon" variant="ghost" className="size-8"
              disabled={currentFightIndex === 0}
              onClick={() => selectFight(currentFightIndex - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground/60 w-10 text-center shrink-0">
              {currentFightIndex + 1}/{fights.length}
            </span>
            <Button
              size="icon" variant="ghost" className="size-8"
              disabled={currentFightIndex === fights.length - 1}
              onClick={() => selectFight(currentFightIndex + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          {/* Centro: nombres del combate */}
          <div className="flex-1 flex items-center justify-center gap-2 min-w-0">
            {currentFight ? (
              <>
                <span className="text-base font-black text-red-400 truncate max-w-48">{currentFight.red.name}</span>
                <span className="text-xs text-muted-foreground/50 shrink-0">vs</span>
                <span className="text-base font-black text-blue-400 truncate max-w-48">{currentFight.blue.name}</span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Sin combate seleccionado</span>
            )}
          </div>

          {/* Derecha: ☰ + botones de acción + status */}
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="icon" variant="ghost" className="size-8"
              title="Ver lista de combates"
              onClick={() => setShowFightList(true)}
            >
              <List className="size-4" />
            </Button>

            {/* Pelea huésped */}
            <Button
              ref={desktopGuestButtonRef}
              size="sm"
              variant="outline"
              disabled={entryInvalid}
              className="shrink-0 text-purple-300 border-purple-700/60 hover:bg-purple-900/20"
              title="Agregar pelea de otro cuadrilátero"
              onClick={() => { guestOpenedFromMobileActionsRef.current = false; setGuestDialogOpen(true); }}
            >
              🏁 Huésped
            </Button>

            {/* Postergar pelea — mueve la actual una posición hacia adelante */}
            {currentFight && !currentFight.completed && (() => {
              const canPostpone = fights.some((f, i) => i > currentFightIndex && !f.completed);
              const isActive = loaded && phase !== "idle" &&
                (phase !== "finished" || matchState?.result?.reason === "golden_point");
              let postponeTitle = "Postergar: llama a la siguiente pelea primero";
              if (isActive) postponeTitle = "No se puede postergar con el combate en curso";
              if (!canPostpone) postponeTitle = "No hay peleas pendientes a continuación";
              return (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 text-yellow-400 border-yellow-700/60 hover:bg-yellow-900/20"
                  disabled={!canPostpone || isActive || postponePending || state.matchPaused || !!state.match?.preFight?.started
                    || (!canOperateFight && !(canLoadFight && postponeRequestRef.current?.matchId === currentFight.id))
                    || (!state.match?.preFight?.loadId && postponeRequestRef.current?.matchId !== currentFight.id)}
                  title={state.match?.preFight?.started || state.matchPaused ? "Solo se puede postergar un combate sin iniciar ni actividad registrada" : postponeTitle}
                  onClick={() => { void handlePostpone(); }}
                >
                  <SkipForward className="size-3.5" />
                  Postergar
                </Button>
              );
            })()}

            {/* Reiniciar (solo cuando ya está cargado) */}
            {loaded && phase !== "golden_point" && matchState?.result?.reason !== "golden_point" && (
              <Button size="sm" variant="outline" className="shrink-0" disabled={!canOperateFight}
                onClick={() => { emit("match:reset"); setLoaded(false); }}>
                <RotateCcw className="size-3.5" />
                Reiniciar
              </Button>
            )}

            {currentFight?.completed && (
              <Badge variant="secondary" className="shrink-0 text-xs">Completado</Badge>
            )}
            {!connected && (
              <Badge variant="outline" className="shrink-0 text-xs text-red-400 border-red-800">
                <WifiOff className="size-3 mr-1" />Sin servidor
              </Badge>
            )}

            <ServerStatus connected={connected} judgesCount={judges.length} />
          </div>
        </div>

        {/* Fila 2: barra de progreso de combates */}
        <FightProgressStrip fights={fights} currentIndex={currentFightIndex} onSelect={selectFight} />
      </div>

      <Dialog open={mobileActionsOpen} onOpenChange={setMobileActionsOpen}>
        <DialogContent data-testid="mobile-fight-actions" className="w-[calc(100vw-2rem)] max-w-sm [&>button:last-child]:flex [&>button:last-child]:size-11 [&>button:last-child]:items-center [&>button:last-child]:justify-center" onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!guestOpenedFromMobileActionsRef.current) mobileActionsButtonRef.current?.focus();
        }}>
          <DialogHeader className="pr-10">
            <DialogTitle>Más acciones del combate</DialogTitle>
            <DialogDescription>Acciones ocasionales. El marcador y los controles principales permanecen en la mesa.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" className="min-h-11 justify-start text-purple-300"
              disabled={entryInvalid} onClick={() => {
                guestOpenedFromMobileActionsRef.current = true;
                setMobileActionsOpen(false);
                setGuestDialogOpen(true);
              }}>
              🏁 Agregar pelea huésped
            </Button>
            {currentFight && !currentFight.completed && (() => {
              const canPostpone = fights.some((f, i) => i > currentFightIndex && !f.completed);
              const isActive = loaded && phase !== "idle" &&
                (phase !== "finished" || matchState?.result?.reason === "golden_point");
              let postponeTitle = "Postergar: llama a la siguiente pelea primero";
              if (isActive) postponeTitle = "No se puede postergar con el combate en curso";
              if (!canPostpone) postponeTitle = "No hay peleas pendientes a continuación";
              return (
                <Button type="button" variant="outline" className="min-h-11 justify-start text-yellow-400"
                  disabled={!canPostpone || isActive || postponePending || state.matchPaused || !!state.match?.preFight?.started
                    || (!canOperateFight && !(canLoadFight && postponeRequestRef.current?.matchId === currentFight.id))
                    || (!state.match?.preFight?.loadId && postponeRequestRef.current?.matchId !== currentFight.id)}
                  title={state.match?.preFight?.started || state.matchPaused ? "Solo se puede postergar un combate sin iniciar ni actividad registrada" : postponeTitle}
                  onClick={() => { setMobileActionsOpen(false); void handlePostpone(); }}>
                  <SkipForward className="size-4" /> Postergar pelea
                </Button>
              );
            })()}
            {loaded && phase !== "golden_point" && matchState?.result?.reason !== "golden_point" && (
              <Button type="button" variant="outline" className="min-h-11 justify-start"
                disabled={!canOperateFight} onClick={() => { setMobileActionsOpen(false); emit("match:reset"); setLoaded(false); }}>
                <RotateCcw className="size-4" /> Reiniciar combate
              </Button>
            )}
            <ServerStatus connected={connected} judgesCount={judges.length} />
          </div>
        </DialogContent>
      </Dialog>
      {postponeError && <p role="alert" className="px-3 py-2 text-sm text-red-400">{postponeError}</p>}

      {loaded && config.matchType === "sparring" && !currentFight?.isTiebreakExtra &&
        !currentFight?.isGoldenPointFight && timingKind !== "continuation" &&
        untouchedPreStart(state) && (
           <div className="shrink-0 flex flex-wrap items-center justify-center gap-2 border-b border-border px-3 py-1.5 md:py-2">
            <Button type="button" size="sm" variant="outline"
               className="min-h-11 w-full border-cyan-700 text-cyan-200 hover:bg-cyan-950/40 sm:w-auto"
              disabled={swapPending || !canLoadFight ||
                (swapUnresolved && swapRequestRef.current?.matchId !== currentFight?.id) ||
                (!canOperateFight && !swapUnresolved)}
              onClick={() => { void handleSwapCompetitors(); }}>
              Intercambiar competidores
            </Button>
             <span className="hidden text-xs text-muted-foreground md:inline">Rojo permanece a la izquierda · Azul a la derecha</span>
          </div>
        )}
      {swapError && <p role="alert" className="shrink-0 px-3 py-2 text-center text-sm text-red-300">{swapError}</p>}
      {swapUnresolved && !swapError &&
        <p role="status" className="shrink-0 px-3 py-2 text-center text-sm text-amber-300">
          Verificando intercambio. Iniciar combate permanece bloqueado.
        </p>}
      {selectedMatchesServer && !colorsAligned && !swapUnresolved &&
        <p role="status" className="shrink-0 px-3 py-2 text-center text-sm text-amber-300">
          Sincronizando colores con el tatami. El combate no puede iniciar todavía.
        </p>}

      {config.mode === "elimination" && selectedFight?.completed &&
        selectedFight.winner === "draw" &&
        !fights.some((fight) => fight.continuationParentFightId === selectedFight.id) && (
          <div className="mx-3 mt-3 rounded-lg border border-orange-700/60 bg-orange-950/20 p-3 flex items-center justify-between gap-3">
            <p className="text-sm text-orange-200">
              Empate confirmado. El desempate aún no figura en la lista local.
            </p>
            <Button type="button" variant="outline" disabled={!canLoadFight ||
              isConfirmingResult || continuationActionRef.current}
              onClick={handleStartTiebreaker}>
              Reanudar desempate
            </Button>
          </div>
        )}

      {reviewingOtherFight && fightLockNotice && (
        <div role="status" data-testid="fight-review-notice" className="shrink-0 flex items-center justify-between gap-3 border-b border-amber-700/40 bg-amber-950/20 px-4 py-2 text-xs">
          <span>Consulta local · {fightLockNotice.message}{!connected && " Sin conexión: se muestran los últimos datos recibidos."}</span>
          {fightLockNotice.localIndex !== null && <Button size="sm" variant="outline" onClick={returnToLockedFight}>
            {fightLockNotice.actionLabel}
          </Button>}
        </div>
      )}

      {/* ── BANNER ÚLTIMA PELEA DE LA LLAVE ──────────────────── */}
      {isLastInGroup && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-1.5 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-xs font-semibold tracking-wide">
          🏁 ÚLTIMA PELEA · Llave {currentFight?.groupId}
        </div>
      )}

      {/* Fase y reloj permanecen visibles mientras se recorren los votos en móvil. */}
      <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-border bg-background px-2 py-2 md:hidden">
        <Badge className={cn(
          "text-xs px-2 py-1",
          phase === "round" && "bg-green-600",
          phase === "rest" && "bg-yellow-600",
          phase === "overtime" && "bg-orange-600",
          phase === "golden_point" && "bg-purple-600",
          phase === "finished" && "bg-blue-700",
          phase === "penalties" && "bg-red-800",
          phase === "idle" && "bg-secondary",
        )}>
          {phase === "rest" && isLastRound
            ? "Votación"
            : `${PHASE_LABELS[phase]}${roundSuffix(phase, currentRound)}`}
        </Badge>
        {currentFight?.isTiebreakExtra && <Badge variant="outline" className="text-xs text-orange-400 border-orange-600">⚡ Desempate</Badge>}
        {currentFight?.isGoldenPointFight && <Badge variant="outline" className="text-xs text-yellow-300 border-yellow-500">⚡ Punto de Oro</Badge>}
        {showPauseBadge(matchPaused, phase) && <Badge variant="outline" className="text-xs text-yellow-400 border-yellow-600">PAUSA</Badge>}
        {!isTul && <div className={cn(
          "font-mono text-2xl font-black leading-none tabular-nums",
          phase === "golden_point" ? "text-lg text-yellow-300" : timeLeft <= 10 && isRunning && !matchPaused ? "text-red-400" : "",
        )}>{phase === "golden_point" ? "SIN RELOJ" : formatTime(timeLeft)}</div>}
      </div>

      {/* ── ARENA ────────────────────────────────────────────────── */}
      <div data-testid="fight-arena" className="shrink-0 overflow-visible md:min-h-0 md:flex-1 md:overflow-hidden">

        {/* DESKTOP (md+): 3 columnas lado a lado */}
        <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr] relative">

          {/* ROJO */}
          <div data-testid="red-station-desktop" className="flex flex-col items-center justify-center gap-5 px-4 py-3 lg:px-8 lg:py-6 bg-red-950/50 border-r border-red-900/40">
            <p className="text-xl lg:text-3xl font-black text-red-400 uppercase tracking-wide text-center leading-tight max-w-full truncate">
              {redName}
            </p>
            <div className="text-[clamp(4rem,11vh,10rem)] font-black leading-none rounded-2xl px-[clamp(1.5rem,3vw,3.5rem)] py-[clamp(1rem,2vh,2rem)] bg-red-950/30 text-red-400 ring-card-red tabular-nums">
              {displayScore.red}
            </div>
            {(penaltyCounts.warnings.red > 0 || penaltyCounts.fouls.red > 0) && phase !== "golden_point" && (
              <div className="flex items-center gap-1.5 text-sm font-bold">
                {penaltyCounts.warnings.red > 0 && (
                  <span className="text-yellow-400">⚠ {penaltyCounts.warnings.red} adv</span>
                )}
                {penaltyCounts.warnings.red > 0 && penaltyCounts.fouls.red > 0 && (
                  <span className="text-muted-foreground">+</span>
                )}
                {penaltyCounts.fouls.red > 0 && (
                  <span className="text-red-300">{penaltyCounts.fouls.red} directo</span>
                )}
                <span className="text-muted-foreground">=</span>
                <span className="text-orange-400 bg-orange-950/50 rounded px-2 py-0.5">
                  −{totalPenaltyPoints(penaltyCounts.warnings.red, penaltyCounts.fouls.red)} pts
                </span>
              </div>
            )}
            {loaded && !isTul && phase !== "golden_point" && (
              <ScoreSanctionControls side="red" fighterName={redName} layout="desktop" counts={penaltyCounts}
                enabled={canEditLiveSanctions || canReviewSanctions} busy={sanctionActionPending}
                onAdjust={handleScoreSanction} />
            )}
          </div>

          {/* CENTRO: timer + controles */}
          <div id="tour-timer" className="flex flex-col items-center justify-center gap-4 px-8 py-6 min-w-85">
            {currentFight?.completed ? (() => {
              const isDraw = currentFight.winner === "draw";
              const isRed = currentFight.winner === "red";
              const winnerName = isRed ? currentFight.red.name : !isDraw ? currentFight.blue.name : null;
              return (
                <div className="flex flex-col items-center gap-5 w-full text-center">
                  <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground">Resultado</p>
                  {isDraw ? (
                    <p className="text-[clamp(3rem,8vh,6.5rem)] font-black text-yellow-400 leading-none">⚖ Empate</p>
                  ) : (
                    <>
                      <p className={cn(
                        "text-[clamp(2.5rem,6vh,5rem)] font-black leading-tight break-words text-center w-full",
                        isRed ? "text-red-400" : "text-blue-400"
                      )}>
                        {isRed ? "🔴" : "🔵"} {winnerName}
                      </p>
                      <p className="text-sm text-muted-foreground -mt-3">ganó el combate</p>
                    </>
                  )}
                  {(currentFight.flagsRed != null && currentFight.flagsBlue != null) && (
                    <div className="flex items-center gap-3 text-2xl font-black">
                      <span className="text-red-400">{currentFight.flagsRed}</span>
                      <span className="text-muted-foreground text-base">—</span>
                      <span className="text-blue-400">{currentFight.flagsBlue}</span>
                      <span className="text-xs font-normal text-muted-foreground ml-1 self-end mb-1">banderas</span>
                    </div>
                  )}
                  <div className="w-full pt-3 border-t border-white/10">
                    {confirmRedo ? (
                      <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 space-y-3">
                        <div className="flex items-start gap-2 text-left">
                          <span className="text-destructive text-lg leading-none mt-0.5">⚠</span>
                          <div className="space-y-1">
                            <p className="text-sm font-bold text-destructive">Acción irreversible</p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              Borrar este resultado puede alterar la clasificación, desempates y la Fase Final. Solo hacelo si el resultado fue cargado por error.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="destructive" className="flex-1" disabled={!canRedoFight} onClick={handleRedoFight}>
                            Sí, resetear
                          </Button>
                          <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmRedo(false)}>
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground/60 hover:text-amber-400 hover:bg-amber-950/30 text-xs"
                        disabled={!canRedoFight}
                        title={otherFightLocked ? "Volvé al combate activo antes de rehacer otro resultado" : undefined}
                        onClick={() => setConfirmRedo(true)}
                      >
                        ⚠ Rehacer combate
                      </Button>
                    )}
                  </div>
                </div>
              );
            })() : (
              <>
                {/* Phase + pause badges */}
                <div className="flex items-center gap-2">
                  <Badge className={cn(
                    "text-sm px-4 py-1.5",
                    phase === "round" && "bg-green-600",
                    phase === "rest" && "bg-yellow-600",
                    phase === "overtime" && "bg-orange-600",
                    phase === "golden_point" && "bg-purple-600",
                    phase === "finished" && "bg-blue-700",
                    phase === "penalties" && "bg-red-800",
                    phase === "idle" && "bg-secondary"
                  )}>
                    {phase === "rest" && isLastRound
                      ? "Votación"
                      : `${PHASE_LABELS[phase]}${roundSuffix(phase, currentRound)}`}
                  </Badge>
                  {currentFight?.isTiebreakExtra && (
                    <Badge variant="outline" className="text-orange-400 border-orange-600">⚡ Desempate</Badge>
                  )}
                  {currentFight?.isGoldenPointFight && (
                    <Badge variant="outline" className="text-yellow-300 border-yellow-500">⚡ Punto de Oro</Badge>
                  )}
                  {showPauseBadge(matchPaused, phase) && (
                    <Badge variant="outline" className="text-yellow-400 border-yellow-600">PAUSA</Badge>
                  )}
                </div>
                <div className={cn(
                  "font-mono font-black leading-none",
                  phase === "golden_point" ? "text-3xl text-yellow-300" : timerClass(timeLeft, isRunning, matchPaused),
                  isTul && "hidden",
                )}>
                  {phase === "golden_point" ? "SIN RELOJ" : formatTime(timeLeft)}
                </div>
                {loaded ? (
                  <>
                  {canEditLoadedTiming && renderTimingSettings("bout-settings-loaded-desktop")}
                  <fieldset disabled={!canOperateFight || tulFinishPending} className="contents"><MatchControls
                    loaded={loaded}
                    isFinished={isFinished}
                    phase={phase}
                    matchPaused={matchPaused}
                    fight={currentFight}
                    isLast={currentFightIndex === fights.length - 1}
                    state={state}
                    isTul={isTul}
                    onEmit={emit}
                    startBlocked={timingStartBlocked}
                    onFinishAndNext={handleOpenResultDialog}
                  /></fieldset></>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    {canEditPreloadDuration && (
                      renderTimingSettings("bout-duration-desktop")
                    )}
                    <Button size="xl" className="bg-green-700 hover:bg-green-600" disabled={!canLoadFight}
                      title={otherFightLocked ? fightLockNotice?.message : undefined} onClick={handleLoad}>
                      <Play />
                      {isTul ? 'Iniciar competencia' : 'Cargar combate'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* AZUL */}
          <div data-testid="blue-station-desktop" className="flex flex-col items-center justify-center gap-5 px-4 py-3 lg:px-8 lg:py-6 bg-blue-950/50 border-l border-blue-900/40">
            <p className="text-xl lg:text-3xl font-black text-blue-400 uppercase tracking-wide text-center leading-tight max-w-full truncate">
              {blueName}
            </p>
            <div className="text-[clamp(4rem,11vh,10rem)] font-black leading-none rounded-2xl px-[clamp(1.5rem,3vw,3.5rem)] py-[clamp(1rem,2vh,2rem)] bg-blue-950/30 text-blue-400 ring-card-blue tabular-nums">
              {displayScore.blue}
            </div>
            {(penaltyCounts.warnings.blue > 0 || penaltyCounts.fouls.blue > 0) && phase !== "golden_point" && (
              <div className="flex items-center gap-1.5 text-sm font-bold">
                {penaltyCounts.warnings.blue > 0 && (
                  <span className="text-yellow-400">⚠ {penaltyCounts.warnings.blue} adv</span>
                )}
                {penaltyCounts.warnings.blue > 0 && penaltyCounts.fouls.blue > 0 && (
                  <span className="text-muted-foreground">+</span>
                )}
                {penaltyCounts.fouls.blue > 0 && (
                  <span className="text-blue-300">{penaltyCounts.fouls.blue} directo</span>
                )}
                <span className="text-muted-foreground">=</span>
                <span className="text-orange-400 bg-orange-950/50 rounded px-2 py-0.5">
                  −{totalPenaltyPoints(penaltyCounts.warnings.blue, penaltyCounts.fouls.blue)} pts
                </span>
              </div>
            )}
            {loaded && !isTul && phase !== "golden_point" && (
              <ScoreSanctionControls side="blue" fighterName={blueName} layout="desktop" counts={penaltyCounts}
                enabled={canEditLiveSanctions || canReviewSanctions} busy={sanctionActionPending}
                onAdjust={handleScoreSanction} />
            )}
          </div>
        </div>

        {/* MOBILE (<md): marcador y controles en el único scroll principal. */}
        <div className="flex flex-col md:hidden">

          {/* Scores 2 columnas */}
          <div className="grid shrink-0 grid-cols-2 border-b border-border">
            {/* ROJO */}
            <div data-testid="red-station-mobile" className={cn("flex min-w-0 flex-col items-center justify-center border-r border-red-900/40 bg-red-950/50 px-2",
              canReviewSanctions ? "gap-1 py-2" : "gap-1.5 py-3")}>
              <span className="text-[11px] font-bold uppercase tracking-widest text-red-300">Rojo</span>
              <p className="line-clamp-2 min-h-10 w-full text-center text-base font-black uppercase leading-tight text-red-200 [overflow-wrap:anywhere]">
                {redName}
              </p>
              <div className="max-w-full text-[clamp(3.25rem,16vw,5rem)] font-black leading-none text-red-400 tabular-nums">
                {displayScore.red}
              </div>
              {(penaltyCounts.warnings.red > 0 || penaltyCounts.fouls.red > 0) && (
                <div className="flex items-center gap-1 text-xs font-bold">
                  {penaltyCounts.warnings.red > 0 && (
                    <span className="text-yellow-400">⚠{penaltyCounts.warnings.red}</span>
                  )}
                  {penaltyCounts.warnings.red > 0 && penaltyCounts.fouls.red > 0 && (
                    <span className="text-muted-foreground">+</span>
                  )}
                  {penaltyCounts.fouls.red > 0 && (
                    <span className="text-red-300">{penaltyCounts.fouls.red}dir</span>
                  )}
                  <span className="text-muted-foreground">=</span>
                  <span className="text-orange-400">−{totalPenaltyPoints(penaltyCounts.warnings.red, penaltyCounts.fouls.red)}pts</span>
                </div>
              )}
              {loaded && !isTul && phase !== "golden_point" && (phase !== "idle" || !!state.match?.preFight?.started) && (
                <ScoreSanctionControls side="red" fighterName={redName} layout="mobile" counts={penaltyCounts}
                  enabled={canEditLiveSanctions || canReviewSanctions} busy={sanctionActionPending}
                  onAdjust={handleScoreSanction} />
              )}
            </div>
            {/* AZUL */}
            <div data-testid="blue-station-mobile" className={cn("flex min-w-0 flex-col items-center justify-center bg-blue-950/50 px-2",
              canReviewSanctions ? "gap-1 py-2" : "gap-1.5 py-3")}>
              <span className="text-[11px] font-bold uppercase tracking-widest text-blue-300">Azul</span>
              <p className="line-clamp-2 min-h-10 w-full text-center text-base font-black uppercase leading-tight text-blue-200 [overflow-wrap:anywhere]">
                {blueName}
              </p>
              <div className="max-w-full text-[clamp(3.25rem,16vw,5rem)] font-black leading-none text-blue-400 tabular-nums">
                {displayScore.blue}
              </div>
              {(penaltyCounts.warnings.blue > 0 || penaltyCounts.fouls.blue > 0) && phase !== "golden_point" && (
                <div className="flex items-center gap-1 text-xs font-bold">
                  {penaltyCounts.warnings.blue > 0 && (
                    <span className="text-yellow-400">⚠{penaltyCounts.warnings.blue}</span>
                  )}
                  {penaltyCounts.warnings.blue > 0 && penaltyCounts.fouls.blue > 0 && (
                    <span className="text-muted-foreground">+</span>
                  )}
                  {penaltyCounts.fouls.blue > 0 && (
                    <span className="text-blue-300">{penaltyCounts.fouls.blue}dir</span>
                  )}
                  <span className="text-muted-foreground">=</span>
                  <span className="text-orange-400">−{totalPenaltyPoints(penaltyCounts.warnings.blue, penaltyCounts.fouls.blue)}pts</span>
                </div>
              )}
              {loaded && !isTul && phase !== "golden_point" && (phase !== "idle" || !!state.match?.preFight?.started) && (
                <ScoreSanctionControls side="blue" fighterName={blueName} layout="mobile" counts={penaltyCounts}
                  enabled={canEditLiveSanctions || canReviewSanctions} busy={sanctionActionPending}
                  onAdjust={handleScoreSanction} />
              )}
            </div>
          </div>

          {/* Controles */}
          <div data-testid="mobile-fight-controls" className="flex w-full flex-col items-center gap-3 px-3 py-3">
            {loaded ? (
              <>
              <fieldset disabled={!canOperateFight || tulFinishPending} className="contents"><MatchControls
                loaded={loaded}
                isFinished={isFinished}
                phase={phase}
                matchPaused={matchPaused}
                fight={currentFight}
                isLast={currentFightIndex === fights.length - 1}
                state={state}
                isTul={isTul}
                onEmit={emit}
                startBlocked={timingStartBlocked}
                onFinishAndNext={handleOpenResultDialog}
              /></fieldset>
              {canEditLoadedTiming && renderMobileTimingSettings("bout-settings-loaded-mobile")}
              </>
            ) : currentFight?.completed ? (() => {
              const isDraw = currentFight.winner === "draw";
              const isRed = currentFight.winner === "red";
              const winnerName = isRed ? currentFight.red.name : !isDraw ? currentFight.blue.name : null;
              return (
                <div className="flex flex-col items-center gap-4 w-full text-center">
                  <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-muted-foreground">Resultado</p>
                  {isDraw ? (
                    <p className="text-5xl font-black text-yellow-400 leading-none">⚖ Empate</p>
                  ) : (
                    <>
                      <p className={cn("text-4xl font-black leading-tight break-words w-full", isRed ? "text-red-400" : "text-blue-400")}>
                        {isRed ? "🔴" : "🔵"} {winnerName}
                      </p>
                      <p className="text-sm text-muted-foreground -mt-2">ganó el combate</p>
                    </>
                  )}
                  {(currentFight.flagsRed != null && currentFight.flagsBlue != null) && (
                    <div className="flex items-center gap-3 text-xl font-black">
                      <span className="text-red-400">{currentFight.flagsRed}</span>
                      <span className="text-muted-foreground text-base">—</span>
                      <span className="text-blue-400">{currentFight.flagsBlue}</span>
                      <span className="text-xs font-normal text-muted-foreground ml-1 self-end mb-1">banderas</span>
                    </div>
                  )}
                  <div className="w-full pt-3 border-t border-white/10">
                    {confirmRedo ? (
                      <div className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 space-y-3 w-full">
                        <div className="flex items-start gap-2">
                          <span className="text-destructive text-lg leading-none mt-0.5">⚠</span>
                          <div className="space-y-1 text-left">
                            <p className="text-sm font-bold text-destructive">Acción irreversible</p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              Borrar este resultado puede alterar la clasificación, desempates y la Fase Final. Solo hacelo si el resultado fue cargado por error.
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="destructive" className="flex-1" disabled={!canRedoFight} onClick={handleRedoFight}>
                            Sí, resetear
                          </Button>
                          <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmRedo(false)}>
                            Cancelar
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button size="sm" variant="ghost" className="text-muted-foreground/60 hover:text-amber-400 hover:bg-amber-950/30 text-xs" disabled={!canRedoFight} title={otherFightLocked ? "Volvé al combate activo antes de rehacer otro resultado" : undefined} onClick={() => setConfirmRedo(true)}>
                        ⚠ Rehacer combate
                      </Button>
                    )}
                  </div>
                </div>
              );
            })() : (
              <div className="flex flex-col items-center gap-3">
              <Button size="xl" className="bg-green-700 hover:bg-green-600" disabled={!canLoadFight}
                title={otherFightLocked ? fightLockNotice?.message : undefined} onClick={handleLoad}>
                <Play />
                {isTul ? 'Iniciar competencia' : 'Cargar combate'}
              </Button>
              {canEditPreloadDuration && renderMobileTimingSettings("bout-duration-mobile")}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── PANEL INFERIOR (TABS) ─────────────────────────────────── */}
      {loaded && (
        <fieldset data-testid="fight-vote-panel" disabled={!canOperateFight || tulFinishPending} id="tour-bottom-tabs" className={cn(
          "shrink-0 border-t border-border bg-card/40 px-3 py-2 space-y-2 md:px-4 md:overflow-y-auto",
          canReviewSanctions ? "md:max-h-[32vh]" : "md:max-h-[42vh]",
        )}>
          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-border/40 pb-1">
            {!tableChiefRoundRobin && (!isTul || tulPhase === "voting") && (phase !== "golden_point" || state.rules?.judgingMode !== "points") && (
              <button
                type="button"
                onClick={() => setBottomTab("mesa")}
                className={cn(
                  "-mb-0.75 flex min-h-11 items-center gap-1.5 rounded-t border-b-2 px-3 py-1.5 text-xs font-medium transition-colors md:min-h-0",
                  selectedBottomTab === "mesa"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Keyboard className="size-3" />
                Mesa decide
              </button>
            )}
            {(!isTul || tulPhase === "voting") && (phase !== "golden_point" || state.rules?.judgingMode !== "points") && (
              <button
                type="button"
                onClick={() => setBottomTab("porjuez")}
                className={cn(
                  "-mb-0.75 flex min-h-11 items-center gap-1.5 rounded-t border-b-2 px-3 py-1.5 text-xs font-medium transition-colors md:min-h-0",
                  selectedBottomTab === "porjuez"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Users className="size-3" />
                Por juez
              </button>
            )}
            {!tableChiefRoundRobin && (phase !== "golden_point" || state.rules?.judgingMode === "points") && <button
              type="button"
              onClick={() => setBottomTab("remotos")}
              className={cn(
                "-mb-0.75 flex min-h-11 items-center gap-1.5 rounded-t border-b-2 px-3 py-1.5 text-xs font-medium transition-colors md:min-h-0",
                (selectedBottomTab === "remotos" || (isTul && tulPhase !== "voting"))
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Smartphone className="size-3" />
              Remotos
            </button>}
          </div>

          {/* Tab: Mesa decide */}
          {/* Tab: Mesa decide (sparring + tul voting) */}
          {selectedBottomTab === "mesa" && (!isTul || tulPhase === "voting") && (
            <JefeMesaPanel
              judgesCount={phase === "golden_point"
                ? state.rules?.judgesCount ?? config.judgesCount
                : config.judgesCount}
              judgeVotes={state.judgeVotes}
              roundFlags={state.roundFlags ?? []}
              phase={phase}
              pendingJuryDecision={matchState?.pendingJuryDecision ?? false}
              goldenPoint={matchState?.goldenPoint}
              onEmit={emit}
              onGoldenVote={handleGoldenVote}
              onConfirmGoldenOutcome={handleConfirmGoldenOutcome}
              goldenActionPending={goldenActionPending}
              mode="mesa"
              tulMode={isTul}
            />
          )}

          {/* Tab: Por juez (sparring + tul voting) */}
          {selectedBottomTab === "porjuez" && (!isTul || tulPhase === "voting") && (
            <JefeMesaPanel
              judgesCount={phase === "golden_point"
                ? state.rules?.judgesCount ?? config.judgesCount
                : config.judgesCount}
              judgeVotes={state.judgeVotes}
              roundFlags={state.roundFlags ?? []}
              phase={phase}
              pendingJuryDecision={matchState?.pendingJuryDecision ?? false}
              goldenPoint={matchState?.goldenPoint}
              onEmit={emit}
              onGoldenVote={handleGoldenVote}
              onConfirmGoldenOutcome={handleConfirmGoldenOutcome}
              goldenActionPending={goldenActionPending}
              mode="porjuez"
              tulMode={isTul}
            />
          )}

          {/* Tab: Remotos */}
          {(selectedBottomTab === "remotos" || (isTul && tulPhase !== "voting")) && (
            <>
            {phase === "golden_point" && matchState?.goldenPoint && <div className="rounded-lg border border-yellow-700/40 bg-yellow-950/20 px-3 py-2 text-center text-sm">
              <p className="font-bold text-yellow-300">⚡ Intento {matchState.goldenPoint.attempt} · Sin reloj · Mayoría {Math.floor((state.rules?.judgesCount ?? config.judgesCount) / 2) + 1}</p>
              <p>{Object.entries(matchState.goldenPoint.votes).map(([judgeId, vote]) => `${judgeId}: ${vote === "red" ? "🔴" : "🔵"}`).join(" · ") || "Esperando punto de los jueces"}</p>
            </div>}
            <JudgeCornerGrid
              judgesCount={config.judgesCount}
              connectedJudges={judges}
              judgeTotals={state.judgeTotals ?? {}}
              judgeVotes={state.judgeVotes ?? {}}
              serverUrl={state.serverUrl}
              ringToken={state.ringToken}
            />
            </>
          )}
        </fieldset>
      )}

      {/* ── DIALOG RESULTADO ─────────────────────────────────────── */}
      {matchState?.result != null && (
        <Dialog open={loaded && resultDialogOpen} onOpenChange={setResultDialogOpen}>
          <DialogContent className="max-w-md max-h-[90vh] p-0 overflow-y-auto">
            <DialogHeader className="sr-only">
              <DialogTitle>Registrar resultado del combate</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-0">
              {/* Banner ganador */}
              <div className={cn("py-6 px-6 text-center space-y-1", resultBannerClass(matchState?.result?.winner ?? "draw"))}>
                <div className="text-3xl font-black uppercase tracking-wider flex items-center justify-center gap-2">
                  <Trophy className="size-6" />
                  {winnerName(matchState?.result?.winner ?? "draw", state, currentFight)}
                </div>
                <p className="text-sm opacity-70">
                  {matchState?.result?.reason === "golden_point"
                    ? "Victoria por Punto de Oro"
                    : matchState?.result?.winner === "draw"
                    ? "1 punto para cada uno (Empate)"
                    : matchState?.result?.winner
                      ? "3 puntos (Victoria)"
                      : "Resultado manual"}
                </p>
              </div>

              <div className="p-5 space-y-5">
                {/* Banderines */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Banderines</p>
                  <div className="grid grid-cols-2 gap-3">
                    <FlagCounterField
                      isMesa={selectedBottomTab === "mesa" && matchState?.result?.reason !== "golden_point"}
                      value={resultFlagsRed}
                      onChange={(v) => {
                        setResultFlagsRed(v);
                        if (matchState?.result?.winner === "red" && resultFlagsBlue >= v) {
                          setResultFlagsBlue(Math.max(0, v - 1));
                        }
                      }}
                      color="red"
                      name={currentFight?.red.name ?? "Rojo"}
                      max={matchState?.result?.winner === "blue" ? Math.max(0, resultFlagsBlue - 1) : config.judgesCount}
                    />
                    <FlagCounterField
                      isMesa={selectedBottomTab === "mesa" && matchState?.result?.reason !== "golden_point"}
                      value={resultFlagsBlue}
                      onChange={(v) => {
                        setResultFlagsBlue(v);
                        if (matchState?.result?.winner === "blue" && resultFlagsRed >= v) {
                          setResultFlagsRed(Math.max(0, v - 1));
                        }
                      }}
                      color="blue"
                      name={currentFight?.blue.name ?? "Azul"}
                      max={matchState?.result?.winner === "red" ? Math.max(0, resultFlagsRed - 1) : config.judgesCount}
                    />
                  </div>
                </div>

                {/* Penalizaciones: se corrigen en el servidor antes del fallo oficial. */}
                {matchState.result.reason === "golden_point" ? (
                  <div className="text-xs text-muted-foreground">
                    Penalizaciones registradas: rojo {penaltyCounts.warnings.red} advertencias y {penaltyCounts.fouls.red} puntos directos;
                    azul {penaltyCounts.warnings.blue} advertencias y {penaltyCounts.fouls.blue} puntos directos.
                  </div>
                ) : matchState.result.reason === "dq" ? (
                  <p className="rounded-lg border border-red-800/50 bg-red-950/20 p-3 text-xs text-red-200">
                    Descalificación: las sanciones no se corrigen aquí porque podrían cambiar el fallo.
                  </p>
                ) : state.resultConfirmed ? (
                  <p className="rounded-lg border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                    Fallo confirmado: las sanciones ya no pueden modificarse.
                  </p>
                ) : (
                  <PostClockSanctionReview
                    redName={currentFight?.red.name ?? "Rojo"}
                    blueName={currentFight?.blue.name ?? "Azul"}
                    counts={penaltyCounts}
                    busy={sanctionActionPending}
                    editable={canReviewSanctions}
                    stage="result"
                    onAdjust={(side, kind, delta) => { void handleReviewSanction(side, kind, delta); }}
                  />
                )}

                {/* Por juez */}
                {(() => {
                  const goldenVotes = matchState?.result?.reason === "golden_point"
                    ? matchState.goldenPoint?.votes ?? {}
                    : null;
                  const jTotals = goldenVotes ? {} : state.judgeTotals ?? {};
                  const jVotes = goldenVotes ?? state.judgeVotes ?? {};
                  const hasMobileTotals = Object.values(jTotals).some((t) => t.red > 0 || t.blue > 0);
                  const hasVotes = Object.keys(jVotes).length > 0;
                  if (!hasMobileTotals && !hasVotes) return null;
                  const judgeIds = hasMobileTotals
                    ? Object.keys(jTotals).sort()
                    : Object.keys(jVotes).sort();
                  return (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Por juez</p>
                      <div className="flex flex-wrap gap-2">
                        {judgeIds.map((jid) => {
                          if (hasMobileTotals) {
                            const t = jTotals[jid] ?? { red: 0, blue: 0 };
                            const leader = t.red > t.blue ? "red" : t.blue > t.red ? "blue" : "draw";
                            return (
                              <div key={jid} className={cn(
                                "rounded-lg border px-3 py-2 text-center min-w-[68px]",
                                leader === "red" ? "border-red-800/50 bg-red-950/30" :
                                leader === "blue" ? "border-blue-800/50 bg-blue-950/30" :
                                "border-border bg-secondary/30"
                              )}>
                                <p className="text-[10px] text-muted-foreground mb-1">{jid}</p>
                                <p className="text-sm font-black">
                                  <span className={cn(leader === "red" ? "text-red-300" : "text-muted-foreground/50")}>{t.red}</span>
                                  <span className="text-muted-foreground/30 mx-1">-</span>
                                  <span className={cn(leader === "blue" ? "text-blue-300" : "text-muted-foreground/50")}>{t.blue}</span>
                                </p>
                              </div>
                            );
                          }
                          const vote = jVotes[jid];
                          return (
                            <div key={jid} className={cn(
                              "rounded-lg border px-3 py-2 text-center min-w-[56px]",
                              vote === "red" ? "border-red-800/50 bg-red-950/30" :
                              vote === "blue" ? "border-blue-800/50 bg-blue-950/30" :
                              "border-border bg-secondary/30"
                            )}>
                              <p className="text-[10px] text-muted-foreground mb-1">{jid}</p>
                              <p className="text-base">{vote === "red" ? "🔴" : vote === "blue" ? "🔵" : vote === "draw" ? "🤝" : "—"}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Confirmar / Desempate / Punto de Oro */}
                {(() => {
                  const isDraw = matchState?.result?.winner === "draw";
                  const isGPFight = currentFight?.isGoldenPointFight;
                  // Elim/final/tiebreak/GP fights require a winner — draw must lead to another tiebreak or GP
                  const isElim = config.mode === "elimination" || isGPFight ||
                    ((currentFight?.isFinalFight || currentFight?.isTiebreakExtra) && !isMiniPlayoff);
                  const nextIsGoldenPoint = currentFight && (config.mode === "elimination"
                    ? Boolean(currentFight.isTiebreakExtra || isGPFight)
                    : nextDirectFightIsGoldenPoint(currentFight, fights));

                  if (isDraw && isElim) {
                    return (
                      <>
                        {nextIsGoldenPoint ? (
                          <div className="rounded-xl border border-yellow-700/50 bg-yellow-950/20 p-4">
                            <p className="text-sm font-bold text-yellow-300 flex items-center gap-2">
                              <Zap className="size-4" />
                              Punto de Oro
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              Sin reloj — gana el primer punto con mayoría de jueces.
                            </p>
                          </div>
                        ) : (
                          <div className="rounded-xl border border-orange-800/50 bg-orange-950/20 p-4 space-y-3">
                            <p className="text-sm font-bold text-orange-300 flex items-center gap-2">
                              <Zap className="size-4" />
                              Desempate requerido
                            </p>
                            <div className="flex items-center gap-3">
                              <label className="text-xs text-muted-foreground whitespace-nowrap">Duración (seg)</label>
                              <input
                                type="number"
                                min={10}
                                max={600}
                                step={5}
                                value={tiebreakerDuration}
                                onChange={(e) => setTiebreakerDuration(Math.max(10, Math.min(600, Number(e.target.value))))}
                                className="w-full rounded-md bg-background border border-input px-3 py-1.5 text-sm text-center font-bold tabular-nums"
                              />
                            </div>
                          </div>
                        )}
                        <Button
                          disabled={!(selectedFight?.completed ? canLoadFight : canOperateFight) ||
                            isConfirmingResult || sanctionActionPending}
                          className={nextIsGoldenPoint
                            ? "w-full bg-yellow-600 hover:bg-yellow-500 text-white"
                            : "w-full bg-orange-700 hover:bg-orange-600 text-white"}
                          size="lg"
                          onClick={handleStartTiebreaker}
                        >
                          <Zap className="size-4" />
                          {isConfirmingResult ? "Guardando resultado..." : selectedFight?.completed
                            ? "Reanudar desempate" : nextIsGoldenPoint ? "Iniciar Punto de Oro" : "Iniciar desempate"}
                        </Button>
                      </>
                    );
                  }
                  return (
                    <Button disabled={!canOperateFight || isConfirmingResult || sanctionActionPending} className="w-full" size="lg" onClick={handleConfirmResult}>
                      <ChevronRight className="size-4" />
                      {isConfirmingResult ? "Guardando resultado..." : "Confirmar y continuar"}
                    </Button>
                  );
                })()}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
