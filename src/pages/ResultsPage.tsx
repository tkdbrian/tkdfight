import { CategoryPrintAction } from "@/components/CategoryPrintAction";
import { useEffect, useMemo, useRef, useState } from "react";
import { POINTS_WIN, POINTS_DRAW } from "@/rules/round-robin";
import { useTournamentStore, type FightEntry } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Trophy, RotateCcw, Download, Crown } from "lucide-react";
import { cn } from "@/lib/utils";
import { WIN_REASON_LABELS } from "@/lib/fight-utils";
import { roundRobinOutcome } from "@/lib/round-robin-resolution";
import { resolveEliminationOutcome } from "@/lib/category-lifecycle";
import { exportTournamentHTML } from "@/lib/export";
import { BracketView } from "@/components/BracketView";
import { useSocket } from "@/hooks/useSocket";
import { toast } from "sonner";

interface Standing {
  competitor: { id: string; name: string; team?: string };
  wins: number;
  losses: number;
  draws: number;
  fought: number;
  points: number;
  flagsFor: number;
  foulsAgainst: number;
  warnings: number;
}

type F = ReturnType<typeof useTournamentStore.getState>["fights"][number];

/**
 * Standings sobre un subset de combates.
 * `eliminationMode` (Fase Final): los desempates/punto de oro no cuentan como
 * "jugado" y, si la pelea regular terminó en empate, se reescribe como victoria
 * del ganador del desempate (resultado visible 3-0).
 */
function computeStandingsForFights(
  fights: F[],
  opts: { eliminationMode?: boolean } = {}
): Standing[] {
  const map = new Map<string, Standing>();
  const countedTbSeqs = new Set<string>();

  let overrideWinnerId: string | null = null;
  if (opts.eliminationMode) {
    const final = fights.filter((f) => f.isFinalFight && !f.isTiebreakExtra && !f.isGoldenPointFight);
    const directFinal = final.length === 1 ? final[0] : null;
    const sameFinalPair = (f: F): boolean => !!directFinal &&
      [f.red.id, f.blue.id].sort().join("|") === [directFinal.red.id, directFinal.blue.id].sort().join("|");
    const decisive = [...fights]
      .reverse()
      .find(
        (f) =>
          f.completed &&
          f.winner !== "draw" &&
          (f.isTiebreakExtra || f.isGoldenPointFight) &&
          (!directFinal || sameFinalPair(f)),
      );
    if (decisive && (!directFinal || directFinal.winner === "draw")) {
      overrideWinnerId =
        decisive.winner === "red" ? decisive.red.id : decisive.blue.id;
    }
  }

  for (const f of fights) {
    if (f.groupId?.startsWith("EXT:")) continue;
    for (const side of ["red", "blue"] as const) {
      const c = f[side];
      if (!map.has(c.id)) {
        map.set(c.id, {
          competitor: c, wins: 0, losses: 0, draws: 0, fought: 0, points: 0,
          flagsFor: 0, foulsAgainst: 0, warnings: 0,
        });
      }
    }
    if (!f.completed) continue;
    const redStanding = map.get(f.red.id);
    const blueStanding = map.get(f.blue.id);
    if (!redStanding || !blueStanding) continue;

    if (f.isTiebreakExtra || f.isGoldenPointFight) {
      if (opts.eliminationMode) continue;
      const seqKey = `${f.groupId ?? ""}|${[f.red.id, f.blue.id].sort().join("|")}`;
      if (!countedTbSeqs.has(seqKey)) {
        countedTbSeqs.add(seqKey);
        redStanding.fought++;
        blueStanding.fought++;
      }
      continue;
    }

    redStanding.fought++;
    blueStanding.fought++;
    redStanding.flagsFor += f.flagsRed ?? 0;
    blueStanding.flagsFor += f.flagsBlue ?? 0;
    redStanding.foulsAgainst += f.foulsRed ?? 0;
    blueStanding.foulsAgainst += f.foulsBlue ?? 0;
    redStanding.warnings += f.warningsRed ?? 0;
    blueStanding.warnings += f.warningsBlue ?? 0;

    let effectiveWinner: F["winner"] = f.winner;
    if (
      overrideWinnerId &&
      f.winner === "draw" &&
      (f.red.id === overrideWinnerId || f.blue.id === overrideWinnerId)
    ) {
      effectiveWinner = f.red.id === overrideWinnerId ? "red" : "blue";
    }

    if (effectiveWinner === "red") {
      redStanding.wins++;
      redStanding.points += POINTS_WIN;
      blueStanding.losses++;
    } else if (effectiveWinner === "blue") {
      blueStanding.wins++;
      blueStanding.points += POINTS_WIN;
      redStanding.losses++;
    } else {
      redStanding.draws++;
      redStanding.points += POINTS_DRAW;
      blueStanding.draws++;
      blueStanding.points += POINTS_DRAW;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.flagsFor !== a.flagsFor) return b.flagsFor - a.flagsFor;
    if (a.foulsAgainst !== b.foulsAgainst) return a.foulsAgainst - b.foulsAgainst;
    return a.warnings - b.warnings;
  });
}

function computeStandings(fights: F[]): Standing[] {
  return computeStandingsForFights(fights);
}

/** Agrupa standings por groupId. Devuelve mapa ordenado con grupos regulares antes de FINAL. */
function computeStandingsByGroup(fights: F[]): Map<string, Standing[]> {
  const groups = new Map<string, F[]>();
  for (const f of fights) {
    if (f.groupId?.startsWith("EXT:")) continue;
    const gid = f.groupId ?? "G1";
    let arr = groups.get(gid);
    if (!arr) { arr = []; groups.set(gid, arr); }
    arr.push(f);
  }
  const sortedIds = [...groups.keys()].sort((a, b) => {
    const aFinal = a === "FINAL" || a === "FINAL_AB";
    const bFinal = b === "FINAL" || b === "FINAL_AB";
    if (aFinal !== bFinal) return aFinal ? 1 : -1;
    return a.localeCompare(b, "en");
  });
  const out = new Map<string, Standing[]>();
  for (const gid of sortedIds) {
    const eliminationMode = gid === "FINAL" || gid === "FINAL_AB";
    out.set(gid, computeStandingsForFights(groups.get(gid) ?? [], { eliminationMode }));
  }
  return out;
}

function groupLabel(gid: string): string {
  if (gid === "FINAL" || gid === "FINAL_AB") return "🏆 Fase Final";
  const m = /^G(\d+)$/.exec(gid);
  if (m) return `Grupo ${m[1]}`;
  return gid;
}

/**
 * Builds the podium order semantically:
 *  - If there are completed FINAL-group fights: champion = winner of the decisive fight,
 *    runner-up = loser, rest ordered by aggregate standings.
 *  - Otherwise falls back to aggregate standings (single-group case).
 */
function computePodium(
  fights: ReturnType<typeof useTournamentStore.getState>["fights"],
  fallbackStandings: Standing[],
  roundRobinChampionId?: string | null,
  roundRobinRunnerUpId?: string | null,
): Standing[] {
  if (roundRobinChampionId !== undefined) {
    if (!roundRobinChampionId) return fallbackStandings;
    const champion = fallbackStandings.find((s) => s.competitor.id === roundRobinChampionId);
    if (!champion) return fallbackStandings;
    const runnerUp = fallbackStandings.find((s) => s.competitor.id === roundRobinRunnerUpId);
    return [champion, ...(runnerUp ? [runnerUp] : []), ...fallbackStandings.filter((s) =>
      s.competitor.id !== roundRobinChampionId && s.competitor.id !== roundRobinRunnerUpId)];
  }
  const finalDone = fights.filter(f => f.groupId === "FINAL" && f.completed);
  if (finalDone.length === 0) return fallbackStandings;

  // Collect all competitors who appeared in the Final group
  const finalCompIds = new Set<string>();
  for (const f of finalDone) {
    finalCompIds.add(f.red.id);
    finalCompIds.add(f.blue.id);
  }

  // Decisive fight = last completed non-draw in FINAL group (accounts for tiebreaks and GP)
  const decisive = [...finalDone].reverse().find(f => f.winner !== "draw");
  if (!decisive) return fallbackStandings;

  const champId = decisive.winner === "red" ? decisive.red.id : decisive.blue.id;

  // Re-order fallbackStandings: champion first among final comps, rest unchanged
  const finalComps = fallbackStandings.filter(s => finalCompIds.has(s.competitor.id));
  const champIdx = finalComps.findIndex(s => s.competitor.id === champId);
  if (champIdx > 0) {
    const [champ] = finalComps.splice(champIdx, 1);
    finalComps.unshift(champ);
  }

  const rest = fallbackStandings.filter(s => !finalCompIds.has(s.competitor.id));
  return [...finalComps, ...rest];
}

function getFightPhaseLabel(f: ReturnType<typeof useTournamentStore.getState>["fights"][number]): { text: string; cls: string } {
  if (f.isFinalFight) {
    return { text: "Fase Final", cls: "text-amber-400 font-semibold" };
  }
  if (f.isTiebreakExtra) {
    const group = f.groupId ? f.groupId.replace(/^G(\d+)$/, "Grupo $1") : "";
    return { text: group ? `Desempate · ${group}` : "Desempate", cls: "text-purple-400" };
  }
  if (f.bracketRound !== undefined) {
    return { text: `Llave · R${f.bracketRound + 1}`, cls: "text-blue-400" };
  }
  if (f.groupId && f.groupId !== "FINAL" && f.groupId !== "FINAL_AB") {
    return { text: f.groupId.replace(/^G(\d+)$/, "Grupo $1"), cls: "text-muted-foreground" };
  }
  return { text: "Round Robin", cls: "text-muted-foreground" };
}

export function ResultsPage() {
  const { connected, stateReady, state: serverState, request } = useSocket();
  const requestRef = useRef(request);
  requestRef.current = request;
  const { fights, competitors, groups, config, reset, bracketMatches } = useTournamentStore(
    useShallow((s) => ({
      fights: s.fights, competitors: s.competitors, groups: s.groups,
      config: s.config, reset: s.reset, bracketMatches: s.bracketMatches,
    }))
  );
  const isTul = config.matchType === 'tul';
  const isElimination = config.mode === "elimination";
  const isDoubleBracket = bracketMatches.some((match) => match.bracketGroup === "B");

  // Merge Golden Point sequences: hide GP fights, patch original with GP winner
  const displayFights = useMemo(() => {
    type F = typeof fights[number];
    const pairKey = (f: F) => `${f.groupId ?? ""}|${[f.red.id, f.blue.id].sort().join("|")}`;

    // gpById: GP fight keyed by its bracketMatchId (= parent fight id) — works for new data
    // gpByPair: GP fight keyed by competitor pair — fallback for old data without bracketMatchId
    const gpById = new Map<string, F>();
    const gpByPair = new Map<string, F>();
    for (const f of fights) {
      if (!f.isGoldenPointFight) continue;
      const decisive = f.completed && f.winner !== "draw";
      if (f.bracketMatchId) {
        const prev = gpById.get(f.bracketMatchId);
        if (!prev || decisive) gpById.set(f.bracketMatchId, f);
      }
      if (!f.bracketMatchId) {
        const pk = pairKey(f);
        const prev = gpByPair.get(pk);
        if (!prev || decisive) gpByPair.set(pk, f);
      }
    }

    return fights
      .filter((f) => !f.isGoldenPointFight)
      .map((f) => {
        const linked = gpById.get(f.id);
        const linkedGp = linked && pairKey(linked) === pairKey(f) ? linked : null;
        // Ordinary RR matches are allowed to draw. Only a FINAL or playoff
        // can inherit a later golden-point winner.
        if (!f.isTiebreakExtra) {
          if (!f.isFinalFight && !f.bracketMatchId) return f;
          const bracketGp = f.bracketMatchId ? gpById.get(f.bracketMatchId) : null;
          const gp = linkedGp ?? (bracketGp && pairKey(bracketGp) === pairKey(f) ? bracketGp : null);
          if (!gp?.completed || gp.winner === "draw") return f;
          return { ...f, winner: gp.winner, winReason: "golden_point", completed: gp.completed } as F;
        }
        // Tiebreak group fight: try bracketMatchId chain first (new data), then pair fallback
        const gp = linkedGp ?? gpByPair.get(pairKey(f));
        if (!gp?.completed || gp.winner === "draw") return f;
        return { ...f, winner: gp.winner, winReason: "golden_point", completed: gp.completed } as F;
      });
  }, [fights]);

  const standings = computeStandings(fights);
  const standingsByGroup = useMemo(() => computeStandingsByGroup(fights), [fights]);
  const groupedView = standingsByGroup.size >= 2;
  const roundRobinResult = isElimination ? null : roundRobinOutcome(fights, groups);
  const eliminationOutcome = isElimination ? resolveEliminationOutcome({
    phase: "results", config, competitors, fights, groups, bracketMatches,
    bracketSeeds: [], currentFightIndex: 0, setupStarted: true,
  }) : null;
  const podium = eliminationOutcome?.status === "resolved"
    ? computePodium([], standings, eliminationOutcome.championId,
      eliminationOutcome.runnerUpId)
    : computePodium(fights, standings, roundRobinResult?.championId,
      roundRobinResult?.runnerUpId);
  const completed = fights.filter((f) => f.completed).length;
  const total = fights.length;
  const confirmationKey = JSON.stringify([config.id,
    bracketMatches.map((match) => [match.id, match.completed, match.winnerId]),
    eliminationOutcome?.requiredResultIds, fights.map((fight) => [
    fight.id, fight.completed, fight.winner, fight.flagsRed, fight.flagsBlue,
    fight.foulsRed, fight.foulsBlue, fight.warningsRed, fight.warningsBlue,
  ])]);
  const [verified, setVerified] = useState<string | null>(null);
  useEffect(() => {
    if ((!isElimination && !roundRobinResult?.championId) ||
      (isElimination && eliminationOutcome?.status !== "resolved") ||
      !connected || !stateReady) return;
    let cancelled = false;
    const dependencies = isElimination
      ? fights.filter((fight) => eliminationOutcome?.requiredResultIds.includes(fight.id))
      : fights.filter((fight) => !fight.groupId?.startsWith("EXT:"));
    void Promise.all(dependencies.map((fight) => requestRef.current<{
      ok: boolean;
      result: {
        fightId: string;
        categoryId: string;
        status: string;
        winner: FightEntry["winner"];
        flagsRed: number;
        flagsBlue: number;
        foulsRed: number;
        foulsBlue: number;
        warningsRed: number;
        warningsBlue: number;
      } | null;
    }>("match:result:get", { categoryId: config.id, matchId: fight.id }).then((response) => {
      const result = response?.result;
      const fields = ["flagsRed", "flagsBlue", "foulsRed", "foulsBlue", "warningsRed", "warningsBlue"] as const;
      return Boolean(response?.ok && result?.status === "confirmed" &&
        result.fightId === fight.id && result.categoryId === config.id &&
        fight.completed && result.winner === fight.winner && fields.every((field) =>
          isElimination ? fight[field] === undefined || fight[field] === result[field]
            : Number.isInteger(fight[field]) && Number.isInteger(result[field]) &&
              fight[field] === result[field]));
    }))).then((checks) => {
      if (!cancelled) setVerified(checks.length > 0 && checks.every(Boolean) ? confirmationKey : null);
    }).catch(() => {
      if (!cancelled) setVerified(null);
    });
    return () => { cancelled = true; };
  }, [confirmationKey, config.id, connected, stateReady, isElimination,
    roundRobinResult?.championId, eliminationOutcome?.status, fights]);
  const officialRoundRobinResult = !isElimination && roundRobinResult?.championId &&
    connected && stateReady && verified === confirmationKey;
  const officialEliminationResult = isElimination && eliminationOutcome?.status === "resolved" &&
    connected && stateReady && verified === confirmationKey;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="size-6 text-yellow-400" />
            Resultados
          </h1>
          {config.categoryName && (
            <p className="text-muted-foreground text-sm mt-0.5">{config.categoryName}</p>
          )}
          {eliminationOutcome?.status === "review" && (
            <p role="status" className="text-amber-400 text-xs mt-1">
              Pendiente de revisión: el historial de la llave o del desempate es ambiguo.
            </p>
          )}
          {!(isElimination ? officialEliminationResult : officialRoundRobinResult) && (
            <p className="text-amber-400 text-xs mt-1">Clasificación provisional: faltan combates, un desempate o verificar los resultados en el servidor.</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">
            {completed} / {total} combates
          </span>
          <CategoryPrintAction connected={connected} stateReady={stateReady} request={request} tatami={serverState.ringAlias} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportTournamentHTML(fights, competitors, config, bracketMatches,
              groups, officialEliminationResult ? eliminationOutcome?.requiredResultIds : [])}
            disabled={completed === 0 || !(isElimination
              ? officialEliminationResult : officialRoundRobinResult)}
          >
            <Download className="size-3.5" />
            Exportar HTML
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!connected || !stateReady || serverState.activeMatchLock?.categoryId === config.id
                || (serverState.match && !serverState.resultConfirmed && serverState.categoryId === config.id)) {
                toast.warning("No se puede borrar esta categoría sin confirmar que el combate terminó.");
                return;
              }
              reset();
            }}
            className="text-destructive border-destructive/50 hover:bg-destructive/10"
          >
            <RotateCcw className="size-4" />
            Nueva categoría
          </Button>
        </div>
      </div>

      {/* Podio */}
      {podium.length >= 1 && completed > 0 && (isElimination
        ? officialEliminationResult : officialRoundRobinResult) && (
        <div className="grid grid-cols-3 gap-3 items-end">
          {podium[1] ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-secondary/20 p-4 mt-4">
              <div className="text-4xl">🥈</div>
              <p className="font-bold text-sm text-center text-gray-300 truncate max-w-full">{podium[1].competitor.name}</p>
              {podium[1].competitor.team && (
                <p className="text-xs text-muted-foreground text-center truncate w-full">{podium[1].competitor.team}</p>
              )}
              {!isTul && !isElimination && <Badge variant="secondary">{podium[1].points} pts</Badge>}
            </div>
          ) : <div />}
          <div className="flex flex-col items-center gap-2 rounded-xl border border-yellow-700/40 bg-yellow-950/20 p-5">
            <div className="text-5xl">🥇</div>
            <p className="font-bold text-base text-center text-yellow-300 truncate max-w-full">{podium[0].competitor.name}</p>
            {podium[0].competitor.team && (
              <p className="text-xs text-yellow-600 text-center truncate w-full">{podium[0].competitor.team}</p>
            )}
            {!isTul && !isElimination && <Badge className="bg-yellow-600 text-yellow-950 border-0 hover:bg-yellow-600">{podium[0].points} pts</Badge>}
          </div>
          {isTul ? <div /> : podium[2] ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-secondary/20 p-4 mt-4">
              <div className="text-4xl">🥉</div>
              <p className="font-bold text-sm text-center text-amber-600 truncate max-w-full">{podium[2].competitor.name}</p>
              {podium[2].competitor.team && (
                <p className="text-xs text-muted-foreground text-center truncate w-full">{podium[2].competitor.team}</p>
              )}
              {!isTul && !isElimination && <Badge variant="secondary">{podium[2].points} pts</Badge>}
            </div>
          ) : <div />}
        </div>
      )}

      {isElimination && bracketMatches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Llave completa</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 overflow-hidden">
            {isDoubleBracket ? (
              <>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground">Grilla A</h3>
                  <BracketView matches={bracketMatches.filter((match) => match.bracketGroup !== "B")} competitors={competitors} />
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground">Grilla B</h3>
                  <BracketView matches={bracketMatches.filter((match) => match.bracketGroup === "B")} competitors={competitors} />
                </section>
              </>
            ) : (
              <BracketView matches={bracketMatches} competitors={competitors} />
            )}
          </CardContent>
        </Card>
      )}

      {/* Standings */}
      {groupedView ? (
        <div className="space-y-4">
          {[...standingsByGroup.entries()].map(([gid, gStandings]) => (
            <StandingsCard
              key={gid}
              title={groupLabel(gid)}
              standings={gStandings}
              isTul={isTul}
              hidePoints={isElimination}
            />
          ))}
        </div>
      ) : (
        <StandingsCard title="Clasificación" standings={standings} isTul={isTul} hidePoints={isElimination} />
      )}

      {/* Fight log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Combates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {displayFights.map((f, i) => {
              const winnerName =
                f.winner === "red"
                  ? f.red.name
                  : f.winner === "blue"
                  ? f.blue.name
                  : null;
              const reasonLabel =
                f.winner === "draw"
                  ? "Empate"
                  : WIN_REASON_LABELS[f.winReason ?? ""] ?? f.winReason ?? "Puntos";
              const isGoldenPoint = f.winReason === "golden_point";
              const isDraw = f.winner === "draw";
              const hasFlags =
                (f.flagsRed ?? 0) > 0 || (f.flagsBlue ?? 0) > 0;
              const phaseLabel = getFightPhaseLabel(f);

              return (
                <div
                  key={f.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border border-border px-4 py-3 text-sm",
                    f.completed ? "opacity-100" : "opacity-40"
                  )}
                >
                  {/* Número */}
                  <span className="text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>

                  {/* Rojo */}
                  <div className="flex items-center gap-1.5 flex-1">
                    {f.winner === "red" && <Crown className="size-3.5 text-yellow-400 shrink-0" />}
                    <span
                      className={cn(
                        "font-medium",
                        f.winner === "red" && "text-red-400 font-bold"
                      )}
                    >
                      {f.red.name}
                    </span>
                  </div>

                  {/* Centro */}
                  <div className="flex flex-col items-center gap-0.5 min-w-24 shrink-0">
                    {f.completed ? (
                      <>
                        {hasFlags && (
                          <span className="flex items-center gap-1 text-xs font-bold tabular-nums">
                            <span className="text-red-400">{f.flagsRed ?? 0}</span>
                            <span className="text-muted-foreground">—</span>
                            <span className="text-blue-400">{f.flagsBlue ?? 0}</span>
                            <span className="text-[10px] text-muted-foreground font-normal">jueces</span>
                          </span>
                        )}
                        <Badge
                          className={cn(
                            "text-sm px-3 py-0.5",
                            isDraw
                              ? "bg-secondary text-secondary-foreground"
                              : isGoldenPoint
                              ? "bg-yellow-500/20 text-yellow-300 border border-yellow-500/50"
                              : "bg-primary/20 text-primary border-primary/30"
                          )}
                        >
                          {winnerName ? `${winnerName} ganó` : "Empate"}
                        </Badge>
                        <span className={cn(
                          "text-xs font-semibold mt-0.5",
                          isGoldenPoint ? "text-yellow-400" : "text-muted-foreground font-normal text-[10px]"
                        )}>
                          {isGoldenPoint ? "⭐ Punto de Oro" : reasonLabel}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground text-xs">pendiente</span>
                    )}
                  </div>

                  {/* Azul */}
                  <div className="flex items-center justify-end gap-1.5 flex-1">
                    <span
                      className={cn(
                        "font-medium text-right",
                        f.winner === "blue" && "text-blue-400 font-bold"
                      )}
                    >
                      {f.blue.name}
                    </span>
                    {f.winner === "blue" && <Crown className="size-3.5 text-yellow-400 shrink-0" />}
                  </div>

                  {/* Instancia / fase */}
                  <span className={cn("text-[10px] w-20 text-right shrink-0", phaseLabel.cls)}>
                    {phaseLabel.text}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Competitors list */}
      {competitors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Participantes ({competitors.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {competitors.map((c) => (
                <span
                  key={c.id}
                  className="text-xs px-3 py-1.5 rounded-full bg-secondary text-secondary-foreground"
                >
                  {c.name}
                  {c.team && <span className="text-muted-foreground"> · {c.team}</span>}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StandingsCard({
  title,
  standings,
  isTul,
  hidePoints,
}: Readonly<{ title: string; standings: Standing[]; isTul: boolean; hidePoints: boolean }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Competidor</TableHead>
                {!isTul && !hidePoints && <TableHead className="text-center font-bold text-yellow-400">Puntos</TableHead>}
                {!isTul && !hidePoints && <TableHead className="text-center">Banderines</TableHead>}
                {!isTul && !hidePoints && <TableHead className="text-center">Pt. contra</TableHead>}
                {!isTul && !hidePoints && <TableHead className="text-center">Advertencias</TableHead>}
                {!isTul && <TableHead className="text-center">Ganados</TableHead>}
                {!isTul && <TableHead className="text-center hidden sm:table-cell">Empates</TableHead>}
                {!isTul && <TableHead className="text-center">Perdidos</TableHead>}
                {!isTul && <TableHead className="text-center hidden sm:table-cell">Jugados</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {standings.map((s, i) => (
                <TableRow key={s.competitor.id}>
                  <TableCell>
                    <span
                      className={cn(
                        "font-bold",
                        i === 0 && "text-yellow-400",
                        i === 1 && "text-gray-300",
                        i === 2 && !isTul && "text-amber-600"
                      )}
                    >
                      {i + 1}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="font-medium">{s.competitor.name}</p>
                      {s.competitor.team && (
                        <p className="text-xs text-muted-foreground">{s.competitor.team}</p>
                      )}
                    </div>
                  </TableCell>
                  {!isTul && !hidePoints && <TableCell className="text-center font-black text-yellow-400 text-base">{s.points}</TableCell>}
                  {!isTul && !hidePoints && <TableCell className="text-center">{s.flagsFor}</TableCell>}
                  {!isTul && !hidePoints && <TableCell className="text-center">{s.foulsAgainst}</TableCell>}
                  {!isTul && !hidePoints && <TableCell className="text-center">{s.warnings}</TableCell>}
                  {!isTul && <TableCell className="text-center text-green-400 font-bold">{s.wins}</TableCell>}
                  {!isTul && <TableCell className="text-center text-muted-foreground hidden sm:table-cell">{s.draws}</TableCell>}
                  {!isTul && <TableCell className="text-center text-red-400 font-bold">{s.losses}</TableCell>}
                  {!isTul && <TableCell className="text-center text-muted-foreground hidden sm:table-cell">{s.fought}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
