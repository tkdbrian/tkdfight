import * as React from "react";
import confetti from "canvas-confetti";
import { useNavigate } from "react-router-dom";
import { useTournamentStore, type FightEntry, type CompetitorEntry } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { generateTiebreakFights, generateFinalFights } from "@/lib/bracket";
import { POINTS_WIN, POINTS_DRAW } from "@/rules/round-robin";
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
  foulsAgainst: number;
  warnings: number;
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
      row = { id, name, team, played: 0, wins: 0, draws: 0, losses: 0, points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 };
      group.set(id, row);
    }
    return row;
  }

  // Only count regular (non-tiebreak / non-golden-point) fights for main standings
  for (const f of fights) {
    if (f.isTiebreakExtra || f.isGoldenPointFight) continue;
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
    blue.flagsFor += fb;
    // Puntos en contra (fouls received by each side)
    red.foulsAgainst += f.foulsRed ?? 0;
    blue.foulsAgainst += f.foulsBlue ?? 0;
    // Warnings
    red.warnings += f.warningsRed ?? 0;
    blue.warnings += f.warningsBlue ?? 0;

    if (f.winner === "red") {
      red.wins++;   red.points += POINTS_WIN;
      blue.losses++;
    } else if (f.winner === "blue") {
      blue.wins++;  blue.points += POINTS_WIN;
      red.losses++;
    } else {
      red.draws++;  red.points += POINTS_DRAW;
      blue.draws++; blue.points += POINTS_DRAW;
    }
  }

  // Sort each group
  const result = new Map<string, StandingRow[]>();
  for (const [gid, map] of byGroup) {
    const rows = [...map.values()];
    rows.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.flagsFor !== a.flagsFor) return b.flagsFor - a.flagsFor;
      if (a.foulsAgainst !== b.foulsAgainst) return a.foulsAgainst - b.foulsAgainst;
      return a.warnings - b.warnings;
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
        r.foulsAgainst === top.foulsAgainst &&
        r.warnings === top.warnings,
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
  goldenPoint?: boolean; // true when the next fight must be punto de oro
}

type TbStat = { points: number; flagsFor: number; foulsAgainst: number; warnings: number };

function buildTbStats(tbFights: FightEntry[]): Map<string, TbStat> {
  const stats = new Map<string, TbStat>();

  for (const f of tbFights) {
    for (const id of [f.red.id, f.blue.id]) {
      if (!stats.has(id)) stats.set(id, { points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 });
    }
    if (!f.completed) continue;

    const rs = stats.get(f.red.id);
    const bs = stats.get(f.blue.id);
    if (!rs || !bs) continue;

    const fr = f.flagsRed ?? 0;
    const fb = f.flagsBlue ?? 0;
    rs.flagsFor += fr;
    rs.foulsAgainst += f.foulsRed ?? 0;
    bs.flagsFor += fb;
    bs.foulsAgainst += f.foulsBlue ?? 0;
    rs.warnings += f.warningsRed ?? 0;
    bs.warnings += f.warningsBlue ?? 0;

    if (f.winner === "red") {
      rs.points += POINTS_WIN;
    } else if (f.winner === "blue") {
      bs.points += POINTS_WIN;
    } else {
      rs.points += POINTS_DRAW;
      bs.points += POINTS_DRAW;
    }
  }

  return stats;
}

function computeTiebreakOrder(tbFights: FightEntry[]): string[] {
  const stats = buildTbStats(tbFights);

  return [...stats.entries()]
    .sort(([, a], [, b]) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.flagsFor !== a.flagsFor) return b.flagsFor - a.flagsFor;
      if (a.foulsAgainst !== b.foulsAgainst) return a.foulsAgainst - b.foulsAgainst;
      return a.warnings - b.warnings;
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
    (f) => (f.isTiebreakExtra || f.isGoldenPointFight) && f.groupId === groupId,
  );

  if (tbFights.length === 0) {
    const groupFights = allFights.filter(
      (f) => !f.isTiebreakExtra && !f.isGoldenPointFight && f.groupId === groupId,
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

  // Caso crítico: desempate entre 2 competidores.
  // Un empate NO puede resolverse por banderas: se necesita ganador real.
  if (tiedIds.length === 2) {
    const completedDraws = tbFights.filter((f) => f.completed && f.winner === "draw").length;
    const decisive = [...tbFights]
      .filter((f) => f.completed && (f.winner === "red" || f.winner === "blue"))
      .at(-1);

    if (!decisive) {
      return {
        status: "needed",
        tiedIds,
        fights: tbFights,
        goldenPoint: completedDraws >= 1,
      };
    }

    const winnerId = decisive.winner === "red" ? decisive.red.id : decisive.blue.id;
    const loserId = decisive.winner === "red" ? decisive.blue.id : decisive.red.id;
    return {
      status: "resolved",
      tiedIds,
      fights: tbFights,
      resolvedOrder: [winnerId, loserId],
    };
  }

  const resolvedOrder = computeTiebreakOrder(tbFights);

  // Check if tie is actually broken — if top 2 are still equal, need another fight
  if (resolvedOrder.length >= 2) {
    const stats = buildTbStats(tbFights);
    const s1 = stats.get(resolvedOrder[0]);
    const s2 = stats.get(resolvedOrder[1]);
    const stillTied =
      s1?.points === s2?.points &&
      s1?.flagsFor === s2?.flagsFor &&
      s1?.foulsAgainst === s2?.foulsAgainst &&
      s1?.warnings === s2?.warnings &&
      s1 != null && s2 != null;
    if (stillTied) {
      // Count completed draws to determine if next fight must be golden point
      const completedDraws = tbFights.filter((f) => f.completed && f.winner === "draw").length;
      return { status: "needed", tiedIds, fights: tbFights, goldenPoint: completedDraws >= 1 };
    }
  }

  return {
    status: "resolved",
    tiedIds,
    fights: tbFights,
    resolvedOrder,
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
  const header = "Llave,Pos,Nombre,Equipo,PJ,PG,PE,PP,Pts,Banderas,PtContra,Adv";
  const rows: string[] = [];
  for (const [gid, standings] of byGroup) {
    for (const [i, s] of standings.entries()) {
      rows.push([gid, i + 1, `"${s.name}"`, `"${s.team ?? ""}"`, s.played, s.wins, s.draws, s.losses, s.points, s.flagsFor, s.foulsAgainst, s.warnings].join(","));
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

function GroupCard({
  groupId, rows, tiebreak, onResolve, label, groupFights, finalistId, isTul, eliminationMode,
}: Readonly<{
  groupId: string;
  rows: StandingRow[];
  tiebreak: TiebreakInfo;
  onResolve: () => void;
  label?: string;
  groupFights?: FightEntry[];
  finalistId?: string;
  isTul?: boolean;
  /** En eliminación pura (ej. Fase Final): si el desempate quedó resuelto,
   *  el ganador del desempate cuenta como ganador real del combate y las peleas
   *  de desempate no se muestran como peleas aparte. */
  eliminationMode?: boolean;
}>) {
  const displayRows = tiebreak.status === "resolved" && tiebreak.resolvedOrder
    ? applyTiebreakOrder(rows, tiebreak.tiedIds, tiebreak.resolvedOrder)
    : rows;

  const tbCompleted = tiebreak.fights.filter((f) => f.completed).length;

  // Full stats for display — tiebreak/GP sequences count as 1 jugado, excluded from W/D/L/points/flags/fouls
  // En eliminationMode: el desempate es detalle interno y el ganador del desempate cuenta como
  // ganador real del combate (3 pts, 0 empate) en vez de empate.
  const fullStats = React.useMemo(() => {
    const map = new Map<string, StandingRow>();
    for (const row of rows) {
      map.set(row.id, { ...row, played: 0, wins: 0, draws: 0, losses: 0, points: 0, flagsFor: 0, foulsAgainst: 0, warnings: 0 });
    }
    const tbWinnerId =
      eliminationMode && tiebreak.status === "resolved" && tiebreak.resolvedOrder
        ? tiebreak.resolvedOrder[0]
        : null;
    const countedTbSeqs = new Set<string>();
    for (const f of (groupFights ?? [])) {
      if (!f.completed) continue;
      const red = map.get(f.red.id);
      const blue = map.get(f.blue.id);
      if (!red || !blue) continue;
      // Tiebreak/GP: en eliminación no se cuentan; en grupos cuenta toda la secuencia como 1 jugado.
      if (f.isTiebreakExtra || f.isGoldenPointFight) {
        if (eliminationMode) continue;
        const seqKey = `${f.groupId ?? ""}|${[f.red.id, f.blue.id].sort().join("|")}`;
        if (!countedTbSeqs.has(seqKey)) {
          countedTbSeqs.add(seqKey);
          red.played++; blue.played++;
        }
        continue;
      }
      red.played++; blue.played++;
      red.flagsFor += f.flagsRed ?? 0;
      blue.flagsFor += f.flagsBlue ?? 0;
      red.foulsAgainst += f.foulsRed ?? 0;
      blue.foulsAgainst += f.foulsBlue ?? 0;
      red.warnings += f.warningsRed ?? 0;
      blue.warnings += f.warningsBlue ?? 0;
      // Si fue empate y hubo desempate resuelto a favor de uno de los dos, reescribir como victoria.
      let effectiveWinner: "red" | "blue" | "draw" | undefined = f.winner;
      if (
        tbWinnerId &&
        f.winner === "draw" &&
        (f.red.id === tbWinnerId || f.blue.id === tbWinnerId)
      ) {
        effectiveWinner = f.red.id === tbWinnerId ? "red" : "blue";
      }
      if (effectiveWinner === "red") { red.wins++; red.points += POINTS_WIN; blue.losses++; }
      else if (effectiveWinner === "blue") { blue.wins++; blue.points += POINTS_WIN; red.losses++; }
      else { red.draws++; red.points += POINTS_DRAW; blue.draws++; blue.points += POINTS_DRAW; }
    }
    return map;
  }, [rows, groupFights, eliminationMode, tiebreak.status, tiebreak.resolvedOrder]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Trophy className="size-4" />
          {label ?? `Llave ${groupId}`}
          <Badge variant="secondary">{rows.length} competidores</Badge>
          {tiebreak.status === "needed" && (
            <Badge
              variant="outline"
              className={tiebreak.goldenPoint
                ? "border-yellow-400 text-yellow-300 gap-1"
                : "border-orange-600 text-orange-400 gap-1"}
            >
              <AlertTriangle className="size-3" />
              {tiebreak.goldenPoint ? "Punto de Oro pendiente" : "Desempate pendiente"}
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
              {!isTul && <TableHead className="text-center">Ganados</TableHead>}
              {!isTul && <TableHead className="text-center hidden sm:table-cell">Empates</TableHead>}
              {!isTul && <TableHead className="text-center hidden sm:table-cell">Perdidos</TableHead>}
              {!isTul && <TableHead className="text-center hidden sm:table-cell">Peleas</TableHead>}
              {!isTul && <TableHead className="text-center text-white font-black text-sm bg-white/5 border-b-2 border-white/20">Puntos</TableHead>}
              {!isTul && <TableHead className="text-center text-amber-400/80 font-semibold hidden sm:table-cell">Banderas</TableHead>}
              {!isTul && <TableHead className="text-center hidden sm:table-cell">Pt. contra</TableHead>}
              {!isTul && <TableHead className="text-center hidden sm:table-cell">Adv</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayRows.map((s, i) => {
              const medal = MEDALS[i] ?? null;
              const isTied = tiebreak.status !== "resolved" && tiebreak.tiedIds.includes(s.id);
              const isFirst = i === 0;
              const isSecond = i === 1;
              const isFinalist = !!finalistId && s.id === finalistId;
              const ds = fullStats.get(s.id) ?? s; // display stats (includes tiebreak fights)
              return (
                <TableRow key={s.id} className={cn(
                  "transition-colors",
                  isTied && "bg-orange-950/20",
                  isFirst && !isTied && "bg-yellow-500/10 border-l-4 border-yellow-400",
                  isSecond && !isTied && "bg-sky-900/20 border-l-4 border-sky-400/60",
                  isFinalist && "border-l-4 border-emerald-500",
                )}>
                  <TableCell className="font-bold text-base">
                    {medal ?? `${i + 1}`}
                  </TableCell>
                  <TableCell className={cn(
                    "font-medium",
                    isFirst && "font-black text-yellow-200 text-base",
                    isSecond && "font-bold text-sky-100",
                  )}>
                    {s.name}
                    {s.team && <span className="text-xs text-muted-foreground ml-1.5">{s.team}</span>}
                    {isTied && <span className="ml-1.5 text-xs text-orange-400">⚡ Empate</span>}
                    {isFirst && !isTied && <span className="ml-2 text-[10px] font-bold text-yellow-300 bg-yellow-700/50 border border-yellow-500/60 px-1.5 py-0.5 rounded-sm">🥇 1° PUESTO</span>}
                    {isSecond && !isTied && <span className="ml-2 text-[10px] font-bold text-sky-200 bg-sky-800/50 border border-sky-500/50 px-1.5 py-0.5 rounded-sm">🥈 2° PUESTO</span>}
                    {isFinalist && (
                      <span className="ml-2 text-[10px] font-bold text-emerald-300 bg-emerald-900/60 border border-emerald-600/50 px-1.5 py-0.5 rounded-sm">→ Fase Final</span>
                    )}
                  </TableCell>
                  {!isTul && <TableCell className="text-center font-bold text-green-400">{ds.wins}</TableCell>}
                  {!isTul && <TableCell className="text-center text-yellow-400 hidden sm:table-cell">{ds.draws}</TableCell>}
                  {!isTul && <TableCell className="text-center text-red-400 hidden sm:table-cell">{ds.losses}</TableCell>}
                  {!isTul && <TableCell className="text-center text-muted-foreground/60 hidden sm:table-cell">{ds.played}</TableCell>}
                  {!isTul && (
                    <TableCell className="text-center bg-white/5">
                      <span className={cn(
                        "inline-block tabular-nums font-black rounded px-2 py-0.5",
                        isFirst ? "text-3xl text-yellow-300 bg-yellow-800/50 ring-1 ring-yellow-500/50" :
                        isSecond ? "text-2xl text-sky-200 bg-sky-800/30" :
                        "text-lg text-white/40",
                      )}>
                        {ds.points}
                      </span>
                    </TableCell>
                  )}
                  {!isTul && (
                    <TableCell className="text-center hidden sm:table-cell">
                      <span className={cn(
                        "font-bold tabular-nums",
                        isFirst ? "text-amber-300 text-base" :
                        isSecond ? "text-amber-400/70" :
                        "text-amber-400/30",
                       )}>
                        {ds.flagsFor}
                      </span>
                    </TableCell>
                  )}
                  {!isTul && <TableCell className="text-center text-muted-foreground hidden sm:table-cell">{ds.foulsAgainst}</TableCell>}
                  {!isTul && (
                    <TableCell className="text-center text-xs text-muted-foreground hidden sm:table-cell">
                      {ds.warnings > 0 ? <span className="text-yellow-400 font-medium">{ds.warnings}</span> : "—"}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        </div>

        {tiebreak.status === "needed" && (
          <Button
            variant="outline"
            className={tiebreak.goldenPoint
              ? "w-full border-yellow-400/60 text-yellow-300 hover:bg-yellow-950/30"
              : "w-full border-orange-600/50 text-orange-400 hover:bg-orange-950/30"}
            onClick={onResolve}
          >
            <Zap className="size-4" />
            {tiebreak.goldenPoint
              ? `Iniciar Punto de Oro — ${tiebreak.tiedIds.length} competidores`
              : `Resolver desempate — ${tiebreak.tiedIds.length} competidores empatados`}
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
    (f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight && groupIds.includes(f.groupId ?? ""),
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
  const { fights, config, addTiebreakFights, addFinalFights, reset } = useTournamentStore(
    useShallow((s) => ({ fights: s.fights, config: s.config, addTiebreakFights: s.addTiebreakFights, addFinalFights: s.addFinalFights, reset: s.reset }))
  );
  const navigate = useNavigate();
  const [confirmReset, setConfirmReset] = React.useState(false);

  const byGroup = computeGroupStandings(fights);
  const regularGroupIds = [...byGroup.keys()].filter((id) => id !== "FINAL");
  const finalRows = byGroup.get("FINAL");
  const finalTiebreak = finalRows ? getTiebreakInfo("FINAL", finalRows, fights) : null;
  const canStartFinal = isFinalReady(byGroup, fights);

  const finalistIds = React.useMemo(() => {
    if (!canStartFinal) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const gid of regularGroupIds) {
      const rows = byGroup.get(gid) ?? [];
      const winner = getGroupWinner(gid, rows, fights);
      if (winner) map.set(gid, winner.id);
    }
    return map;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canStartFinal]);

  const completed = fights.filter((f) => f.completed && !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight).length;
  const total = fights.filter((f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight).length;

  // Campeón: llave única sin fase final
  const singleGroupChampion: CompetitorEntry | null = (() => {
    if (regularGroupIds.length !== 1 || fights.some((f) => f.isFinalFight)) return null;
    const gid = regularGroupIds[0];
    const rows = byGroup.get(gid) ?? [];
    const info = getTiebreakInfo(gid, rows, fights);
    if (info.status === "needed" || info.status === "in_progress") return null;
    const gFights = fights.filter((f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight && f.groupId === gid);
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
    // Si ya hubo al menos 1 desempate en empate → siguiente pelea es Punto de Oro
    const completedDraws = fights.filter(
      (f) => (f.isTiebreakExtra || f.isGoldenPointFight) && f.groupId === groupId && f.completed && f.winner === "draw",
    ).length;
    const isGoldenPoint = completedDraws >= 1;

    let tbFights = generateTiebreakFights(tiedCompetitors, groupId);
    if (isGoldenPoint) {
      tbFights = tbFights.map((f) => ({ ...f, isTiebreakExtra: true, isGoldenPointFight: true as const }));
    }
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
        <div className="rounded-2xl bg-yellow-950/40 border-2 border-yellow-600/50 p-6 flex items-center gap-4 shadow-lg flex-wrap">
          <Trophy className="size-12 text-yellow-400 shrink-0 animate-pulse" />
          <div className="flex-1">
            <p className="text-sm text-yellow-600 uppercase tracking-widest font-semibold">Campeón</p>
            <p className="text-4xl font-black text-yellow-300 leading-tight">{champion.name}</p>
            {champion.team && (
              <p className="text-base text-yellow-500/70 mt-0.5">{champion.team}</p>
            )}
          </div>
          <div className="shrink-0">
            {confirmReset ? (
              <div className="flex flex-col items-end gap-2">
                <p className="text-xs text-amber-300 font-medium">¿Borrar todo y arrancar nueva categoría?</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => { reset(); navigate("/"); }}
                  >
                    Sí, nueva categoría
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmReset(false)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="border-yellow-700/50 text-yellow-400 hover:bg-yellow-950/60 hover:text-yellow-300"
                onClick={() => setConfirmReset(true)}
              >
                → Nueva categoría
              </Button>
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
            finalistId={finalistIds.get(gid)}
            isTul={config.matchType === 'tul'}
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
          isTul={config.matchType === 'tul'}
          eliminationMode
        />
      )}
    </div>
  );
}

