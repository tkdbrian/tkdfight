import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useTournamentStore } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { generateEliminationBracket, generateDoubleBracket, getActiveBracketFights } from "@/lib/bracket";
import { BracketView } from "@/components/BracketView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, Play, RefreshCw, Swords } from "lucide-react";
import { cn } from "@/lib/utils";

const DOUBLE_BRACKET_THRESHOLD = 16;

function roundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - 1 - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Cuartos";
  return `R${round + 1}`;
}

export function BracketPage() {
  const {
    competitors,
    bracketMatches,
    bracketSeeds,
    fights,
    setBracket,
    setFights,
    setCurrentFightIndex,
    appendFightAndSelect,
    setPhase,
    swapBracketSlots,
    addFinalFights,
    config,
    phase,
  } = useTournamentStore(
    useShallow((s) => ({
      competitors: s.competitors,
      bracketMatches: s.bracketMatches,
      bracketSeeds: s.bracketSeeds,
      fights: s.fights,
      setBracket: s.setBracket,
      setFights: s.setFights,
      setCurrentFightIndex: s.setCurrentFightIndex,
      appendFightAndSelect: s.appendFightAndSelect,
      setPhase: s.setPhase,
      swapBracketSlots: s.swapBracketSlots,
      addFinalFights: s.addFinalFights,
      config: s.config,
      phase: s.phase,
    }))
  );

  const [selectedMatchId, setSelectedMatchId] = React.useState<string | null>(null);
  const navigate = useNavigate();

  const isElimination = config.mode === "elimination";
  const isDouble = competitors.length > DOUBLE_BRACKET_THRESHOLD;

  // Split matches by bracket group
  const matchesA = bracketMatches.filter((m) => m.bracketGroup !== "B");
  const matchesB = bracketMatches.filter((m) => m.bracketGroup === "B");
  const isDoubleMode = matchesB.length > 0;

  function handleGenerateBracket() {
    if (isDouble) {
      const { matches, seeds } = generateDoubleBracket(competitors);
      setBracket(matches, seeds);
    } else {
      const { matches, seeds } = generateEliminationBracket(competitors);
      setBracket(matches, seeds);
    }
    setFights([]);
    setSelectedMatchId(null);
  }

  function handleStartBracket() {
    // In double mode, start both grillas together
    const activeFights = getActiveBracketFights(bracketMatches, fights);
    if (activeFights.length === 0) return;
    const allFights = [...fights, ...activeFights];
    setFights(allFights);
    setCurrentFightIndex(fights.length);
    setPhase("fighting");
    navigate("/fight");
  }

  function handleLoadNextRound() {
    const newFights = getActiveBracketFights(bracketMatches, fights);
    if (newFights.length === 0) return;
    setFights([...fights, ...newFights]);
  }

  // Start (or navigate to) a specific bracket match fight
  function handleStartMatchFight(matchId: string) {
    const match = bracketMatches.find((m) => m.id === matchId);
    if (!match || !match.red.competitor || !match.blue.competitor || match.completed) return;

    // Already has a FightEntry? Just navigate to it.
    const existingIdx = fights.findIndex((f) => f.bracketMatchId === matchId);
    if (existingIdx >= 0) {
      setCurrentFightIndex(existingIdx);
      setPhase("fighting");
      navigate("/fight");
      return;
    }

    // Create a new FightEntry for this specific match (atomic: appends + selects in one set()).
    appendFightAndSelect({
      id: crypto.randomUUID(),
      red: match.red.competitor,
      blue: match.blue.competitor,
      completed: false,
      bracketRound: match.round,
      bracketPosition: match.position,
      bracketMatchId: match.id,
    });
    setPhase("fighting");
    navigate("/fight");
  }

  // ── Double bracket: final A vs B ──────────────────────────────────────────
  const isAComplete = isDoubleMode && matchesA.length > 0 && matchesA.every((m) => m.completed);
  const isBComplete = isDoubleMode && matchesB.length > 0 && matchesB.every((m) => m.completed);
  const abFinalFight = fights.find((f) => f.isFinalFight && f.groupId === "FINAL_AB");

  const winnerAId = isAComplete ? matchesA.at(-1)?.winnerId : undefined;
  const winnerBId = isBComplete ? matchesB.at(-1)?.winnerId : undefined;
  const winnerA = winnerAId ? competitors.find((c) => c.id === winnerAId) : undefined;
  const winnerB = winnerBId ? competitors.find((c) => c.id === winnerBId) : undefined;

  function handleStartFinalAB() {
    if (!winnerA || !winnerB) return;
    const finalFight = {
      id: crypto.randomUUID(),
      red: winnerA,
      blue: winnerB,
      completed: false,
      groupId: "FINAL_AB",
      isFinalFight: true,
    };
    addFinalFights([finalFight]);
    setCurrentFightIndex(fights.length);
    setPhase("fighting");
    navigate("/fight");
  }

  // ── Single bracket stats ──────────────────────────────────────────────────
  const totalRounds = bracketMatches.length > 0
    ? (Math.max(...bracketMatches.map((m) => m.round)) + 1)
    : 0;
  const completedMatches = bracketMatches.filter((m) => m.completed).length;
  const totalMatches = bracketMatches.length;

  // Champion resolution
  let championName: string | undefined;
  let runnerUpName: string | undefined;
  if (isDoubleMode) {
    if (abFinalFight?.completed && abFinalFight.winner) {
      const winnerId = abFinalFight.winner === "red" ? abFinalFight.red.id : abFinalFight.blue.id;
      const loserId = abFinalFight.winner === "red" ? abFinalFight.blue.id : abFinalFight.red.id;
      championName = competitors.find((c) => c.id === winnerId)?.name;
      runnerUpName = competitors.find((c) => c.id === loserId)?.name;
    }
  } else {
    const isBracketComplete = totalMatches > 0 && completedMatches === totalMatches;
    if (isBracketComplete) {
      const finalMatch = bracketMatches.at(-1);
      const winnerId = finalMatch?.winnerId;
      championName = winnerId ? competitors.find((c) => c.id === winnerId)?.name : undefined;
      if (finalMatch && winnerId) {
        const loserComp = finalMatch.red.competitor?.id === winnerId
          ? finalMatch.blue.competitor
          : finalMatch.red.competitor;
        runnerUpName = loserComp?.name;
      }
    }
  }

  const selectedMatch = bracketMatches.find((m) => m.id === selectedMatchId);

  if (!isElimination) {
    return (
      <div className="flex-1 p-4 flex items-center justify-center text-muted-foreground">
        <p>El bracket de eliminación solo está disponible en modo "Eliminación".</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">Bracket de Eliminación</h1>
          {config.categoryName && (
            <p className="text-sm text-muted-foreground">{config.categoryName}</p>
          )}
          {config.tableChief && (
            <p className="text-xs text-muted-foreground">Jefe de mesa: <span className="font-medium text-foreground">{config.tableChief}</span></p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          {bracketMatches.length === 0 ? (
            <Button onClick={handleGenerateBracket} disabled={competitors.length < 2}>
              {isDouble ? "Generar Grilla A + B" : "Generar bracket"}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleGenerateBracket}>
                <RefreshCw className="size-3.5" />
                Regenerar
              </Button>

              {(fights.length === 0 || phase !== "fighting") && completedMatches < totalMatches && (
                <Button size="sm" onClick={handleStartBracket}>
                  <Play className="size-3.5" />
                  Iniciar ronda actual
                </Button>
              )}
              {phase === "results" && completedMatches < totalMatches && (!isDoubleMode || (!isAComplete && !isBComplete)) && (
                <Button size="sm" variant="secondary" onClick={handleLoadNextRound}>
                  Cargar siguiente ronda
                </Button>
              )}
              {isDoubleMode && isAComplete && isBComplete && !abFinalFight && winnerA && winnerB && (
                <Button size="sm" onClick={handleStartFinalAB} className="bg-yellow-700 hover:bg-yellow-600 text-white">
                  <Swords className="size-3.5" />
                  Final: {winnerA.name} vs {winnerB.name}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Champion banner */}
      {championName && (
        <div className="rounded-xl bg-gradient-to-r from-yellow-950/40 via-yellow-900/20 to-slate-900/40 border border-yellow-700/40 p-4 flex items-center gap-4 flex-wrap">
          {/* Oro */}
          <div className="flex items-center gap-3 flex-1 min-w-[200px]">
            <div className="relative shrink-0">
              <Trophy className="size-10 text-yellow-400 drop-shadow-[0_0_8px_rgba(250,204,21,0.5)]" />
              <span className="absolute -bottom-1 -right-1 bg-yellow-500 text-yellow-950 text-[10px] font-black rounded-full size-5 flex items-center justify-center border-2 border-background">
                1°
              </span>
            </div>
            <div>
              <p className="text-[10px] text-yellow-600 uppercase tracking-widest font-semibold">🥇 Oro · Campeón</p>
              <p className="text-2xl font-black text-yellow-300 leading-tight">{championName}</p>
            </div>
          </div>
          {/* Plata */}
          {runnerUpName && (
            <div className="flex items-center gap-3 flex-1 min-w-[200px] border-l border-yellow-700/30 pl-4">
              <div className="relative shrink-0">
                <Trophy className="size-8 text-slate-300 drop-shadow-[0_0_6px_rgba(203,213,225,0.4)]" />
                <span className="absolute -bottom-1 -right-1 bg-slate-300 text-slate-900 text-[10px] font-black rounded-full size-5 flex items-center justify-center border-2 border-background">
                  2°
                </span>
              </div>
              <div>
                <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">🥈 Plata · Subcampeón</p>
                <p className="text-xl font-bold text-slate-200 leading-tight">{runnerUpName}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stats strip */}
      {bracketMatches.length > 0 && (
        <div className="flex gap-3 flex-wrap text-sm text-muted-foreground items-center">
          {isDoubleMode ? (
            <>
              <span>Grilla A: {matchesA.filter((m) => m.completed).length}/{matchesA.length}</span>
              <span>·</span>
              <span>Grilla B: {matchesB.filter((m) => m.completed).length}/{matchesB.length}</span>
              <span>·</span>
              <span>{competitors.length} competidores</span>
            </>
          ) : (
            <>
              <span>{totalRounds} ronda{totalRounds === 1 ? "" : "s"}</span>
              <span>·</span>
              <span>{completedMatches}/{totalMatches} combates completados</span>
              <span>·</span>
              <span>{bracketSeeds.filter((s) => s !== null).length} competidores activos</span>
              <span>·</span>
              {Array.from({ length: totalRounds }, (_, r) => {
                const rm = bracketMatches.filter((m) => m.round === r);
                const done = rm.filter((m) => m.completed).length;
                return (
                  <span key={r} className={cn(
                    "px-2 py-0.5 rounded text-xs border",
                    done === rm.length ? "border-green-700/60 text-green-400 bg-green-950/30" : "border-border"
                  )}>
                    {roundLabel(r, totalRounds)} {done}/{rm.length}
                  </span>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* AB Final status while fights are in progress */}
      {isDoubleMode && abFinalFight && !abFinalFight.completed && (
        <div className="rounded-lg border border-yellow-700/40 bg-yellow-950/20 p-3 flex items-center gap-2">
          <Swords className="size-4 text-yellow-400 shrink-0" />
          <p className="text-sm text-yellow-300">
            Final en curso: <span className="font-bold">{abFinalFight.red.name}</span> vs <span className="font-bold">{abFinalFight.blue.name}</span>
          </p>
        </div>
      )}

      {/* Main content: single or double bracket view */}
      {isDoubleMode ? (
        <div className="space-y-6">
          <BracketSection
            label="Grilla A"
            matches={matchesA}
            competitors={competitors}
            selectedMatchId={selectedMatchId}
            onSelectMatch={setSelectedMatchId}
            onSwap={swapBracketSlots}
            totalRounds={matchesA.length > 0 ? Math.max(...matchesA.map((m) => m.round)) + 1 : 0}
            onStartFight={handleStartMatchFight}
          />
          <BracketSection
            label="Grilla B"
            matches={matchesB}
            competitors={competitors}
            selectedMatchId={selectedMatchId}
            onSelectMatch={setSelectedMatchId}
            onSwap={swapBracketSlots}
            totalRounds={matchesB.length > 0 ? Math.max(...matchesB.map((m) => m.round)) + 1 : 0}
            onStartFight={handleStartMatchFight}
          />
        </div>
      ) : (
        <div className={cn(
          "grid grid-cols-1 gap-4",
          selectedMatch && "lg:grid-cols-3"
        )}>
          <div className={cn(selectedMatch ? "lg:col-span-2" : "col-span-full")}>
            <Card>
              <CardContent className="p-4 overflow-x-auto">
                <BracketView
                  matches={bracketMatches}
                  competitors={competitors}
                  onSelectMatch={setSelectedMatchId}
                  currentMatchId={selectedMatchId ?? undefined}
                  onSwap={swapBracketSlots}
                />
              </CardContent>
            </Card>
          </div>

          {selectedMatch && (
            <div className="space-y-3">
              <MatchDetailCard
                match={selectedMatch}
                competitors={competitors}
                totalRounds={totalRounds}
                onStartFight={handleStartMatchFight}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

import type { BracketMatch, CompetitorEntry } from "@/store/tournament";

function BracketSection({
  label,
  matches,
  competitors,
  selectedMatchId,
  onSelectMatch,
  onSwap,
  totalRounds,
  onStartFight,
}: Readonly<{
  label: string;
  matches: BracketMatch[];
  competitors: CompetitorEntry[];
  selectedMatchId: string | null;
  onSelectMatch: (id: string) => void;
  onSwap: (aMatchId: string, aSlot: "red" | "blue", bMatchId: string, bSlot: "red" | "blue") => void;
  totalRounds: number;
  onStartFight: (matchId: string) => void;
}>) {
  const selectedMatch = matches.find((m) => m.id === selectedMatchId);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold flex items-center gap-2">
        {label}
        {matches.length > 0 && matches.every((m) => m.completed) && (
          <Badge className="bg-green-700/80 text-xs">Completada</Badge>
        )}
        <span className="text-sm font-normal text-muted-foreground">
          {matches.filter((m) => m.completed).length}/{matches.length} combates
        </span>
      </h2>
      <div className={cn(
        "grid grid-cols-1 gap-4",
        selectedMatch && "lg:grid-cols-3"
      )}>
        <div className={cn(selectedMatch ? "lg:col-span-2" : "col-span-full")}>
          <Card>
            <CardContent className="p-4 overflow-x-auto">
              <BracketView
                matches={matches}
                competitors={competitors}
                onSelectMatch={onSelectMatch}
                currentMatchId={selectedMatchId ?? undefined}
                onSwap={onSwap}
              />
            </CardContent>
          </Card>
        </div>
        {selectedMatch && (
          <div className="space-y-3">
            <MatchDetailCard
              match={selectedMatch}
              competitors={competitors}
              totalRounds={totalRounds}
              onStartFight={onStartFight}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function MatchDetailCard({
  match,
  competitors,
  totalRounds,
  onStartFight,
}: Readonly<{
  match: BracketMatch;
  competitors: CompetitorEntry[];
  totalRounds: number;
  onStartFight: (matchId: string) => void;
}>) {
  const canFight = !match.completed && !!match.red.competitor && !!match.blue.competitor;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {roundLabel(match.round, totalRounds)} — Pos. {match.position + 1}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pb-4">
        <div className="flex items-center justify-between border border-border rounded-lg p-3">
          <div>
            <p className={cn("font-bold", match.red.competitor ? "text-red-400" : "text-muted-foreground")}>
              {match.red.competitor?.name ?? "Por confirmar"}
            </p>
            {match.red.competitor?.team && (
              <p className="text-xs text-muted-foreground">{match.red.competitor.team}</p>
            )}
          </div>
          <span className="text-muted-foreground text-xs px-2">vs</span>
          <div className="text-right">
            <p className={cn("font-bold", match.blue.competitor ? "text-blue-400" : "text-muted-foreground")}>
              {match.blue.competitor?.name ?? "Por confirmar"}
            </p>
            {match.blue.competitor?.team && (
              <p className="text-xs text-muted-foreground">{match.blue.competitor.team}</p>
            )}
          </div>
        </div>
        {match.completed && match.winnerId && (
          <div className="text-center">
            <Badge className="bg-green-700/80">
              Ganador: {competitors.find((c) => c.id === match.winnerId)?.name ?? "—"}
            </Badge>
          </div>
        )}
        {canFight && (
          <Button
            className="w-full gap-2"
            onClick={() => onStartFight(match.id)}
          >
            <Play className="size-4" />
            Pelear ahora
          </Button>
        )}
        {!canFight && !match.completed && (
          <p className="text-xs text-muted-foreground text-center">Esperando competidores</p>
        )}
      </CardContent>
    </Card>
  );
}



