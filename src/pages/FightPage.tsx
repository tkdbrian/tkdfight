import * as React from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useSocket } from "@/hooks/useSocket";
import { useTournamentStore } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
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
} from "lucide-react";
import {
  PHASE_LABELS,
  WIN_REASON_LABELS,
  formatTime,
} from "@/lib/fight-utils";
import { cn } from "@/lib/utils";
import itfRules from "@/rules/rules/rules_sparring_itf_baseline.json";
import type { RuleSetSparring } from "@/engine/types";
import type { ServerState } from "@/lib/socket-types";
import type { FightEntry } from "@/store/tournament";

const DEFAULT_RULES = itfRules as RuleSetSparring;

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
  const base = "flex-1 py-4 rounded-xl font-bold text-base transition-colors";
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
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={flagBtnClass(side, active)}
    >
      {label}
    </button>
  );
}

function FlagVoteRow({
  judgeId, vote, disabled, onVote,
}: Readonly<{
  judgeId: string;
  vote: string | undefined;
  disabled: boolean;
  onVote: (jid: string, v: FlagSide) => void;
}>) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-secondary/20 px-2 py-2">
      <span className="text-xs font-bold text-muted-foreground text-center">{judgeId}</span>
      <div className="flex gap-1">
        <FlagButton side="red" active={vote === "red"} disabled={disabled} onClick={() => onVote(judgeId, "red")} />
        <FlagButton side="draw" active={vote === "draw"} disabled={disabled} onClick={() => onVote(judgeId, "draw")} />
        <FlagButton side="blue" active={vote === "blue"} disabled={disabled} onClick={() => onVote(judgeId, "blue")} />
      </div>
    </div>
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

function JefeMesaPanel({
  judgesCount, judgeVotes, roundFlags, phase, pendingJuryDecision, penaltyCounts, redName, blueName, onEmit, hidePenalties = false,
}: Readonly<{
  judgesCount: number;
  judgeVotes: Record<string, string>;
  roundFlags: Array<{ red: number; blue: number; winner: string }>;
  phase: string;
  pendingJuryDecision: boolean;
  penaltyCounts: { warnings: { red: number; blue: number }; fouls: { red: number; blue: number } };
  redName: string;
  blueName: string;
  onEmit: (event: string, data?: unknown) => void;
  hidePenalties?: boolean;
}>) {
  const [simple, setSimple] = React.useState(false); // false = Por juez (default)
  const ids = Array.from({ length: judgesCount }, (_, i) => `J${i + 1}`);
  const roundActive = phase === "round" || phase === "golden_point";
  const canVote = (phase !== "idle" && phase !== "finished") || (phase === "finished" && pendingJuryDecision);
  const canConfirm = canVote && !roundActive;
  const flags = countFlags(judgesCount, judgeVotes);
  const roundWinner = flagRoundWinner(flags);
  const allVoted = ids.every((jid) => judgeVotes[jid] === "red" || judgeVotes[jid] === "blue" || judgeVotes[jid] === "draw");
  const roundNum = roundFlags.length + 1;

  // Modo simple: vota todos los jueces con el mismo resultado y confirma
  function voteSingle(side: FlagSide) {
    ids.forEach((jid) => { onEmit("mesa:flagVote", { judgeId: jid, vote: side }); });
    // pequeño delay para que el estado se actualice antes de confirmar
    setTimeout(() => onEmit("mesa:confirmRound"), 80);
  }

  return (
    <div className="space-y-3">
      {/* Historial de rounds */}
      {roundFlags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {roundFlags.map((r, i) => (
            <RoundHistoryBadge key={`r${i + 1}-${r.red}-${r.blue}`} round={r} idx={i} />
          ))}
        </div>
      )}

      {/* Toggle Simple / Por juez */}
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => setSimple(true)}
          className={cn(
            "text-xs px-2.5 py-0.5 rounded border transition-colors",
            simple ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
          )}
        >
          Manual
        </button>
        <button
          type="button"
          onClick={() => setSimple(false)}
          className={cn(
            "text-xs px-2.5 py-0.5 rounded border transition-colors",
            !simple ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
          )}
        >
          Por juez
        </button>
      </div>

      {simple ? (
        /* ── MODO MANUAL: 3 botones grandes, 1 clic confirma ── */
        canVote ? (
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => voteSingle("red")}
              className={cn(
                "flex-1 rounded-xl py-5 text-xl font-black uppercase tracking-wider transition-all border-2",
                canConfirm
                  ? "bg-red-700 hover:bg-red-600 border-red-600 text-white"
                  : "bg-red-950/20 border-red-900/30 text-red-400/40 cursor-not-allowed",
              )}
            >
              🔴 Rojo
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => voteSingle("draw")}
              className={cn(
                "flex-1 rounded-xl py-5 text-xl font-black uppercase tracking-wider transition-all border-2",
                canConfirm
                  ? "bg-secondary hover:bg-secondary/80 border-border text-foreground"
                  : "bg-secondary/20 border-border/30 text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              🤝 Empate
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() => voteSingle("blue")}
              className={cn(
                "flex-1 rounded-xl py-5 text-xl font-black uppercase tracking-wider transition-all border-2",
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
        /* ── MODO POR JUEZ: filas individuales ── */
        <>
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
          <div className="grid grid-cols-2 gap-2">
            {ids.map((jid) => (
              <FlagVoteRow
                key={jid}
                judgeId={jid}
                vote={judgeVotes[jid]}
                disabled={!canVote}
                onVote={(jid, v) => onEmit("mesa:flagVote", { judgeId: jid, vote: v })}
              />
            ))}
          </div>
          {canVote ? (
            <Button
              size="lg"
              disabled={!allVoted || !canConfirm}
              onClick={() => onEmit("mesa:confirmRound")}
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
          <FlagPanelFooter canVote={canVote} roundActive={roundActive} roundNum={roundNum} onEmit={onEmit} />
        </>
      )}

      {/* ── Penalizaciones ── */}
      {!hidePenalties && (
        <>
      <Separator />
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 pt-1">Penalizaciones</p>
      <div className="grid grid-cols-2 gap-3">
        {/* ROJO */}
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-red-400 truncate">{redName}</p>
          <div className="flex items-center justify-between">
            <span className="text-sm font-black text-yellow-400">⚠ {penaltyCounts.warnings.red}</span>
            {warnDeductions(penaltyCounts.warnings.red) > 0 && (
              <span className="text-xs font-bold text-orange-400">−{warnDeductions(penaltyCounts.warnings.red)} pts</span>
            )}
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={phase === "idle" || phase === "finished"}
              className="flex-1 text-yellow-400 border-yellow-700/60 hover:bg-yellow-900/30 text-xs h-7"
              onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "red", type: "warning_minor" })}>
              + Adv
            </Button>
            <Button size="sm" variant="outline" disabled={phase === "idle" || phase === "finished" || penaltyCounts.warnings.red === 0}
              className="flex-1 text-yellow-600 border-yellow-800/50 hover:bg-yellow-900/20 text-xs h-7"
              onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "red", type: "remove_warning" })}>
              − Adv
            </Button>
          </div>
          <Button size="sm" variant="outline" disabled={phase === "idle" || phase === "finished"}
            className="w-full h-8 text-xs font-bold text-red-300 border-red-600 bg-red-950/40 hover:bg-red-900/50"
            onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "red", type: "minus_point" })}>
            − Punto directo
          </Button>
          <div className="flex items-center justify-between">
            <span className="text-xs text-red-400">Descontados: {penaltyCounts.fouls.red}</span>
            <Button size="sm" variant="ghost" disabled={phase === "idle" || phase === "finished" || penaltyCounts.fouls.red === 0}
              className="text-muted-foreground text-xs h-6 px-1.5"
              onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "red", type: "remove_minus_point" })}>
              ↩
            </Button>
          </div>
        </div>
        {/* AZUL */}
        <div className="space-y-1.5">
          <p className="text-xs font-bold text-blue-400 truncate">{blueName}</p>
          <div className="flex items-center justify-between">
            <span className="text-sm font-black text-yellow-400">⚠ {penaltyCounts.warnings.blue}</span>
            {warnDeductions(penaltyCounts.warnings.blue) > 0 && (
              <span className="text-xs font-bold text-orange-400">−{warnDeductions(penaltyCounts.warnings.blue)} pts</span>
            )}
          </div>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={phase === "idle" || phase === "finished"}
              className="flex-1 text-yellow-400 border-yellow-700/60 hover:bg-yellow-900/30 text-xs h-7"
              onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "blue", type: "warning_minor" })}>
              + Adv
            </Button>
            <Button size="sm" variant="outline" disabled={phase === "idle" || phase === "finished" || penaltyCounts.warnings.blue === 0}
              className="flex-1 text-yellow-600 border-yellow-800/50 hover:bg-yellow-900/20 text-xs h-7"
              onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "blue", type: "remove_warning" })}>
              − Adv
            </Button>
          </div>
          <Button size="sm" variant="outline" disabled={phase === "idle" || phase === "finished"}
            className="w-full h-8 text-xs font-bold text-blue-300 border-blue-600 bg-blue-950/40 hover:bg-blue-900/50"
            onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "blue", type: "minus_point" })}>
            − Punto directo
          </Button>
          <div className="flex items-center justify-between">
            <span className="text-xs text-blue-400">Descontados: {penaltyCounts.fouls.blue}</span>
            <Button size="sm" variant="ghost" disabled={phase === "idle" || phase === "finished" || penaltyCounts.fouls.blue === 0}
              className="text-muted-foreground text-xs h-6 px-1.5"
              onClick={() => onEmit("match:event", { judgeId: "arbiter", competitor: "blue", type: "remove_minus_point" })}>
              ↩
            </Button>
          </div>
        </div>
      </div>
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

function PenaltiesTabContent({ phase, redName, blueName, penaltyCounts, onEmit }: Readonly<{
  phase: string;
  redName: string;
  blueName: string;
  penaltyCounts: { warnings: { red: number; blue: number }; fouls: { red: number; blue: number } };
  onEmit: (event: string, data?: unknown) => void;
}>) {
  const canAdd = phase !== "idle" && phase !== "finished";

  function addEvent(competitor: "red" | "blue", type: string) {
    onEmit("match:event", { judgeId: "arbiter", competitor, type });
  }

  return (
    <div className="space-y-3">
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
        fight.importedFrom && !fight.completed && "border-l-2 border-yellow-500/60 pl-2.5",
      )}
    >
      <span className={cn(fight.completed && "line-through opacity-50")}>
        {fight.importedFrom && !fight.completed && <span className="mr-1 text-yellow-400">🔀</span>}
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
            {current.completed && (
              <Badge variant="secondary" className="w-full justify-center">Completado</Badge>
            )}
            {loaded ? (
              <Button size="lg" variant="outline" className="w-full" onClick={onReset}>
                <RotateCcw className="size-4" />
                Reiniciar
              </Button>
            ) : (
              <Button size="lg" className="w-full" onClick={onLoad}>
                Cargar combate
              </Button>
            )}
          </>
        )}
        <Separator />
        <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
          {(() => {
            const localFights = fights.filter((f) => !f.importedFrom);
            const imported = fights.filter((f) => f.importedFrom);
            const regular = localFights.filter((f) => !f.isTiebreakExtra && !f.isFinalFight);
            const finals = localFights.filter((f) => f.isFinalFight);
            const tiebreaks = localFights.filter((f) => f.isTiebreakExtra);
            const groups = Array.from(new Set(regular.map((f) => f.groupId ?? "—")));
            const isGrouped = groups.some((g) => g !== "—");

            const regularSection = isGrouped
              ? groups.map((gid) => {
                  const gFights = fights.map((f, i) => ({ f, i })).filter(({ f }) => !f.isTiebreakExtra && !f.isFinalFight && !f.importedFrom && (f.groupId ?? "—") === gid);
                  return (
                    <div key={gid}>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-1 pt-1 pb-0.5">
                        Llave {gid}
                      </p>
                      {gFights.map(({ f, i }) => (
                        <FightListRow key={f.id} fight={f} index={i} active={i === currentIndex} onSelect={onSelectIndex} />
                      ))}
                    </div>
                  );
                })
              : regular.map((f) => {
                  const i = fights.indexOf(f);
                  return <FightListRow key={f.id} fight={f} index={i} active={i === currentIndex} onSelect={onSelectIndex} />;
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

            const importedSection = imported.length > 0
              ? (
                <div key="__imported__">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400/90 px-1 pt-2 pb-0.5">
                    🔀 Reasignadas ({imported.filter((f) => !f.completed).length} pendientes)
                  </p>
                  {imported.map((f) => {
                    const i = fights.indexOf(f);
                    return <FightListRow key={f.id} fight={f} index={i} active={i === currentIndex} onSelect={onSelectIndex} />;
                  })}
                </div>
              )
              : null;

            return [...regularSection, finalSection, tbSection, importedSection];
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
            <Button size="xl" className="bg-green-700 hover:bg-green-600" onClick={() => onEmit("tul:finish")}>
              <Check />
              Confirmar resultado
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEmit("tul:retry")}>
              ↺ Nueva votación
            </Button>
          </div>
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
        <Button size="xl" className="bg-green-700 hover:bg-green-600" onClick={() => onEmit("match:start")}>
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
    (isRunning || matchPaused) && (phase === "round" || phase === "overtime" || phase === "golden_point");

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

  return (
    <div className="flex flex-col items-center gap-3 w-full">
      {/* Acciones primarias */}
      <div className="flex flex-wrap gap-2 justify-center">
        {canStart && (
          <Button size="xl" className="bg-green-700 hover:bg-green-600" onClick={() => onEmit("match:start")}>
            <Play />
            Iniciar combate
          </Button>
        )}
        {canPause && (
          <Button size="xl" variant="outline" onClick={() => onEmit("match:pause")}>
            <Pause />
            Pausar
          </Button>
        )}
        {canResume && (
          <Button size="xl" className="bg-yellow-700 hover:bg-yellow-600" onClick={() => onEmit("match:resume")}>
            <Play />
            Reanudar
          </Button>
        )}
        {canFinish && (
          <Button size="xl" variant="secondary" onClick={() => onEmit("match:finishRound")}>
            <SkipForward />
            Finalizar combate
          </Button>
        )}
        {phase === "penalties" && (
          <Button size="xl" className="bg-orange-700 hover:bg-orange-600" onClick={() => onEmit("match:confirmPenalties")}>
            Confirmar penalizaciones
          </Button>
        )}
      </div>
      {/* Zona de peligro — separada visualmente, botones discretos */}
      {!isFinished && (
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
      )}
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

export function FightPage() {
  const { connected, state, emit, socket } = useSocket();
  const navigate = useNavigate();
  const { fights, currentFightIndex, setCurrentFightIndex, completeFight, completeBracketMatch, setPhase, config, addImportedFights } =
    useTournamentStore(
      useShallow((s) => ({
        fights: s.fights,
        currentFightIndex: s.currentFightIndex,
        setCurrentFightIndex: s.setCurrentFightIndex,
        completeFight: s.completeFight,
        completeBracketMatch: s.completeBracketMatch,
        setPhase: s.setPhase,
        config: s.config,
        addImportedFights: s.addImportedFights,
      }))
    );

  const [loaded, setLoaded] = React.useState(false);
  const [judgeMode, setJudgeMode] = React.useState<"mesa" | "movil">("mesa");
  const [bottomTab, setBottomTab] = React.useState<"judges" | "penalties">("judges");
  const [showFightList, setShowFightList] = React.useState(false);
  const [resultDialogOpen, setResultDialogOpen] = React.useState(false);
  const [resultFlagsRed, setResultFlagsRed] = React.useState(0);
  const [resultFlagsBlue, setResultFlagsBlue] = React.useState(0);
  const [showImportedPanel, setShowImportedPanel] = React.useState(true);

  const currentFight = fights[currentFightIndex];
  const { matchState, matchPaused, judges } = state;
  const penaltyCounts = state.penaltyCounts ?? { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } };
  const phase = matchState?.phase ?? "idle";
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
  const flagCount = {
    red: Object.values(state.judgeVotes ?? {}).filter((v) => v === "red").length,
    blue: Object.values(state.judgeVotes ?? {}).filter((v) => v === "blue").length,
  };
  // Solo muestra número cuando alguien tiene mayoría estricta de jueces
  const hasMobileData = Object.values(state.judgeTotals ?? {}).some(
    (j) => (j.red ?? 0) > 0 || (j.blue ?? 0) > 0,
  );
  const _judgesCount = config.judgesCount ?? 4;
  const scoreDisplay = hasMobileData ? judgeLeadCount : flagCount;
  const timeLeft = matchState?.timeLeft ?? 0;
  const currentRound = matchState?.currentRound ?? 1;
  const isRunning = phase === "round" || phase === "overtime" || phase === "golden_point";
  /** Modo Tul: los competidores ejecutan formas, los jueces votan rojo/azul */
  const isTul = config.matchType === 'tul';

  // biome-ignore lint/correctness/useExhaustiveDependencies: setLoaded is a stable state setter — no need in deps
  React.useEffect(() => {
    setLoaded(false);
  }, [currentFightIndex]);

  // Listen for fights imported by Mesa Central from another tatami.
  // The server emits 'fights:imported' after a successful import-fights call.
  React.useEffect(() => {
    if (!socket) return;
    function onFightsImported(payload: { fights: Array<{ id: string; red: { id: string; name: string }; blue: { id: string; name: string }; completed: boolean; groupId?: string }>; sourceRingLabel?: string | null }) {
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
        { description: "Revisalas en el panel \"Peleas reasignadas\" de la página de combate.", duration: 8000 }
      );
      setShowImportedPanel(true);
    }
    socket.on('fights:imported', onFightsImported);
    return () => { socket.off('fights:imported', onFightsImported); };
  }, [socket, addImportedFights]);

  // Listen 'fight:remote-completed': el tatami destino terminó una pelea reasignada
  // y nos notifica el resultado para que podamos completarla en nuestro Zustand.
  React.useEffect(() => {
    if (!socket) return;
    function onRemoteCompleted(payload: {
      fightId: string;
      winner: string;
      flagsRed: number;
      flagsBlue: number;
      completedIn: string;
    }) {
      completeFight(
        payload.fightId,
        payload.winner as "red" | "blue" | "draw",
        `Jugada en ${payload.completedIn}`,
        payload.flagsRed,
        payload.flagsBlue,
      );
      const winnerLabel = payload.winner === "red" ? "Rojo" : payload.winner === "blue" ? "Azul" : "Empate";
      toast.success(`✅ Resultado de ${payload.completedIn}: ${winnerLabel} ganó`, {
        description: "Pelea marcada como completada.",
      });
    }
    socket.on('fight:remote-completed', onRemoteCompleted);
    return () => { socket.off('fight:remote-completed', onRemoteCompleted); };
  }, [socket, completeFight]);

  // Auto-load desde DB del servidor al montar. Siempre se ejecuta para detectar
  // peleas importadas mientras la FightPage no estaba abierta (socket event perdido).
  // addImportedFights deduplica por ID, así que es seguro llamarlo aunque el store
  // ya tenga peleas de un torneo local.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount to sync imported fights from server DB
  React.useEffect(() => {
    fetch("/api/ring/queue")
      .then((r) => r.json())
      .then((queue: Array<{ fight: { id: string; red: { id: string; name: string }; blue: { id: string; name: string } } }>) => {
        if (!Array.isArray(queue) || queue.length === 0) return;
        addImportedFights(
          queue.map(({ fight: f }) => ({
            id: f.id,
            red: { id: f.red.id, name: f.red.name },
            blue: { id: f.blue.id, name: f.blue.name },
            completed: false,
            importedFrom: "Mesa Central",
          }))
        );
      })
      .catch(() => { /* non-critical */ });
  }, []); // intentional empty deps — run once on mount

  // Auto-sync: garantiza que el servidor DB tiene todas las peleas pendientes.
  // INSERT OR IGNORE → seguro llamarlo varias veces, no resetea estado.
  // Depende de fights.length para re-disparar después de Zustand persist hydration.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fights.length re-triggers after Zustand hydration; other deps are stable
  React.useEffect(() => {
    if (fights.length === 0) return;
    const pending = fights.filter((f) => !f.completed);
    if (pending.length === 0) return;
    const uniqueCompetitors = Array.from(
      new Map(
        pending.flatMap((f) => [
          [f.red.id, { id: f.red.id, name: f.red.name, team: f.red.team }],
          [f.blue.id, { id: f.blue.id, name: f.blue.name, team: f.blue.team }],
        ])
      ).values()
    );
    fetch("/api/ring/sync-fights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competitors: uniqueCompetitors,
        fights: pending.map((f) => ({ id: f.id, red_id: f.red.id, blue_id: f.blue.id })),
      }),
    }).catch(() => { /* non-critical */ });
  }, [fights.length]);

  function handleLoad() {
    if (!currentFight) return;
    const baseRules = (config.ruleSet as RuleSetSparring) ?? DEFAULT_RULES;
    // judgingMode must match the UI mode: mobile judges score points, mesa judges vote flags
    const rules: RuleSetSparring = {
      ...baseRules,
      judgingMode: judgeMode === "movil" ? "points" : "flags",
    };
    emit("match:load", {
      rules,
      match: {
        id: currentFight.id,
        ringId: "ring-1",
        category: config.categoryName || undefined,
    matchMode: (rules as { mode?: string }).mode === 'patterns' ? 'patterns' : config.matchType === 'tul' ? 'tul' : 'sparring',
        red: { id: currentFight.red.id, name: currentFight.red.name, club: currentFight.red.team },
        blue: { id: currentFight.blue.id, name: currentFight.blue.name, club: currentFight.blue.team },
      },
    });
    setLoaded(true);
  }

  // When judge mode changes while a fight is loaded in "idle", reload so judgingMode matches.
  // If mid-fight, just warn — change takes effect on next fight.
  const prevJudgeModeRef = React.useRef(judgeMode);
  React.useEffect(() => {
    if (prevJudgeModeRef.current === judgeMode) return;
    prevJudgeModeRef.current = judgeMode;
    if (!loaded || !currentFight) return;
    if (phase === "idle") {
      handleLoad();
    } else if (phase !== "finished") {
      toast.info("Cambiar modo tiene efecto en la próxima pelea");
    }
  });

  function handleOpenResultDialog() {
    if (!matchState?.result) return;
    let fr = (state.roundFlags ?? []).reduce((s, r) => s + r.red, 0);
    let fb = (state.roundFlags ?? []).reduce((s, r) => s + r.blue, 0);
    // En modo puntos (jueces móviles) roundFlags no se llena — usar conteo de jueces líderes
    if (fr === 0 && fb === 0) {
      const jt = state.judgeTotals ?? {};
      for (const t of Object.values(jt)) {
        if ((t.red ?? 0) > (t.blue ?? 0)) fr++;
        else if ((t.blue ?? 0) > (t.red ?? 0)) fb++;
      }
    }
    setResultFlagsRed(fr);
    setResultFlagsBlue(fb);
    setResultDialogOpen(true);
  }

  function handleConfirmResult() {
    if (!currentFight) return;
    const winner = matchState?.result?.winner;
    const reason = matchState?.result?.reason ?? "points";
    if (!winner) return;
    completeFight(currentFight.id, winner, reason, resultFlagsRed, resultFlagsBlue);
    if (currentFight.bracketMatchId && winner !== "draw") {
      completeBracketMatch(currentFight.bracketMatchId, winner === "red" ? currentFight.red.id : currentFight.blue.id);
    }
    setResultDialogOpen(false);
    const next = currentFightIndex + 1;
    if (next >= fights.length) {
      setPhase("results");
      navigate("/standings");
    } else {
      setCurrentFightIndex(next);
    }
    setLoaded(false);
  }

  if (fights.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>No hay combates. Configura la categoría primero.</p>
      </div>
    );
  }

  const redName = state.match?.red.name ?? currentFight?.red.name ?? "Rojo";
  const blueName = state.match?.blue.name ?? currentFight?.blue.name ?? "Azul";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* Click-away overlay para cerrar la lista de combates */}
      {showFightList && (
        <div className="fixed inset-0 z-40" onClick={() => setShowFightList(false)} />
      )}

      {/* ── TOP BAR ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-border px-4 py-2 flex items-center gap-2">

        {/* Navegación de combates con dropdown */}
        <div className="relative z-50 flex items-center gap-1 shrink-0">
          <Button
            size="icon" variant="ghost" className="size-8"
            disabled={currentFightIndex === 0}
            onClick={() => setCurrentFightIndex(currentFightIndex - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <button
            type="button"
            onClick={() => setShowFightList((v) => !v)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary hover:bg-accent text-sm font-medium transition-colors"
          >
            <span className="tabular-nums text-xs text-muted-foreground font-normal shrink-0">
              {currentFightIndex + 1}/{fights.length}
            </span>
            {currentFight && (
              <>
                <span className="text-red-400 font-bold max-w-[8rem] truncate">{currentFight.red.name}</span>
                <span className="text-muted-foreground text-xs shrink-0">vs</span>
                <span className="text-blue-400 font-bold max-w-[8rem] truncate">{currentFight.blue.name}</span>
              </>
            )}
            <ChevronDown className={cn("size-3.5 text-muted-foreground shrink-0 ml-1 transition-transform", showFightList && "rotate-180")} />
          </button>
          <Button
            size="icon" variant="ghost" className="size-8"
            disabled={currentFightIndex === fights.length - 1}
            onClick={() => setCurrentFightIndex(currentFightIndex + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>

          {/* Dropdown lista de combates */}
          {showFightList && (
            <div className="absolute top-full left-0 mt-1.5 w-80 rounded-xl border border-border bg-popover shadow-2xl overflow-hidden">
              <div className="max-h-72 overflow-y-auto p-2 space-y-0.5">
                {(() => {
                  const regular = fights.filter((f) => !f.isTiebreakExtra && !f.isFinalFight);
                  const finals = fights.filter((f) => f.isFinalFight);
                  const tiebreaks = fights.filter((f) => f.isTiebreakExtra);
                  const groups = Array.from(new Set(regular.map((f) => f.groupId ?? "—")));
                  const isGrouped = groups.some((g) => g !== "—");

                  const mkRow = (f: FightEntry) => {
                    const i = fights.indexOf(f);
                    return (
                      <FightListRow
                        key={f.id} fight={f} index={i} active={i === currentFightIndex}
                        onSelect={(idx) => { setCurrentFightIndex(idx); setShowFightList(false); }}
                      />
                    );
                  };

                  const regularSection = isGrouped
                    ? groups.map((gid) => {
                        const gFights = regular.filter((f) => (f.groupId ?? "—") === gid);
                        return (
                          <div key={gid}>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-1 pt-1 pb-0.5">
                              Llave {gid}
                            </p>
                            {gFights.map(mkRow)}
                          </div>
                        );
                      })
                    : regular.map(mkRow);

                  return [
                    ...regularSection,
                    finals.length > 0 && (
                      <div key="__finals__">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-yellow-400/80 px-1 pt-2 pb-0.5">🏆 Final</p>
                        {finals.map(mkRow)}
                      </div>
                    ),
                    tiebreaks.length > 0 && (
                      <div key="__tiebreaks__">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-400/70 px-1 pt-2 pb-0.5">⚡ Desempate</p>
                        {tiebreaks.map(mkRow)}
                      </div>
                    ),
                  ];
                })()}
              </div>
            </div>
          )}
        </div>

        {/* Reiniciar (solo cuando ya está cargado) */}
        {loaded && (
          <Button size="sm" variant="outline" className="shrink-0"
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

        <div className="flex-1" />

        <ServerStatus connected={connected} judgesCount={judges.length} />
      </div>

      {/* ── BANNER PELEA REASIGNADA ───────────────────────────── */}
      {currentFight?.importedFrom && (
        <div className="shrink-0 flex items-center justify-center gap-2 py-1.5 bg-yellow-500/15 border-b border-yellow-500/30 text-yellow-300 text-xs font-medium tracking-wide">
          🔀 PELEA REASIGNADA · Originada en: <span className="font-bold">{currentFight.importedFrom}</span>
        </div>
      )}

      {/* ── ARENA ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">

        {/* DESKTOP (md+): 3 columnas lado a lado */}
        <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr]">

          {/* ROJO */}
          <div className="flex flex-col items-center justify-center gap-5 px-8 py-6 bg-red-950/50 border-r border-red-900/40">
            <p className="text-3xl font-black text-red-400 uppercase tracking-wide text-center leading-tight max-w-full truncate">
              {redName}
            </p>
            <div className="text-[10rem] font-black leading-none rounded-2xl px-14 py-8 bg-red-950/30 text-red-400 ring-card-red tabular-nums">
              {scoreDisplay.red}
            </div>
            {penaltyCounts.warnings.red > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xl font-black text-yellow-400">⚠ {penaltyCounts.warnings.red}</span>
                {warnDeductions(penaltyCounts.warnings.red) > 0 && (
                  <span className="text-sm font-bold text-orange-400 bg-orange-950/50 rounded px-2 py-0.5">
                    −{warnDeductions(penaltyCounts.warnings.red)} pts
                  </span>
                )}
              </div>
            )}
            {loaded && !isTul && (
              <div className="w-full space-y-2 mt-1">
                <div className="flex gap-2">
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "warning_minor" })}
                    className="flex-1 text-sm font-bold py-2 rounded-xl border border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    + Advertencia
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.warnings.red === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "remove_warning" })}
                    className="px-4 text-sm font-bold py-2 rounded-xl border border-yellow-800/40 text-yellow-600 hover:bg-yellow-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Deshacer advertencia">
                    ↩ Adv
                  </button>
                </div>
                <div className="flex gap-2">
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "minus_point" })}
                    className="flex-1 text-sm font-bold py-2 rounded-xl border border-red-600 text-red-300 bg-red-950/40 hover:bg-red-900/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    − Punto directo
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.fouls.red === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "remove_minus_point" })}
                    className="px-4 text-sm font-bold py-2 rounded-xl border border-border text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Deshacer punto directo">
                    ↩ Pto
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* CENTRO: timer + controles */}}
          <div className="flex flex-col items-center justify-center gap-4 px-8 py-6 min-w-85">
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
                {PHASE_LABELS[phase]}{roundSuffix(phase, currentRound)}
              </Badge>
              {showPauseBadge(matchPaused, phase) && (
                <Badge variant="outline" className="text-yellow-400 border-yellow-600">PAUSA</Badge>
              )}
            </div>
            <div className={cn(
              "font-mono font-black leading-none text-9xl",
              timerClass(timeLeft, isRunning, matchPaused),
              isTul && "hidden",
            )}>
              {formatTime(timeLeft)}
            </div>
            {loaded ? (
              <MatchControls
                loaded={loaded}
                isFinished={isFinished}
                phase={phase}
                matchPaused={matchPaused}
                fight={currentFight}
                isLast={currentFightIndex === fights.length - 1}
                state={state}
                isTul={isTul}
                onEmit={emit}
                onFinishAndNext={handleOpenResultDialog}
              />
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Button size="xl" className="bg-green-700 hover:bg-green-600" onClick={handleLoad}>
                  <Play />
                  Cargar combate
                </Button>
              </div>
            )}
          </div>

          {/* AZUL */}
          <div className="flex flex-col items-center justify-center gap-5 px-8 py-6 bg-blue-950/50 border-l border-blue-900/40">
            <p className="text-3xl font-black text-blue-400 uppercase tracking-wide text-center leading-tight max-w-full truncate">
              {blueName}
            </p>
            <div className="text-[10rem] font-black leading-none rounded-2xl px-14 py-8 bg-blue-950/30 text-blue-400 ring-card-blue tabular-nums">
              {scoreDisplay.blue}
            </div>
            {penaltyCounts.warnings.blue > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xl font-black text-yellow-400">⚠ {penaltyCounts.warnings.blue}</span>
                {warnDeductions(penaltyCounts.warnings.blue) > 0 && (
                  <span className="text-sm font-bold text-orange-400 bg-orange-950/50 rounded px-2 py-0.5">
                    −{warnDeductions(penaltyCounts.warnings.blue)} pts
                  </span>
                )}
              </div>
            )}
            {loaded && !isTul && (
              <div className="w-full space-y-2 mt-1">
                <div className="flex gap-2">
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "warning_minor" })}
                    className="flex-1 text-sm font-bold py-2 rounded-xl border border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    + Advertencia
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.warnings.blue === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "remove_warning" })}
                    className="px-4 text-sm font-bold py-2 rounded-xl border border-yellow-800/40 text-yellow-600 hover:bg-yellow-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Deshacer advertencia">
                    ↩ Adv
                  </button>
                </div>
                <div className="flex gap-2">
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "minus_point" })}
                    className="flex-1 text-sm font-bold py-2 rounded-xl border border-blue-600 text-blue-300 bg-blue-950/40 hover:bg-blue-900/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    − Punto directo
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.fouls.blue === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "remove_minus_point" })}
                    className="px-4 text-sm font-bold py-2 rounded-xl border border-border text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    title="Deshacer punto directo">
                    ↩ Pto
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* MOBILE (<md): layout vertical — timer arriba, scores lado a lado, controles abajo */}
        <div className="flex flex-col h-full md:hidden">

          {/* Fase + Cronómetro */}
          <div className="shrink-0 flex items-center justify-center gap-3 px-4 py-2 border-b border-border">
            <Badge className={cn(
              "text-xs px-3 py-1",
              phase === "round" && "bg-green-600",
              phase === "rest" && "bg-yellow-600",
              phase === "overtime" && "bg-orange-600",
              phase === "golden_point" && "bg-purple-600",
              phase === "finished" && "bg-blue-700",
              phase === "penalties" && "bg-red-800",
              phase === "idle" && "bg-secondary"
            )}>
              {PHASE_LABELS[phase]}{roundSuffix(phase, currentRound)}
            </Badge>
            {showPauseBadge(matchPaused, phase) && (
              <Badge variant="outline" className="text-yellow-400 border-yellow-600 text-xs">PAUSA</Badge>
            )}
            <div className={cn(
              "font-mono font-black leading-none text-4xl tabular-nums",
              timeLeft <= 10 && isRunning && !matchPaused ? "text-red-400" : "",
              isTul && "hidden",
            )}>
              {formatTime(timeLeft)}
            </div>
          </div>

          {/* Scores 2 columnas */}
          <div className="shrink-0 grid grid-cols-2 border-b border-border">
            {/* ROJO */}
            <div className="flex flex-col items-center justify-center gap-2 py-5 px-3 bg-red-950/50 border-r border-red-900/40">
              <p className="text-sm font-black text-red-400 uppercase tracking-wide text-center leading-tight w-full truncate">
                {redName}
              </p>
              <div className="text-7xl font-black leading-none text-red-400 tabular-nums">
                {scoreDisplay.red}
              </div>
              {penaltyCounts.warnings.red > 0 && (
                <div className="flex items-center gap-1">
                  <span className="text-base font-black text-yellow-400">⚠ {penaltyCounts.warnings.red}</span>
                  {warnDeductions(penaltyCounts.warnings.red) > 0 && (
                    <span className="text-xs font-bold text-orange-400">−{warnDeductions(penaltyCounts.warnings.red)}pts</span>
                  )}
                </div>
              )}
              {loaded && !isTul && (
                <div className="grid grid-cols-2 gap-1 w-full">
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "warning_minor" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    +Adv
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.warnings.red === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "remove_warning" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-yellow-800/40 text-yellow-600 hover:bg-yellow-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    ↩Adv
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "minus_point" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-red-600 text-red-300 bg-red-950/40 hover:bg-red-900/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    −Pto
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.fouls.red === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "red", type: "remove_minus_point" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-border text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    ↩Pto
                  </button>
                </div>
              )}
            </div>
            {/* AZUL */}
            <div className="flex flex-col items-center justify-center gap-2 py-5 px-3 bg-blue-950/50">
              <p className="text-sm font-black text-blue-400 uppercase tracking-wide text-center leading-tight w-full truncate">
                {blueName}
              </p>
              <div className="text-7xl font-black leading-none text-blue-400 tabular-nums">
                {scoreDisplay.blue}
              </div>
              {penaltyCounts.warnings.blue > 0 && (
                <div className="flex items-center gap-1">
                  <span className="text-base font-black text-yellow-400">⚠ {penaltyCounts.warnings.blue}</span>
                  {warnDeductions(penaltyCounts.warnings.blue) > 0 && (
                    <span className="text-xs font-bold text-orange-400">−{warnDeductions(penaltyCounts.warnings.blue)}pts</span>
                  )}
                </div>
              )}
              {loaded && !isTul && (
                <div className="grid grid-cols-2 gap-1 w-full">
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "warning_minor" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    +Adv
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.warnings.blue === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "remove_warning" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-yellow-800/40 text-yellow-600 hover:bg-yellow-900/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    ↩Adv
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished"}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "minus_point" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-blue-600 text-blue-300 bg-blue-950/40 hover:bg-blue-900/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    −Pto
                  </button>
                  <button type="button"
                    disabled={phase === "idle" || phase === "finished" || penaltyCounts.fouls.blue === 0}
                    onClick={() => emit("match:event", { judgeId: "arbiter", competitor: "blue", type: "remove_minus_point" })}
                    className="text-[11px] font-bold py-1.5 rounded border border-border text-muted-foreground hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                    ↩Pto
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Controles */}
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 py-4 overflow-y-auto">
            {loaded ? (
              <MatchControls
                loaded={loaded}
                isFinished={isFinished}
                phase={phase}
                matchPaused={matchPaused}
                fight={currentFight}
                isLast={currentFightIndex === fights.length - 1}
                state={state}
                isTul={isTul}
                onEmit={emit}
                onFinishAndNext={handleOpenResultDialog}
              />
            ) : (
              <Button size="xl" className="bg-green-700 hover:bg-green-600" onClick={handleLoad}>
                <Play />
                Cargar combate
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── PANEL INFERIOR (TABS) ─────────────────────────────────── */}
      {loaded && (
        <div className="shrink-0 border-t border-border bg-card/40 px-4 py-2 space-y-2 max-h-[42vh] overflow-y-auto">
          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-border/40 pb-1">
            <button
              type="button"
              onClick={() => setBottomTab("judges")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-t text-xs font-medium transition-colors border-b-2 -mb-0.75",
                bottomTab === "judges"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Users className="size-3" />
              Jueces
            </button>
            <button
              type="button"
              onClick={() => setBottomTab("penalties")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-t text-xs font-medium transition-colors border-b-2 -mb-0.75",
                bottomTab === "penalties"
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
                isTul && "hidden",
              )}
            >
              ⚠️ Penalizaciones
            </button>
            {/* Modo Jefe/Móvil: oculto en tul (siempre móvil para voto) */}
            {bottomTab === "judges" && !isTul && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setJudgeMode("mesa")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium transition-colors",
                    judgeMode === "mesa"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  <Keyboard className="size-3" />
                  Jefe de Mesa
                </button>
                <button
                  type="button"
                  onClick={() => setJudgeMode("movil")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium transition-colors",
                    judgeMode === "movil"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-secondary",
                  )}
                >
                  <Smartphone className="size-3" />
                  Pro / Móvil
                </button>
              </div>
            )}
          </div>

          {/* Tab: Jueces */}
          {bottomTab === "judges" && (
            <>
              <JudgeCornerGrid
                judgesCount={config.judgesCount}
                connectedJudges={judges}
                judgeTotals={state.judgeTotals ?? {}}
                judgeVotes={state.judgeVotes ?? {}}
                serverUrl={judgeMode === "movil" ? state.serverUrl : undefined}
                ringToken={judgeMode === "movil" ? state.ringToken : undefined}
              />
              {judgeMode === "mesa" && !isTul && (
                <JefeMesaPanel
                  judgesCount={config.judgesCount}
                  judgeVotes={state.judgeVotes}
                  roundFlags={state.roundFlags ?? []}
                  phase={phase}
                  pendingJuryDecision={matchState?.pendingJuryDecision ?? false}
                  penaltyCounts={penaltyCounts}
                  redName={currentFight?.red.name ?? "Rojo"}
                  blueName={currentFight?.blue.name ?? "Azul"}
                  onEmit={emit}
                  hidePenalties={true}
                />
              )}
            </>
          )}

          {/* Tab: Penalizaciones */}
          {bottomTab === "penalties" && (
            <PenaltiesTabContent
              phase={phase}
              redName={currentFight?.red.name ?? "Rojo"}
              blueName={currentFight?.blue.name ?? "Azul"}
              penaltyCounts={penaltyCounts}
              onEmit={emit}
            />
          )}
        </div>
      )}

      {/* ── PANEL PELEAS REASIGNADAS DESDE OTRO TATAMI ───────────── */}
      {(() => {
        // Agrupa peleas pendientes por tatami origen
        const imported = fights.filter((f) => f.importedFrom && !f.completed);
        if (imported.length === 0) return null;
        const byOrigin = new Map<string, typeof fights>();
        for (const f of imported) {
          // biome-ignore lint/style/noNonNullAssertion: imported array was filtered to only include f.importedFrom truthy values
          const key = f.importedFrom!;
          if (!byOrigin.has(key)) byOrigin.set(key, []);
          // biome-ignore lint/style/noNonNullAssertion: byOrigin.set() called above guarantees key exists
          byOrigin.get(key)!.push(f);
        }
        return (
          <div className="shrink-0 border-t border-yellow-700/40 bg-yellow-950/10">
            {/* Header colapsable */}
            <button
              type="button"
              onClick={() => setShowImportedPanel((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2 text-left hover:bg-yellow-900/10 transition-colors"
            >
              <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-yellow-400/90">
                <span>🔀</span>
                Peleas reasignadas ({imported.length})
              </span>
              <ChevronDown className={cn("size-3.5 text-yellow-400/70 transition-transform", showImportedPanel && "rotate-180")} />
            </button>

            {showImportedPanel && (
              <div className="px-4 pb-3 space-y-3">
                {Array.from(byOrigin.entries()).map(([origin, originFights]) => (
                  <div key={origin}>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-yellow-500/70 mb-1.5">
                      Desde {origin} · {originFights.length} pendiente{originFights.length !== 1 ? "s" : ""}
                    </p>
                    <div className="space-y-1">
                      {originFights.map((f) => {
                        const idx = fights.indexOf(f);
                        const isActive = idx === currentFightIndex;
                        return (
                          <div
                            key={f.id}
                            className={cn(
                              "flex items-center justify-between rounded-lg px-3 py-2 border text-sm transition-colors",
                              isActive
                                ? "border-yellow-500/60 bg-yellow-900/30 text-yellow-200"
                                : "border-border bg-card hover:bg-secondary/50 text-foreground",
                            )}
                          >
                            <span className="font-medium">
                              <span className="text-red-400">{f.red.name}</span>
                              <span className="text-muted-foreground mx-2">vs</span>
                              <span className="text-blue-400">{f.blue.name}</span>
                            </span>
                            {isActive ? (
                              <span className="text-[10px] font-semibold text-yellow-400 uppercase tracking-wide">En curso</span>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-3 text-xs border-yellow-700/60 text-yellow-400 hover:bg-yellow-900/30"
                                onClick={() => {
                                  setCurrentFightIndex(idx);
                                  setLoaded(false);
                                }}
                              >
                                Ir a esta pelea
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── DIALOG RESULTADO ─────────────────────────────────────── */}
      {matchState?.result != null && (
        <Dialog open={resultDialogOpen} onOpenChange={setResultDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Registrar resultado del combate</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className={cn("rounded-xl p-3 text-center", resultBannerClass(matchState?.result?.winner ?? "draw"))}>
                <div className="text-xl font-black flex items-center justify-center gap-2">
                  <Trophy className="size-5" />
                  {winnerName(matchState?.result?.winner ?? "draw", state, currentFight)}
                </div>
                <p className="text-sm text-muted-foreground">
                  {matchState?.result?.winner === "draw"
                    ? "1 punto para cada uno (Empate)"
                    : matchState?.result?.winner
                      ? "3 puntos (Victoria)"
                      : "Resultado manual"}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Banderines totales</p>
                <div className="grid grid-cols-2 gap-3">
                  <FlagCounterField
                    isMesa={judgeMode === "mesa"}
                    value={resultFlagsRed}
                    onChange={setResultFlagsRed}
                    color="red"
                    name={currentFight?.red.name ?? "Rojo"}
                    max={config.judgesCount}
                  />
                  <FlagCounterField
                    isMesa={judgeMode === "mesa"}
                    value={resultFlagsBlue}
                    onChange={setResultFlagsBlue}
                    color="blue"
                    name={currentFight?.blue.name ?? "Azul"}
                    max={config.judgesCount}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Penalizaciones registradas</p>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-border p-2 space-y-0.5">
                    <p className="text-red-400 font-semibold">{currentFight?.red.name ?? "Rojo"}</p>
                    <p className="text-muted-foreground">Advertencias: <span className="font-medium text-foreground">{penaltyCounts.warnings.red}</span></p>
                    <p className="text-muted-foreground">Faltas: <span className="font-medium text-foreground">{penaltyCounts.fouls.red}</span></p>
                  </div>
                  <div className="rounded-lg border border-border p-2 space-y-0.5">
                    <p className="text-blue-400 font-semibold">{currentFight?.blue.name ?? "Azul"}</p>
                    <p className="text-muted-foreground">Advertencias: <span className="font-medium text-foreground">{penaltyCounts.warnings.blue}</span></p>
                    <p className="text-muted-foreground">Faltas: <span className="font-medium text-foreground">{penaltyCounts.fouls.blue}</span></p>
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button className="w-full" onClick={handleConfirmResult}>
                <ChevronRight className="size-4" />
                Confirmar y continuar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
