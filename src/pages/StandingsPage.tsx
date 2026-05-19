import * as React from "react";
import confetti from "canvas-confetti";
import { useNavigate } from "react-router-dom";
import { useTournamentStore, type FightEntry, type CompetitorEntry } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { generateTiebreakFights, generateFinalFights } from "@/lib/bracket";
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
import { Trophy, Download, AlertTriangle, Zap, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface StandingRow {
  id: string;
  name: string;
  team?: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;       // 3×wins + 1×draws
  flagsFor: number;
  flagsAgainst: number;
  flagDiff: number;
}

// ── Logic ──────────────────────────────────────────────────────────────────

function computeGroupStandings(fights: FightEntry[]): Map<string, StandingRow[]> {
  const byGroup = new Map<string, Map<string, StandingRow>>();

  function ensureRow(groupId: string, id: string, name: string, team?: string): StandingRow {
    let group = byGroup.get(groupId);
    if (!group) {
      group = new Map<string, StandingRow>();
      byGroup.set(groupId, group);
    }
    let row = group.get(id);
    if (!row) {
      row = { id, name, team, played: 0, wins: 0, draws: 0, losses: 0, points: 0, flagsFor: 0, flagsAgainst: 0, flagDiff: 0 };
      group.set(id, row);
    }
    return row;
  }

  // Only count regular (non-tiebreak) fights for main standings
  for (const f of fights) {
    if (f.isTiebreakExtra) continue;
    const gid = f.groupId ?? "G1";
    ensureRow(gid, f.red.id, f.red.name, f.red.team);
    ensureRow(gid, f.blue.id, f.blue.name, f.blue.team);

    if (!f.completed) continue;

    const red = ensureRow(gid, f.red.id, f.red.name, f.red.team);
    const blue = ensureRow(gid, f.blue.id, f.blue.name, f.blue.team);

    red.played++;
    blue.played++;

    // Flags (judge votes in favour of each side)
    const fr = f.flagsRed ?? 0;
    const fb = f.flagsBlue ?? 0;
    red.flagsFor += fr;
    red.flagsAgainst += fb;
    blue.flagsFor += fb;
    blue.flagsAgainst += fr;

    if (f.winner === "red") {
      red.wins++;   red.points += 3;
      blue.losses++;
    } else if (f.winner === "blue") {
      blue.wins++;  blue.points += 3;
      red.losses++;
    } else {
      red.draws++;  red.points += 1;
      blue.draws++; blue.points += 1;
    }
  }

  // Recalculate flagDiff and sort each group
  const result = new Map<string, StandingRow[]>();
  for (const [gid, map] of byGroup) {
    const rows = [...map.values()].map((r) => ({ ...r, flagDiff: r.flagsFor - r.flagsAgainst }));
    rows.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.flagsFor !== a.flagsFor) return b.flagsFor - a.flagsFor;
      return b.flagDiff - a.flagDiff;
    });
    result.set(gid, rows);
  }

  return result;
}

function detectTiebreaks(rows: StandingRow[]): string[] {
  if (rows.length < 2) return [];
  const top = rows[0];
  return rows
    .filter(
      (r) =>
        r !== top &&
        r.points === top.points &&
        r.flagsFor === top.flagsFor &&
        r.flagDiff === top.flagDiff,
    )
    .map((r) => r.id)
    .concat(top.id);
}

// ── Tiebreak logic ─────────────────────────────────────────────────────────

interface TiebreakInfo {
  status: "none" | "needed" | "in_progress" | "resolved";
  tiedIds: string[];
  fights: FightEntry[];
  resolvedOrder?: string[];
}

function computeTiebreakOrder(tbFights: FightEntry[]): string[] {
  const stats = new Map<string, { points: number; flagsFor: number; flagDiff: number }>();

  for (const f of tbFights) {
    for (const id of [f.red.id, f.blue.id]) {
      if (!stats.has(id)) stats.set(id, { points: 0, flagsFor: 0, flagDiff: 0 });
    }
    if (!f.completed) continue;

    const rs = stats.get(f.red.id);
    const bs = stats.get(f.blue.id);
    if (!rs || !bs) continue;

    const fr = f.flagsRed ?? 0;
    const fb = f.flagsBlue ?? 0;
    rs.flagsFor += fr;
    rs.flagDiff += fr - fb;
    bs.flagsFor += fb;
    bs.flagDiff += fb - fr;

    if (f.winner === "red") {
      rs.points += 3;
    } else if (f.winner === "blue") {
      bs.points += 3;
    } else {
      rs.points += 1;
      bs.points += 1;
    }
  }

  return [...stats.entries()]
    .sort(([, a], [, b]) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.flagsFor !== a.flagsFor) return b.flagsFor - a.flagsFor;
      return b.flagDiff - a.flagDiff;
    })
    .map(([id]) => id);
}

function getTiebreakInfo(
  groupId: string,
  rows: StandingRow[],
  allFights: FightEntry[],
): TiebreakInfo {
  const tiedIds = detectTiebreaks(rows);
  if (tiedIds.length < 2) return { status: "none", tiedIds: [], fights: [] };

  const tbFights = allFights.filter(
    (f) => f.isTiebreakExtra && f.groupId === groupId,
  );

  if (tbFights.length === 0) {
    const groupFights = allFights.filter(
      (f) => !f.isTiebreakExtra && f.groupId === groupId,
    );
    const allComplete = groupFights.every((f) => f.completed);
    return {
      status: allComplete ? "needed" : "none",
      tiedIds,
      fights: [],
    };
  }

  const allComplete = tbFights.every((f) => f.completed);
  if (!allComplete) {
    return { status: "in_progress", tiedIds, fights: tbFights };
  }

  return {
    status: "resolved",
    tiedIds,
    fights: tbFights,
    resolvedOrder: computeTiebreakOrder(tbFights),
  };
}

function applyTiebreakOrder(
  rows: StandingRow[],
  tiedIds: string[],
  resolvedOrder: string[],
): StandingRow[] {
  const tiedPositions = rows
    .map((r, i) => (tiedIds.includes(r.id) ? i : -1))
    .filter((i) => i >= 0);
  if (tiedPositions.length === 0) return rows;

  const startPos = Math.min(...tiedPositions);
  const result = [...rows];
  for (let i = 0; i < resolvedOrder.length; i++) {
    const row = rows.find((r) => r.id === resolvedOrder[i]);
    if (row) result[startPos + i] = row;
  }
  return result;
}

function exportCsv(byGroup: Map<string, StandingRow[]>, categoryName: string) {
  const header = "Llave,Pos,Nombre,Equipo,PJ,PG,PE,PP,Pts,BF,BC,Dif";
  const rows: string[] = [];
  for (const [gid, standings] of byGroup) {
    for (const [i, s] of standings.entries()) {
      rows.push([gid, i + 1, `"${s.name}"`, `"${s.team ?? ""}"`, s.played, s.wins, s.draws, s.losses, s.points, s.flagsFor, s.flagsAgainst, s.flagDiff].join(","));
    }
  }
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `standings_${categoryName.replaceAll(" ", "_") || "categoria"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Sub-components ─────────────────────────────────────────────────────────

const MEDALS = ["🥇", "🥈", "🥉"] as const;

function flagDiffClass(diff: number): string {
  if (diff > 0) return "text-green-400";
  if (diff < 0) return "text-red-400";
  return "text-muted-foreground";
}

function GroupCard({
  groupId, rows, tiebreak, onResolve, label, groupFights,
}: Readonly<{
  groupId: string;
  rows: StandingRow[];
  tiebreak: TiebreakInfo;
  onResolve: () => void;
  label?: string;
  groupFights?: FightEntry[];
}>) {
  const displayRows = tiebreak.status === "resolved" && tiebreak.resolvedOrder
    ? applyTiebreakOrder(rows, tiebreak.tiedIds, tiebreak.resolvedOrder)
    : rows;

  const tbCompleted = tiebreak.fights.filter((f) => f.completed).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Trophy className="size-4" />
          {label ?? `Llave ${groupId}`}
          <Badge variant="secondary">{rows.length} competidores</Badge>
          {tiebreak.status === "needed" && (
            <Badge variant="outline" className="border-orange-600 text-orange-400 gap-1">
              <AlertTriangle className="size-3" />
              Desempate pendiente
            </Badge>
          )}
          {tiebreak.status === "in_progress" && (
            <Badge variant="outline" className="border-yellow-600 text-yellow-400 gap-1">
              <Zap className="size-3" />
              Desempate en curso ({tbCompleted}/{tiebreak.fights.length})
            </Badge>
          )}
          {tiebreak.status === "resolved" && (
            <Badge variant="outline" className="border-green-600 text-green-400 gap-1">
              <CheckCircle className="size-3" />
              Desempate resuelto
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">Pos</TableHead>
              <TableHead>Nombre</TableHead>
              <TableHead className="text-center">Ganados</TableHead>
              <TableHead className="text-center hidden sm:table-cell">Empates</TableHead>
              <TableHead className="text-center hidden sm:table-cell">Perdidos</TableHead>
              <TableHead className="text-center text-white font-black text-sm bg-white/5 border-b-2 border-white/20">Puntos</TableHead>
              <TableHead className="text-center text-amber-400/80 font-semibold hidden sm:table-cell">Banderines a favor</TableHead>
              <TableHead className="text-center hidden sm:table-cell">Banderines en contra</TableHead>
              <TableHead className="text-center hidden sm:table-cell">Diferencia</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.map((s, i) => {
              const medal = MEDALS[i] ?? null;
              const isTied = tiebreak.status !== "resolved" && tiebreak.tiedIds.includes(s.id);
              const isFirst = i === 0;
              return (
                <TableRow key={s.id} className={cn(isTied && "bg-orange-950/20", isFirst && "bg-white/3")}>
                  <TableCell className="text-muted-foreground font-medium">
                    {medal ?? `${i + 1}`}
                  </TableCell>
                  <TableCell className={cn("font-medium", isFirst && "font-bold")}>
                    {s.name}
                    {s.team && <span className="text-xs text-muted-foreground ml-1.5">{s.team}</span>}
                    {isTied && <span className="ml-1.5 text-xs text-orange-400">⚡ Empate</span>}
                  </TableCell>
                  <TableCell className="text-center font-bold text-green-400">{s.wins}</TableCell>
                  <TableCell className="text-center text-yellow-400 hidden sm:table-cell">{s.draws}</TableCell>
                  <TableCell className="text-center text-red-400 hidden sm:table-cell">{s.losses}</TableCell>
                  <TableCell className="text-center bg-white/5">
                    <span className={cn(
                      "inline-block tabular-nums font-black rounded px-2 py-0.5",
                      isFirst
                        ? "text-2xl text-white bg-white/10"
                        : "text-lg text-white/60",
                    )}>
                      {s.points}
                    </span>
                  </TableCell>
                  <TableCell className="text-center hidden sm:table-cell">
                    <span className={cn(
                      "font-bold tabular-nums",
                      isFirst ? "text-amber-400 text-base" : "text-amber-400/50",
                     )}>
                      {s.flagsFor}
                    </span>
                  </TableCell>
                  <TableCell className="text-center text-muted-foreground hidden sm:table-cell">{s.flagsAgainst}</TableCell>
                  <TableCell className={cn("text-center font-medium hidden sm:table-cell", flagDiffClass(s.flagDiff))}>
                    {s.flagDiff > 0 ? `+${s.flagDiff}` : s.flagDiff}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </div>

        {tiebreak.status === "needed" && (
          <Button
            variant="outline"
            className="w-full border-orange-600/50 text-orange-400 hover:bg-orange-950/30"
            onClick={onResolve}
          >
            <Zap className="size-4" />
            Resolver desempate — {tiebreak.tiedIds.length} competidores empatados
          </Button>
        )}

        {tiebreak.status === "in_progress" && (
          <p className="text-xs text-center text-yellow-400">
            ⏳ Desempate en curso — {tbCompleted} de {tiebreak.fights.length} peleas completadas.
            Ir a Combates para continuar.
          </p>
        )}

        {/* Peleas reasignadas completadas en otro tatami */}
        {groupFights?.some((f) => f.completed && f.importedFrom && f.winReason?.startsWith("Jugada en")) && (
          <div className="space-y-1 pt-1">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-semibold">Jugadas en otro tatami</p>
            {groupFights.filter((f) => f.completed && f.importedFrom && f.winReason?.startsWith("Jugada en")).map((f) => (
              <div key={f.id} className="flex items-center gap-2 text-xs text-muted-foreground rounded bg-yellow-500/8 border border-yellow-500/20 px-2.5 py-1">
                <span className="inline-block rounded-sm bg-yellow-500/20 text-yellow-300 px-1 text-[10px] font-bold">ext.</span>
                <span className={f.winner === "red" ? "text-red-300 font-semibold" : "text-muted-foreground"}>{f.red.name}</span>
                <span className="text-muted-foreground/40">vs</span>
                <span className={f.winner === "blue" ? "text-blue-300 font-semibold" : "text-muted-foreground"}>{f.blue.name}</span>
                <span className="ml-auto text-muted-foreground/50 text-[10px]">{f.winReason}</span>
              </div>
            ))}
          </div>
        )}

      </CardContent>
    </Card>
  );
}

// ── Final phase helpers ────────────────────────────────────────────────────

function getGroupWinner(
  groupId: string,
  rows: StandingRow[],
  allFights: FightEntry[],
): CompetitorEntry | null {
  const info = getTiebreakInfo(groupId, rows, allFights);
  const winnerId =
    info.status === "resolved" && info.resolvedOrder && info.resolvedOrder.length > 0
      ? info.resolvedOrder[0]
      : rows[0]?.id;
  if (!winnerId) return null;
  for (const f of allFights) {
    if (f.red.id === winnerId) return f.red;
    if (f.blue.id === winnerId) return f.blue;
  }
  return null;
}

function isFinalReady(
  byGroupMap: Map<string, StandingRow[]>,
  allFights: FightEntry[],
): boolean {
  const groupIds = [...byGroupMap.keys()].filter((id) => id !== "FINAL");
  if (groupIds.length < 2) return false;
  if (allFights.some((f) => f.isFinalFight)) return false;
  const groupFights = allFights.filter(
    (f) => !f.isTiebreakExtra && !f.isFinalFight && groupIds.includes(f.groupId ?? ""),
  );
  if (!groupFights.every((f) => f.completed)) return false;
  for (const gid of groupIds) {
    const rows = byGroupMap.get(gid) ?? [];
    const info = getTiebreakInfo(gid, rows, allFights);
    if (info.status === "needed" || info.status === "in_progress") return false;
  }
  return true;
}

// ── Page ───────────────────────────────────────────────────────────────────

export function StandingsPage() {
  const { fights, config, addTiebreakFights, addFinalFights } = useTournamentStore(
    useShallow((s) => ({ fights: s.fights, config: s.config, addTiebreakFights: s.addTiebreakFights, addFinalFights: s.addFinalFights }))
  );
  const navigate = useNavigate();

  const byGroup = computeGroupStandings(fights);
  const regularGroupIds = [...byGroup.keys()].filter((id) => id !== "FINAL");
  const finalRows = byGroup.get("FINAL");
  const finalTiebreak = finalRows ? getTiebreakInfo("FINAL", finalRows, fights) : null;
  const canStartFinal = isFinalReady(byGroup, fights);
  const completed = fights.filter((f) => f.completed && !f.isTiebreakExtra && !f.isFinalFight).length;
  const total = fights.filter((f) => !f.isTiebreakExtra && !f.isFinalFight).length;

  // Campeón: llave única sin fase final
  const singleGroupChampion: CompetitorEntry | null = (() => {
    if (regularGroupIds.length !== 1 || fights.some((f) => f.isFinalFight)) return null;
    const gid = regularGroupIds[0];
    const rows = byGroup.get(gid) ?? [];
    const info = getTiebreakInfo(gid, rows, fights);
    if (info.status === "needed" || info.status === "in_progress") return null;
    const gFights = fights.filter((f) => !f.isTiebreakExtra && !f.isFinalFight && f.groupId === gid);
    if (gFights.length === 0 || !gFights.every((f) => f.completed)) return null;
    return getGroupWinner(gid, rows, fights);
  })();

  // Campeón: fase final completada (multi-llave)
  const finalChampion: CompetitorEntry | null = (() => {
    if (!finalRows || !finalTiebreak) return null;
    const finalFights = fights.filter((f) => f.isFinalFight);
    if (finalFights.length === 0 || !finalFights.every((f) => f.completed)) return null;
    if (finalTiebreak.status === "needed" || finalTiebreak.status === "in_progress") return null;
    return getGroupWinner("FINAL", finalRows, fights);
  })();

  const champion = singleGroupChampion ?? finalChampion;

  // Confetti when champion is determined
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only re-runs when champion identity changes, not on every re-render
  React.useEffect(() => {
    if (!champion) return;
    const end = Date.now() + 2500;
    const frame = () => {
      confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors: ["#FFD700", "#FFA500", "#FFFFFF"] });
      confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors: ["#FFD700", "#FFA500", "#FFFFFF"] });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  }, [champion?.id]);

  function handleResolve(groupId: string, tiedIds: string[]) {
    const competitorMap = new Map<string, CompetitorEntry>();
    for (const f of fights) {
      competitorMap.set(f.red.id, f.red);
      competitorMap.set(f.blue.id, f.blue);
    }
    const tiedCompetitors = tiedIds
      .map((id) => competitorMap.get(id))
      .filter((c): c is CompetitorEntry => c != null);
    if (tiedCompetitors.length < 2) return;
    const tbFights = generateTiebreakFights(tiedCompetitors, groupId);
    addTiebreakFights(tbFights);
    navigate("/fight");
  }

  function handleStartFinal() {
    const winners: CompetitorEntry[] = [];
    for (const gid of regularGroupIds) {
      const rows = byGroup.get(gid) ?? [];
      const winner = getGroupWinner(gid, rows, fights);
      if (winner) winners.push(winner);
    }
    if (winners.length < 2) return;
    addFinalFights(generateFinalFights(winners));
    navigate("/fight");
  }

  if (byGroup.size === 0) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center text-muted-foreground">
        <p>No hay combates todavía.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Clasificación</h1>
          {config.categoryName && (
            <p className="text-muted-foreground text-sm mt-0.5">{config.categoryName}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{completed}/{total} combates</Badge>
          {canStartFinal && (
            <Button
              size="sm"
              className="border-yellow-600/60 bg-yellow-950/30 text-yellow-400 hover:bg-yellow-950/50"
              variant="outline"
              onClick={handleStartFinal}
            >
              <Trophy className="size-3.5" />
              Iniciar Fase Final
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportCsv(byGroup, config.categoryName)}
          >
            <Download className="size-3.5" />
            Exportar CSV
          </Button>
        </div>
      </div>

      {champion && (
        <div className="rounded-2xl bg-yellow-950/40 border-2 border-yellow-600/50 p-6 flex items-center gap-4 shadow-lg">
          <Trophy className="size-12 text-yellow-400 shrink-0 animate-pulse" />
          <div>
            <p className="text-sm text-yellow-600 uppercase tracking-widest font-semibold">Campeón</p>
            <p className="text-4xl font-black text-yellow-300 leading-tight">{champion.name}</p>
            {champion.team && (
              <p className="text-base text-yellow-500/70 mt-0.5">{champion.team}</p>
            )}
          </div>
        </div>
      )}

      {regularGroupIds.map((gid) => {
        const rows = byGroup.get(gid) ?? [];
        const tiebreak = getTiebreakInfo(gid, rows, fights);
        const gFights = fights.filter((f) => (f.groupId ?? "") === gid);
        return (
          <GroupCard
            key={gid}
            groupId={gid}
            rows={rows}
            tiebreak={tiebreak}
            groupFights={gFights}
            onResolve={() => handleResolve(gid, tiebreak.tiedIds)}
          />
        );
      })}

      {canStartFinal && (
        <div className="rounded-2xl border-2 border-yellow-500/70 bg-yellow-950/40 p-6 flex flex-col sm:flex-row items-center gap-4 shadow-xl animate-pulse">
          <Trophy className="size-12 text-yellow-400 shrink-0" />
          <div className="flex-1 text-center sm:text-left">
            <p className="text-yellow-300 font-black text-xl leading-tight">¡Clasificación completada!</p>
            <p className="text-yellow-500/80 text-sm mt-0.5">Todos los grupos terminaron. Ya podés iniciar la Fase Final.</p>
          </div>
          <Button
            size="lg"
            className="shrink-0 bg-yellow-500 hover:bg-yellow-400 text-black font-black text-base px-6 shadow-lg shadow-yellow-900/40"
            onClick={handleStartFinal}
          >
            <Trophy className="size-5" />
            Iniciar Fase Final
          </Button>
        </div>
      )}

      {finalRows && finalTiebreak && (
        <GroupCard
          groupId="FINAL"
          rows={finalRows}
          tiebreak={finalTiebreak}
          groupFights={fights.filter((f) => f.isFinalFight)}
          onResolve={() => handleResolve("FINAL", finalTiebreak.tiedIds)}
          label="🏆 Fase Final"
        />
      )}
    </div>
  );
}

