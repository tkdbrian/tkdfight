import { useSocket } from "@/hooks/useSocket";
import { formatTime, PHASE_LABELS, sumJudgeTotals } from "@/lib/fight-utils";
import { cn } from "@/lib/utils";
import { Wifi, WifiOff } from "lucide-react";
import type { ServerState } from "@/lib/socket-types";

function judgesLabel(count: number): string {
  return count === 1 ? "1 juez" : `${count} jueces`;
}

function phaseBadgeClass(phase: string): string {
  const map: Record<string, string> = {
    round: "bg-green-700 text-white",
    rest: "bg-yellow-700 text-white",
    overtime: "bg-orange-700 text-white",
    golden_point: "bg-purple-700 text-white",
    finished: "bg-blue-800 text-white",
    penalties: "bg-red-800 text-white",
    idle: "bg-gray-800 text-gray-400",
  };
  return map[phase] ?? "bg-gray-800 text-gray-400";
}

function winnerLabel(state: ServerState): string {
  const result = state.matchState?.result;
  if (!result) return "";
  if (result.winner === "draw") return "EMPATE";
  const name =
    result.winner === "red"
      ? state.match?.red.name
      : state.match?.blue.name;
  return `GANADOR: ${name?.toUpperCase() ?? ""}`;
}

function ScoreBox({
  score,
  winner,
  side,
  isFinished,
}: Readonly<{
  score: number;
  winner: string | undefined;
  side: "red" | "blue";
  isFinished: boolean;
}>) {
  const isWinner = isFinished && winner === side;
  const baseClass =
    side === "red" ? "bg-red-950/50 border-2" : "bg-blue-950/50 border-2";
  const winClass =
    side === "red"
      ? "border-red-400 shadow-[0_0_40px_rgba(239,68,68,0.4)]"
      : "border-blue-400 shadow-[0_0_40px_rgba(59,130,246,0.4)]";
  const normalClass = side === "red" ? "border-red-900/40" : "border-blue-900/40";
  const textClass = side === "red" ? "text-red-400" : "text-blue-400";

  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-2xl h-full min-h-36",
        baseClass,
        isWinner ? winClass : normalClass
      )}
    >
      <span className={cn("text-[8rem] font-black leading-none", textClass)}>
        {score}
      </span>
    </div>
  );
}

export function TVPage() {
  const { connected, state } = useSocket();
  const { matchState, match, matchPaused, judges } = state;
  const phase = matchState?.phase ?? "idle";
  const totals = sumJudgeTotals(state.judgeTotals);
  const timeLeft = matchState?.timeLeft ?? 0;
  const isRunning = phase === "round" || phase === "overtime";
  const isFinished = phase === "finished";
  const winner = matchState?.result?.winner;
  const phaseLabel =
    PHASE_LABELS[phase] +
    ((phase === "round" || phase === "rest") ? ` · R${matchState?.currentRound ?? 1}` : "");

  return (
    <div className="flex-1 flex flex-col bg-gray-950 text-white overflow-hidden select-none">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 bg-gray-900/80 border-b border-white/5">
        <span className="font-bold tracking-widest text-sm uppercase text-gray-400">
          TKD Tournament
        </span>
        <div className={cn("flex items-center gap-1.5 text-xs", connected ? "text-green-400" : "text-red-400")}>
          {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
          {connected ? `En vivo · ${judgesLabel(judges.length)}` : "Sin conexión"}
        </div>
      </div>

      <div className="flex-1 grid grid-rows-[auto_1fr_auto] p-6 gap-4">
        {/* Fighter names */}
        <div className="grid grid-cols-3 items-center gap-4">
          <div className="text-center">
            <p className="text-xl font-bold text-red-400 uppercase tracking-wide truncate">
              {match?.red.name ?? "—"}
            </p>
            {match?.red.club && <p className="text-sm text-gray-500">{match.red.club}</p>}
          </div>
          <div className="text-center text-gray-600 font-bold text-lg">vs</div>
          <div className="text-center">
            <p className="text-xl font-bold text-blue-400 uppercase tracking-wide truncate">
              {match?.blue.name ?? "—"}
            </p>
            {match?.blue.club && <p className="text-sm text-gray-500">{match.blue.club}</p>}
          </div>
        </div>

        {/* Big scores */}
        <div className="grid grid-cols-3 items-center gap-4">
          <ScoreBox score={totals.red} winner={winner} side="red" isFinished={isFinished} />

          <div className="flex flex-col items-center justify-center gap-2">
            <div className={cn(
              "font-mono font-black leading-none",
              timeLeft <= 10 && isRunning && !matchPaused
                ? "text-7xl text-red-400 animate-pulse"
                : "text-6xl text-white"
            )}>
              {formatTime(timeLeft)}
            </div>
            <div className={cn("text-sm font-bold uppercase tracking-wider px-3 py-1 rounded-full", phaseBadgeClass(phase))}>
              {phaseLabel}
            </div>
            {matchPaused && phase !== "idle" && phase !== "finished" && (
              <span className="text-yellow-400 text-xs font-bold animate-pulse">PAUSA</span>
            )}
          </div>

          <ScoreBox score={totals.blue} winner={winner} side="blue" isFinished={isFinished} />
        </div>

        {/* Bottom */}
        <div className="text-center text-sm text-gray-600">
          {isFinished && matchState?.result ? (
            <p className="text-2xl font-black text-white">{winnerLabel(state)}</p>
          ) : (
            <p>
              {state.penaltyCounts.warnings.red > 0 && `Avisos Rojo: ${state.penaltyCounts.warnings.red}  `}
              {state.penaltyCounts.warnings.blue > 0 && `Avisos Azul: ${state.penaltyCounts.warnings.blue}`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
