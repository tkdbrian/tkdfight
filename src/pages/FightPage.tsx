import * as React from "react";
import { useSocket } from "@/hooks/useSocket";
import { useTournamentStore } from "@/store/tournament";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  Trophy,
} from "lucide-react";
import {
  PHASE_LABELS,
  WIN_REASON_LABELS,
  formatTime,
  sumJudgeTotals,
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
              <Button variant="outline" className="w-full" onClick={onReset}>
                <RotateCcw className="size-4" />
                Reiniciar
              </Button>
            ) : (
              <Button className="w-full" onClick={onLoad} disabled={!connected}>
                Cargar combate
              </Button>
            )}
          </>
        )}
        <Separator />
        <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
          {fights.map((f, i) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onSelectIndex(i)}
              className={cn(
                "w-full text-left rounded px-2 py-1.5 text-xs transition-colors",
                i === currentIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-secondary text-muted-foreground",
                f.completed && "line-through opacity-50"
              )}
            >
              {i + 1}. {f.red.name} vs {f.blue.name}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
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
  onEmit,
  onFinishAndNext,
}: Readonly<MatchControlsProps>) {
  if (!loaded) return null;
  const isRunning = phase === "round" || phase === "overtime";
  const canStart = phase === "idle" || phase === "rest";
  const canPause = isRunning && !matchPaused;
  const canResume = isRunning && matchPaused;
  const canFinish =
    (isRunning || matchPaused) && (phase === "round" || phase === "overtime");

  if (isFinished && state.matchState?.result) {
    const { winner, reason } = state.matchState.result;
    return (
      <div className={cn("rounded-xl p-4 text-center space-y-1", resultBannerClass(winner))}>
        <div className="text-2xl font-black flex items-center justify-center gap-2">
          <Trophy className="size-6" />
          {winnerName(winner, state, fight)}
        </div>
        <p className="text-muted-foreground text-sm">
          {WIN_REASON_LABELS[reason] ?? reason}
        </p>
        <Button className="mt-2" onClick={onFinishAndNext}>
          {isLast ? "Finalizar torneo →" : "Siguiente combate →"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2 justify-center pt-1">
      {canStart && (
        <Button size="lg" className="bg-green-700 hover:bg-green-600" onClick={() => onEmit("match:start")}>
          <Play className="size-4" />
          {phase === "rest" ? "Iniciar ronda" : "Iniciar"}
        </Button>
      )}
      {canPause && (
        <Button size="lg" variant="outline" onClick={() => onEmit("match:pause")}>
          <Pause className="size-4" />
          Pausar
        </Button>
      )}
      {canResume && (
        <Button size="lg" className="bg-yellow-700 hover:bg-yellow-600" onClick={() => onEmit("match:resume")}>
          <Play className="size-4" />
          Reanudar
        </Button>
      )}
      {canFinish && (
        <Button size="lg" variant="secondary" onClick={() => onEmit("match:finishRound")}>
          <SkipForward className="size-4" />
          Terminar ronda
        </Button>
      )}
      {phase === "penalties" && (
        <Button size="lg" className="bg-orange-700 hover:bg-orange-600" onClick={() => onEmit("match:confirmPenalties")}>
          Confirmar penalizaciones
        </Button>
      )}
      <Button size="lg" variant="destructive" className="opacity-80 hover:opacity-100"
        onClick={() => onEmit("match:dq", { competitor: "red" })}>
        <UserX className="size-4" />
        DQ Rojo
      </Button>
      <Button size="lg" variant="destructive" className="opacity-80 hover:opacity-100"
        onClick={() => onEmit("match:dq", { competitor: "blue" })}>
        <UserX className="size-4" />
        DQ Azul
      </Button>
    </div>
  );
}

export function FightPage() {
  const { connected, state, emit } = useSocket();
  const { fights, currentFightIndex, setCurrentFightIndex, completeFight, setPhase, config } =
    useTournamentStore();

  const [loaded, setLoaded] = React.useState(false);
  const currentFight = fights[currentFightIndex];
  const { matchState, matchPaused, judges, penaltyCounts } = state;
  const phase = matchState?.phase ?? "idle";
  const isFinished = phase === "finished";
  const totals = sumJudgeTotals(state.judgeTotals);
  const timeLeft = matchState?.timeLeft ?? 0;
  const currentRound = matchState?.currentRound ?? 1;
  const isRunning = phase === "round" || phase === "overtime";

  React.useEffect(() => {
    setLoaded(false);
  }, [currentFightIndex]);

  function handleLoad() {
    if (!currentFight) return;
    const rules = (config.ruleSet as RuleSetSparring) ?? DEFAULT_RULES;
    emit("match:load", {
      rules,
      match: {
        id: currentFight.id,
        ringId: "ring-1",
        red: { id: currentFight.red.id, name: currentFight.red.name, club: currentFight.red.team },
        blue: { id: currentFight.blue.id, name: currentFight.blue.name, club: currentFight.blue.team },
      },
    });
    setLoaded(true);
  }

  function handleFinishAndNext() {
    if (!currentFight || !matchState?.result) return;
    completeFight(currentFight.id, matchState.result.winner, matchState.result.reason);
    const next = currentFightIndex + 1;
    if (next >= fights.length) {
      setPhase("results");
    } else {
      setCurrentFightIndex(next);
    }
    setLoaded(false);
  }

  if (fights.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>No hay combates. Configura el torneo primero.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Combate</h1>
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs px-3 py-1 rounded-full",
            connected ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
          )}
        >
          {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
          {connected ? `Servidor OK · ${judgesLabel(judges.length)}` : "Sin servidor"}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <FightPicker
          fights={fights}
          currentIndex={currentFightIndex}
          loaded={loaded}
          connected={connected}
          onPrev={() => setCurrentFightIndex(currentFightIndex - 1)}
          onNext={() => setCurrentFightIndex(currentFightIndex + 1)}
          onLoad={handleLoad}
          onReset={() => { emit("match:reset"); setLoaded(false); }}
          onSelectIndex={setCurrentFightIndex}
        />

        <Card className="lg:col-span-2">
          <CardContent className="p-4 space-y-4">
            <div className="flex items-center justify-center gap-3">
              <Badge className={cn(
                "text-sm px-3 py-1",
                phase === "round" && "bg-green-600",
                phase === "rest" && "bg-yellow-600",
                phase === "overtime" && "bg-orange-600",
                phase === "golden_point" && "bg-purple-600",
                phase === "finished" && "bg-blue-700",
                phase === "penalties" && "bg-red-800",
                phase === "idle" && "bg-secondary"
              )}>
                {PHASE_LABELS[phase]}
                {(phase === "round" || phase === "rest") && ` · R${currentRound}`}
              </Badge>
              {matchPaused && phase !== "idle" && phase !== "finished" && (
                <Badge variant="outline" className="text-yellow-400 border-yellow-600">PAUSA</Badge>
              )}
            </div>

            <div className={cn(
              "text-center font-mono font-black leading-none",
              timeLeft <= 10 && isRunning && !matchPaused ? "text-red-400 text-8xl" : "text-7xl"
            )}>
              {formatTime(timeLeft)}
            </div>

            <div className="grid grid-cols-3 items-center gap-4">
              <div className="text-center">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                  {state.match?.red.name ?? currentFight?.red.name ?? "Rojo"}
                </p>
                <div className="text-7xl font-black leading-none rounded-xl py-4 bg-red-950/40 text-red-400">
                  {totals.red}
                </div>
                {penaltyCounts.fouls.red > 0 && (
                  <p className="text-xs text-red-600 mt-1">Faltas: {penaltyCounts.fouls.red}</p>
                )}
                {penaltyCounts.warnings.red > 0 && (
                  <p className="text-xs text-yellow-600 mt-0.5">Avisos: {penaltyCounts.warnings.red}</p>
                )}
              </div>
              <div className="text-center text-2xl font-black text-muted-foreground">vs</div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
                  {state.match?.blue.name ?? currentFight?.blue.name ?? "Azul"}
                </p>
                <div className="text-7xl font-black leading-none rounded-xl py-4 bg-blue-950/40 text-blue-400">
                  {totals.blue}
                </div>
                {penaltyCounts.fouls.blue > 0 && (
                  <p className="text-xs text-red-600 mt-1">Faltas: {penaltyCounts.fouls.blue}</p>
                )}
                {penaltyCounts.warnings.blue > 0 && (
                  <p className="text-xs text-yellow-600 mt-0.5">Avisos: {penaltyCounts.warnings.blue}</p>
                )}
              </div>
            </div>

            <MatchControls
              loaded={loaded}
              isFinished={isFinished}
              phase={phase}
              matchPaused={matchPaused}
              fight={currentFight}
              isLast={currentFightIndex === fights.length - 1}
              state={state}
              onEmit={emit}
              onFinishAndNext={handleFinishAndNext}
            />

            {loaded && judges.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground mb-2">Jueces conectados</p>
                <div className="flex flex-wrap gap-2">
                  {judges.map((j) => (
                    <span key={j} className="text-xs px-2.5 py-1 rounded-full bg-secondary text-secondary-foreground">{j}</span>
                  ))}
                </div>
              </div>
            )}

            {loaded && Object.keys(state.judgeTotals).length > 0 && (
              <div className="border-t border-border pt-3 space-y-1">
                <p className="text-xs text-muted-foreground mb-2">Puntos por juez</p>
                {Object.entries(state.judgeTotals).map(([jid, t]) => (
                  <div key={jid} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="w-8 font-mono">{jid}</span>
                    <span className="text-red-400 font-bold">{t.red}</span>
                    <span className="flex-1 text-center">—</span>
                    <span className="text-blue-400 font-bold">{t.blue}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
