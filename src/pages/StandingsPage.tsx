import * as React from "react";
import confetti from "canvas-confetti";
import { useNavigate } from "react-router-dom";
import { useTournamentStore, type FightEntry, type CompetitorEntry, type TournamentGroup } from "@/store/tournament";
import { useShallow } from "zustand/react/shallow";
import { generateFinalFights } from "@/lib/bracket";
import { closedGroupBasis, resolveFirstPlace, groupWinnerId, isExternalGuestFight, rankedGroupIds, preparePlayoffFights, type FirstPlaceResolution } from "@/lib/round-robin-resolution";
import { POINTS_WIN, POINTS_DRAW } from "@/rules/round-robin";
import { Button } from "@/components/ui/button";
import { CategoryCombatAction } from "@/components/CategoryCombatAction";
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
import { useSocket } from "@/hooks/useSocket";
import { toast } from "sonner";
import { syncProposedFights } from "@/lib/sync-proposed-fights";
import { clearFightProposal, getOrCreateFightProposal } from "@/lib/pending-fight-proposals";
import { CategoryFormatFallback } from "@/components/CategoryFormatFallback";

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
    if (f.isTiebreakExtra || f.isGoldenPointFight || isExternalGuestFight(f)) continue;
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

type TiebreakInfo = FirstPlaceResolution;

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

function exportCsv(
  byGroup: Map<string, StandingRow[]>,
  categoryName: string,
  fights: FightEntry[],
  groups: TournamentGroup[],
) {
  const header = "Llave,Pos,Nombre,Equipo,PJ,PG,PE,PP,Pts,Banderas,PtContra,Adv";
  const rows: string[] = [];
  for (const [gid, standings] of byGroup) {
    const expectedIds = groups.find((group) => group.id === gid)?.competitors.map((entry) => entry.id);
    const resolution = resolveFirstPlace(gid, standings, fights, expectedIds);
    const ordered = resolution.status === "resolved" && resolution.resolvedOrder
      ? applyTiebreakOrder(standings, resolution.tiedIds, resolution.resolvedOrder)
      : standings;
    for (const [i, s] of ordered.entries()) {
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
  groupId, rows, tiebreak, onResolve, label, groupFights, expectedIds, finalistId, isTul, eliminationMode,
}: Readonly<{
  groupId: string;
  rows: StandingRow[];
  tiebreak: TiebreakInfo;
  onResolve: () => void;
  label?: string;
  groupFights?: FightEntry[];
  expectedIds?: string[];
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
  const positionsFinal = closedGroupBasis(groupId, groupFights ?? [], expectedIds ?? rows.map((row) => row.id)) !== null &&
    (tiebreak.status === "none" || tiebreak.status === "resolved");

  const tbCompleted = tiebreak.fights.filter((f) => f.completed).length;

  // Full stats for display — tiebreak/GP sequences count as 1 jugado, excluded from W/D/L/points/flags/fouls
  // En eliminationMode: el desempate es detalle interno y el ganador del desempate cuenta como
  // ganador real del combate (3 pts, 0 empate) en vez de empate.
  const fullStats = (() => {
    const map = new Map<string, StandingRow>();
    const validExtraIds = new Set(tiebreak.fights.map((fight) => fight.id));
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
        if (!validExtraIds.has(f.id)) continue;
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
  })();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Trophy className="size-4" />
          {label ?? `Llave ${groupId}`}
          <Badge variant="secondary">{rows.length} competidores</Badge>
          {!positionsFinal && tiebreak.status === "none" && (
            <Badge variant="outline">Clasificación provisional</Badge>
          )}
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
          {tiebreak.status === "review" && (
            <Badge variant="outline" className="border-red-500 text-red-300 gap-1">
              <AlertTriangle className="size-3" />
              Desempate antiguo sin verificar
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
              const medal = positionsFinal ? MEDALS[i] ?? null : null;
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
                    {isFirst && positionsFinal && !isTied && <span className="ml-2 text-[10px] font-bold text-yellow-300 bg-yellow-700/50 border border-yellow-500/60 px-1.5 py-0.5 rounded-sm">🥇 1° PUESTO</span>}
                    {isSecond && positionsFinal && !isTied && <span className="ml-2 text-[10px] font-bold text-sky-200 bg-sky-800/50 border border-sky-500/50 px-1.5 py-0.5 rounded-sm">🥈 2° PUESTO</span>}
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

        {tiebreak.status === "review" && (
          <div className="space-y-2 rounded-lg border border-red-500/40 bg-red-950/20 p-3">
            <p className="text-xs text-red-200">
              Hay {tiebreak.legacyExtras?.length ?? 0} pelea(s) extra antiguas entre los líderes sin registro de cuándo se iniciaron.
              No se usan para decidir el primer puesto ni se borran.
            </p>
            <Button variant="outline" className="w-full border-red-500/60 text-red-200" onClick={onResolve}>
              Iniciar nuevo desempate oficial
            </Button>
          </div>
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
  groups: TournamentGroup[] = [],
  expectedIds?: string[],
): CompetitorEntry | null {
  const winnerId = groupWinnerId(groupId, rows, allFights,
    expectedIds ?? groups.find((group) => group.id === groupId)?.competitors.map((competitor) => competitor.id));
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
  groups: TournamentGroup[] = [],
): boolean {
  const groupIds = [...byGroupMap.keys()].filter((id) => id !== "FINAL");
  if (groupIds.length < 2) return false;
  if (groups.length > 0 && (groupIds.length !== groups.length ||
    groups.some((group) => !groupIds.includes(group.id)))) return false;
  if (allFights.some((f) => f.isFinalFight)) return false;
  const groupFights = allFights.filter(
    (f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight && groupIds.includes(f.groupId ?? ""),
  );
  if (!groupFights.every((f) => f.completed)) return false;
  for (const gid of groupIds) {
    const rows = byGroupMap.get(gid) ?? [];
    const info = resolveFirstPlace(gid, rows, allFights,
      groups.find((group) => group.id === gid)?.competitors.map((competitor) => competitor.id));
    if (info.status === "needed" || info.status === "review" || info.status === "in_progress") return false;
    if (!getGroupWinner(gid, rows, allFights, groups)) return false;
  }
  return true;
}

// ── Page ───────────────────────────────────────────────────────────────────

export function StandingsPage() {
  const { connected, stateReady, state: serverState, request } = useSocket();
  const { fights, groups, config, phase, addTiebreakFights, addFinalFights, reset } = useTournamentStore(
    useShallow((s) => ({ fights: s.fights, groups: s.groups, config: s.config, phase: s.phase, addTiebreakFights: s.addTiebreakFights, addFinalFights: s.addFinalFights, reset: s.reset }))
  );
  const navigate = useNavigate();
  const [confirmReset, setConfirmReset] = React.useState(false);
  const creatingFightsRef = React.useRef(false);
  const activeLock = serverState.activeMatchLock;
  function canOpenFight(): boolean {
    if (creatingFightsRef.current || !connected || !stateReady || (activeLock && activeLock.categoryId !== config.id)
      || (serverState.match && !serverState.resultConfirmed)) {
      toast.warning("No se puede cargar otra pelea mientras este tatami tiene un combate activo o está desconectado.");
      return false;
    }
    return true;
  }

  async function requireConfirmedResults(dependencies: FightEntry[]): Promise<void> {
    if (dependencies.length === 0 || dependencies.some((fight) => !fight.completed || !fight.winner)) {
      throw new Error("Faltan peleas de la llave por confirmar antes de avanzar.");
    }
    const responses = await Promise.all(dependencies.map((fight) => request<{
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
    }>("match:result:get", { categoryId: config.id, matchId: fight.id })));
    for (let index = 0; index < dependencies.length; index++) {
      const fight = dependencies[index];
      const response = responses[index];
      const stats = ["flagsRed", "flagsBlue", "foulsRed", "foulsBlue", "warningsRed", "warningsBlue"] as const;
      if (!response?.ok || response.result?.status !== "confirmed" ||
        response.result.fightId !== fight.id || response.result.categoryId !== config.id ||
        response.result.winner !== fight.winner || stats.some((field) =>
          !Number.isInteger(fight[field]) || !Number.isInteger(response.result?.[field]) ||
          fight[field] !== response.result?.[field])) {
        throw new Error(`El resultado de ${fight.red.name} vs ${fight.blue.name} no coincide con el registro confirmado. Revisá la llave antes de avanzar.`);
      }
    }
  }

  const byGroup = computeGroupStandings(fights);
  const regularGroupIds = rankedGroupIds(fights);
  const finalRows = byGroup.get("FINAL");
  const finalExpectedIds = regularGroupIds.length < 2 ? null : regularGroupIds.map((groupId) =>
    getGroupWinner(groupId, byGroup.get(groupId) ?? [], fights, groups)?.id ?? null);
  const completeFinalRoster = finalExpectedIds?.every((id): id is string => id !== null)
    ? finalExpectedIds : null;
  const finalTiebreak = finalRows && completeFinalRoster
    ? resolveFirstPlace("FINAL", finalRows, fights, completeFinalRoster) : null;
  const canStartFinal = isFinalReady(byGroup, fights, groups);

  const finalistIds = (() => {
    if (!canStartFinal) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const gid of regularGroupIds) {
      const rows = byGroup.get(gid) ?? [];
      const winner = getGroupWinner(gid, rows, fights, groups);
      if (winner) map.set(gid, winner.id);
    }
    return map;
  })();

  const completed = fights.filter((f) => f.completed && !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight).length;
  const total = fights.filter((f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight).length;

  // Campeón: llave única sin fase final
  const singleGroupChampion: CompetitorEntry | null = (() => {
    if (regularGroupIds.length !== 1 || fights.some((f) => f.isFinalFight)) return null;
    const gid = regularGroupIds[0];
    const rows = byGroup.get(gid) ?? [];
    const info = resolveFirstPlace(gid, rows, fights,
      groups.find((group) => group.id === gid)?.competitors.map((competitor) => competitor.id));
    if (info.status === "needed" || info.status === "review" || info.status === "in_progress") return null;
    const gFights = fights.filter((f) => !f.isTiebreakExtra && !f.isGoldenPointFight && !f.isFinalFight && f.groupId === gid);
    if (gFights.length === 0 || !gFights.every((f) => f.completed)) return null;
    return getGroupWinner(gid, rows, fights, groups);
  })();

  // Campeón: fase final completada (multi-llave)
  const finalChampion: CompetitorEntry | null = (() => {
    if (!finalRows || !finalTiebreak || !completeFinalRoster) return null;
    const finalFights = fights.filter((f) => f.isFinalFight);
    if (finalFights.length === 0 || !finalFights.every((f) => f.completed)) return null;
    return getGroupWinner("FINAL", finalRows, fights, groups, completeFinalRoster);
  })();

  const champion = singleGroupChampion ?? finalChampion;
  const championVerificationKey = JSON.stringify([config.id, fights.map((fight) => [
    fight.id, fight.completed, fight.winner, fight.flagsRed, fight.flagsBlue,
    fight.foulsRed, fight.foulsBlue, fight.warningsRed, fight.warningsBlue,
  ])]);
  const [verifiedChampionKey, setVerifiedChampionKey] = React.useState<string | null>(null);
  // A restored local snapshot can say "completed" while the server still has a pending result.
  // The standings remain visible, but no official champion is announced until every fight matches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: championVerificationKey tracks the fight/result snapshot exactly
  React.useEffect(() => {
    if (!champion || !connected || !stateReady) return;
    let cancelled = false;
    void requireConfirmedResults(fights.filter((fight) => !isExternalGuestFight(fight)))
      .then(() => {
        if (!cancelled) setVerifiedChampionKey(championVerificationKey);
      })
      .catch(() => {
        if (!cancelled) setVerifiedChampionKey(null);
      });
    return () => { cancelled = true; };
  }, [champion?.id, championVerificationKey, connected, stateReady]);
  const officialChampion = champion && connected && stateReady &&
    verifiedChampionKey === championVerificationKey ? champion : null;

  // Confetti when champion is determined
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only re-runs when champion identity changes, not on every re-render
  React.useEffect(() => {
    if (!officialChampion) return;
    const end = Date.now() + 2500;
    const frame = () => {
      confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0 }, colors: ["#FFD700", "#FFA500", "#FFFFFF"] });
      confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1 }, colors: ["#FFD700", "#FFA500", "#FFFFFF"] });
      if (Date.now() < end) requestAnimationFrame(frame);
    };
    frame();
  }, [officialChampion?.id]);

  if (config.mode === "elimination") {
    return <CategoryFormatFallback mode={config.mode} setup={phase === "setup"} />;
  }

  async function handleResolve(groupId: string) {
    if (!canOpenFight()) return;
    const currentFights = useTournamentStore.getState().fights;
    const currentRows = computeGroupStandings(currentFights).get(groupId) ?? [];
    const resolution = resolveFirstPlace(groupId, currentRows, currentFights,
      groups.find((group) => group.id === groupId)?.competitors.map((competitor) => competitor.id));
    if ((resolution.status !== "needed" && resolution.status !== "review") || resolution.nextIds.length < 2) return;
    if (resolution.fights.length > 0 && resolution.fights.some((f) => !f.completed)) return;
    const competitorMap = new Map<string, CompetitorEntry>();
    for (const f of currentFights) {
      competitorMap.set(f.red.id, f.red);
      competitorMap.set(f.blue.id, f.blue);
    }
    const tiedCompetitors = resolution.nextIds
      .map((id) => competitorMap.get(id))
      .filter((c): c is CompetitorEntry => c != null);
    if (tiedCompetitors.length < 2) return;
    const overtimeSeconds = config.ruleSet && "rounds" in config.ruleSet
      ? config.ruleSet.rounds.overtime_seconds
      : undefined;
    const seconds = config.tiebreakerSeconds ?? overtimeSeconds ?? 30;
    const proposalStage = JSON.stringify({
      kind: "first-place", groupId, basis: resolution.playoffBasis,
      nextIds: resolution.nextIds,
      prior: resolution.fights.map((fight) => [fight.id, fight.completed, fight.winner]),
    });
    creatingFightsRef.current = true;
    try {
      const dependencies = currentFights.filter((fight) =>
        (fight.groupId ?? "G1") === groupId && !isExternalGuestFight(fight));
      await requireConfirmedResults(dependencies);
      const tbFights = getOrCreateFightProposal(config.id, proposalStage,
        () => preparePlayoffFights(tiedCompetitors, groupId, resolution, seconds));
      if (tbFights.length === 0) return;
      await syncProposedFights(config, [...currentFights, ...tbFights], dependencies.map((fight) => fight.id));
      const latest = useTournamentStore.getState();
      if (latest.config.id !== config.id || latest.fights !== currentFights) {
        toast.warning("La categoría cambió durante la sincronización; no se avanzó localmente.");
        return;
      }
      addTiebreakFights(tbFights);
      clearFightProposal(config.id, proposalStage, tbFights);
      navigate("/fight");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo guardar el desempate.");
    } finally {
      creatingFightsRef.current = false;
    }
  }

  async function handleStartFinal() {
    if (!canOpenFight()) return;
    const currentFights = useTournamentStore.getState().fights;
    const currentByGroup = computeGroupStandings(currentFights);
    if (!isFinalReady(currentByGroup, currentFights, groups)) return;
    const winners: CompetitorEntry[] = [];
    for (const gid of regularGroupIds) {
      const rows = currentByGroup.get(gid) ?? [];
      const winner = getGroupWinner(gid, rows, currentFights, groups);
      if (winner) winners.push(winner);
    }
    if (winners.length < 2 || winners.length !== regularGroupIds.length) return;
    const proposalStage = JSON.stringify({
      kind: "inter-group-final",
      winners: regularGroupIds.map((gid, index) => [gid, winners[index]?.id,
        closedGroupBasis(gid, currentFights,
          groups.find((group) => group.id === gid)?.competitors.map((competitor) => competitor.id))]),
    });
    creatingFightsRef.current = true;
    try {
      const dependencies = currentFights.filter((fight) =>
        regularGroupIds.includes(fight.groupId ?? "G1") && !isExternalGuestFight(fight));
      await requireConfirmedResults(dependencies);
      const finalFights = getOrCreateFightProposal(config.id, proposalStage,
        () => generateFinalFights(winners));
      if (finalFights.length === 0) return;
      await syncProposedFights(config, [...currentFights, ...finalFights], dependencies.map((fight) => fight.id));
      const latest = useTournamentStore.getState();
      if (latest.config.id !== config.id || latest.fights !== currentFights) {
        toast.warning("La categoría cambió durante la sincronización; no se avanzó localmente.");
        return;
      }
      addFinalFights(finalFights);
      clearFightProposal(config.id, proposalStage, finalFights);
      navigate("/fight");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "No se pudo guardar la final.");
    } finally {
      creatingFightsRef.current = false;
    }
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
          <CategoryCombatAction connected={connected} stateReady={stateReady} serverState={serverState} resultsVerified={Boolean(officialChampion)} />
          <Badge variant="secondary">{completed}/{total} combates</Badge>
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(champion && !officialChampion)}
            onClick={() => exportCsv(byGroup, config.categoryName, fights, groups)}
          >
            <Download className="size-3.5" />
            Exportar CSV
          </Button>
        </div>
      </div>

      {officialChampion && (
        <div className="rounded-2xl bg-yellow-950/40 border-2 border-yellow-600/50 p-6 flex items-center gap-4 shadow-lg flex-wrap">
          <Trophy className="size-12 text-yellow-400 shrink-0 animate-pulse" />
          <div className="flex-1">
            <p className="text-sm text-yellow-600 uppercase tracking-widest font-semibold">Campeón</p>
            <p className="text-4xl font-black text-yellow-300 leading-tight">{officialChampion.name}</p>
            {officialChampion.team && (
              <p className="text-base text-yellow-500/70 mt-0.5">{officialChampion.team}</p>
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
                    onClick={() => {
                      if (!connected || !stateReady || activeLock?.categoryId === config.id) {
                        toast.warning("No se puede borrar esta categoría sin confirmar que el combate terminó.");
                        return;
                      }
                      reset();
                      navigate("/");
                    }}
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
        const tiebreak = resolveFirstPlace(gid, rows, fights,
          groups.find((group) => group.id === gid)?.competitors.map((competitor) => competitor.id));
        const gFights = fights.filter((f) => (f.groupId ?? "") === gid);
        return (
          <GroupCard
            key={gid}
            groupId={gid}
            rows={rows}
            tiebreak={tiebreak}
            groupFights={gFights}
            expectedIds={groups.find((group) => group.id === gid)?.competitors.map((competitor) => competitor.id)}
            finalistId={finalistIds.get(gid)}
            isTul={config.matchType === 'tul'}
            onResolve={() => handleResolve(gid)}
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
          expectedIds={completeFinalRoster ?? undefined}
          onResolve={() => handleResolve("FINAL")}
          label="🏆 Fase Final"
          isTul={config.matchType === 'tul'}
          eliminationMode
        />
      )}
    </div>
  );
}

