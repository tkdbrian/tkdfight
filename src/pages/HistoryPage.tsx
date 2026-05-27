import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Trophy, ChevronDown, ChevronRight, CalendarDays, Swords,
  Loader2, AlertCircle, Users, BarChart3, Circle, WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface HistoryFight {
  id: string;
  completed: boolean;
  winner: "red" | "blue" | "draw" | null;
  flagsRed: number;
  flagsBlue: number;
  groupId: string | null;
  redName: string;
  redTeam: string | null;
  blueName: string;
  blueTeam: string | null;
}

interface HistoryTournament {
  id: number;
  name: string;
  category: string;
  createdAt: string;
  isActive: boolean;
  fightsTotal: number;
  fightsCompleted: number;
  competitors: Array<{ id: string; name: string; team: string | null }>;
  fights: HistoryFight[];
}

interface Standing {
  name: string;
  team: string | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  flagsFor: number;
  flagsAgainst: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function computeStandings(fights: HistoryFight[]): Standing[] {
  const map = new Map<string, Standing>();
  const get = (name: string, team: string | null) => {
    if (!map.has(name))
      map.set(name, { name, team, played: 0, wins: 0, draws: 0, losses: 0, points: 0, flagsFor: 0, flagsAgainst: 0 });
    return map.get(name)!;
  };
  for (const f of fights) {
    if (!f.completed) continue;
    const red = get(f.redName, f.redTeam);
    const blue = get(f.blueName, f.blueTeam);
    red.played++;
    blue.played++;
    red.flagsFor += f.flagsRed;
    red.flagsAgainst += f.flagsBlue;
    blue.flagsFor += f.flagsBlue;
    blue.flagsAgainst += f.flagsRed;
    if (f.winner === "red") { red.wins++; red.points += 3; blue.losses++; }
    else if (f.winner === "blue") { blue.wins++; blue.points += 3; red.losses++; }
    else { red.draws++; red.points += 1; blue.draws++; blue.points += 1; }
  }
  return [...map.values()].sort(
    (a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("es-AR", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch {
    return iso;
  }
}

const MEDALS = ["🥇", "🥈", "🥉"];

// ── Sub-components ───────────────────────────────────────────────────────────

function TournamentDetail({ tournament }: { tournament: HistoryTournament }) {
  const standings = computeStandings(tournament.fights);
  const completedFights = tournament.fights.filter((f) => f.completed);
  const groups = Array.from(new Set(completedFights.map((f) => f.groupId ?? "—")));
  const isGrouped = groups.some((g) => g !== "—");

  return (
    <div className="space-y-4 pt-1">
      {/* Standings */}
      {standings.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Clasificación
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Competidor</TableHead>
                <TableHead className="text-center w-10">PJ</TableHead>
                <TableHead className="text-center w-10">G</TableHead>
                <TableHead className="text-center w-10">E</TableHead>
                <TableHead className="text-center w-10">P</TableHead>
                <TableHead className="text-center w-12 font-bold">Pts</TableHead>
                <TableHead className="text-center w-16 hidden sm:table-cell">Bdns</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {standings.map((s, i) => (
                <TableRow key={s.name} className={i === 0 ? "bg-yellow-950/20" : ""}>
                  <TableCell className="font-bold text-base">
                    {MEDALS[i] ?? i + 1}
                  </TableCell>
                  <TableCell>
                    <p className="font-semibold text-sm">{s.name}</p>
                    {s.team && <p className="text-xs text-muted-foreground">{s.team}</p>}
                  </TableCell>
                  <TableCell className="text-center text-sm">{s.played}</TableCell>
                  <TableCell className="text-center text-sm text-green-400">{s.wins}</TableCell>
                  <TableCell className="text-center text-sm text-yellow-400">{s.draws}</TableCell>
                  <TableCell className="text-center text-sm text-red-400">{s.losses}</TableCell>
                  <TableCell className="text-center font-bold">{s.points}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground hidden sm:table-cell">
                    {s.flagsFor}/{s.flagsAgainst}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Fights */}
      {completedFights.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Combates ({completedFights.length})
          </p>
          <div className="space-y-1">
            {(isGrouped ? groups : [null]).map((gid) => {
              const groupFights = gid
                ? completedFights.filter((f) => (f.groupId ?? "—") === gid)
                : completedFights;
              return (
                <div key={gid ?? "all"}>
                  {isGrouped && gid && gid !== "—" && (
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 px-2 pt-1.5 pb-0.5">
                      Llave {gid}
                    </p>
                  )}
                  {groupFights.map((f) => {
                    const winnerName =
                      f.winner === "red" ? f.redName
                      : f.winner === "blue" ? f.blueName
                      : null;
                    const isDraw = f.winner === "draw" || (!f.winner && f.completed);
                    return (
                      <div
                        key={f.id}
                        className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary/20 hover:bg-secondary/30 transition-colors text-sm"
                      >
                        <span className={cn(
                          "font-semibold truncate max-w-[35%]",
                          f.winner === "red" ? "text-red-400" : "text-muted-foreground"
                        )}>
                          {f.redName}
                        </span>
                        <div className="flex flex-col items-center shrink-0 mx-2">
                          {isDraw ? (
                            <span className="text-xs font-bold text-yellow-400">⚖ Empate</span>
                          ) : (
                            <>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {f.flagsRed} — {f.flagsBlue}
                              </span>
                              <span className={cn(
                                "text-[10px] font-bold mt-0.5",
                                f.winner === "red" ? "text-red-400" : "text-blue-400"
                              )}>
                                {winnerName ? `✓ ${winnerName}` : ""}
                              </span>
                            </>
                          )}
                        </div>
                        <span className={cn(
                          "font-semibold truncate max-w-[35%] text-right",
                          f.winner === "blue" ? "text-blue-400" : "text-muted-foreground"
                        )}>
                          {f.blueName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {completedFights.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          No hay combates completados en esta categoría.
        </p>
      )}
    </div>
  );
}

// ── Stats types ──────────────────────────────────────────────────────────────

interface StatsOverview {
  totalTournaments: number;
  totalCompetitors: number;
  totalFights: number;
  completedFights: number;
  redWins: number;
  blueWins: number;
  draws: number;
}

interface CompetitorStat {
  name: string;
  team: string | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  flagsFor: number;
  flagsAgainst: number;
}

interface StatsData {
  overview: StatsOverview;
  topCompetitors: CompetitorStat[];
}

// ── Stats tab ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardContent className="py-4 px-5">
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
        {sub && <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function CornerBar({ redWins, blueWins, draws }: { redWins: number; blueWins: number; draws: number }) {
  const total = redWins + blueWins + draws;
  if (total === 0) return null;
  const pct = (n: number) => Math.round((n / total) * 100);
  const rp = pct(redWins), bp = pct(blueWins), dp = pct(draws);
  return (
    <Card>
      <CardContent className="py-4 px-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Distribución de victorias
        </p>
        {/* Bar */}
        <div className="flex h-3 rounded-full overflow-hidden gap-0.5 mb-3">
          <div className="bg-red-600/80 transition-all" style={{ width: `${rp}%` }} />
          <div className="bg-muted transition-all" style={{ width: `${dp}%` }} />
          <div className="bg-blue-600/80 transition-all" style={{ width: `${bp}%` }} />
        </div>
        {/* Legend */}
        <div className="flex justify-between text-xs">
          <span className="flex items-center gap-1.5 text-red-400">
            <Circle className="size-2 fill-red-600/80 text-red-600/80" />
            Rojo {rp}% ({redWins})
          </span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Circle className="size-2 fill-muted text-muted" />
            Empate {dp}% ({draws})
          </span>
          <span className="flex items-center gap-1.5 text-blue-400">
            <Circle className="size-2 fill-blue-600/80 text-blue-600/80" />
            Azul {bp}% ({blueWins})
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function StatsTab() {
  const [stats, setStats] = React.useState<StatsData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<StatsData>; })
      .then((d) => { if (!cancelled) setStats(d); })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center gap-3 text-muted-foreground py-16">
      <Loader2 className="size-5 animate-spin" /><span className="text-sm">Cargando estadísticas…</span>
    </div>
  );
  if (error) return (
    <div className="flex items-center justify-center gap-3 text-destructive py-16">
      <AlertCircle className="size-5" /><span className="text-sm">Error: {error}</span>
    </div>
  );
  if (!stats) return null;

  const { overview, topCompetitors } = stats;
  const completionPct = overview.totalFights > 0
    ? Math.round((overview.completedFights / overview.totalFights) * 100)
    : 0;

  return (
    <div className="space-y-4">
      {/* Overview cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Categorías" value={overview.totalTournaments} />
        <StatCard label="Combates" value={overview.completedFights} sub={`${completionPct}% completados`} />
        <StatCard label="Participaciones" value={overview.totalCompetitors} />
        <StatCard label="Banderas totales" value={overview.totalFights > 0
          ? `${overview.redWins + overview.blueWins + overview.draws}`
          : "—"
        } sub="combates finalizados" />
      </div>

      {/* Corner distribution */}
      <CornerBar redWins={overview.redWins} blueWins={overview.blueWins} draws={overview.draws} />

      {/* Global ranking */}
      {topCompetitors.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
            Ranking global — {topCompetitors.length} competidores
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Competidor</TableHead>
                <TableHead className="text-center w-10">PJ</TableHead>
                <TableHead className="text-center w-10">G</TableHead>
                <TableHead className="text-center w-10">E</TableHead>
                <TableHead className="text-center w-10">P</TableHead>
                <TableHead className="text-center w-12 font-bold">Pts</TableHead>
                <TableHead className="text-center w-16 hidden sm:table-cell">Bdns</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topCompetitors.map((c, i) => (
                <TableRow key={c.name} className={i === 0 ? "bg-yellow-950/20" : ""}>
                  <TableCell className="font-bold text-base">{MEDALS[i] ?? i + 1}</TableCell>
                  <TableCell>
                    <p className="font-semibold text-sm">{c.name}</p>
                    {c.team && <p className="text-xs text-muted-foreground">{c.team}</p>}
                  </TableCell>
                  <TableCell className="text-center text-sm">{c.played}</TableCell>
                  <TableCell className="text-center text-sm text-green-400">{c.wins}</TableCell>
                  <TableCell className="text-center text-sm text-yellow-400">{c.draws}</TableCell>
                  <TableCell className="text-center text-sm text-red-400">{c.losses}</TableCell>
                  <TableCell className="text-center font-bold">{c.points}</TableCell>
                  <TableCell className="text-center text-xs text-muted-foreground hidden sm:table-cell">
                    {c.flagsFor}/{c.flagsAgainst}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <Card>
          <CardContent className="py-10 text-center">
            <BarChart3 className="size-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-muted-foreground text-sm">Sin datos suficientes todavía.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

const HISTORY_CACHE_KEY = "tkd-historial-cache";

function loadCachedHistory(): HistoryTournament[] | null {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as HistoryTournament[];
  } catch {
    return null;
  }
}

export function HistoryPage() {
  const [data, setData] = React.useState<HistoryTournament[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [fromCache, setFromCache] = React.useState(false);
  const [openId, setOpenId] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/history")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HistoryTournament[]>;
      })
      .then((d) => {
        if (cancelled) return;
        // Guardar en caché para uso offline
        try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(d)); } catch { /* quota */ }
        setData(d);
        setFromCache(false);
        const active = d.find((t) => t.isActive);
        if (active) setOpenId(active.id);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // Servidor offline — intentar mostrar datos guardados
        const cached = loadCachedHistory();
        if (cached) {
          setData(cached);
          setFromCache(true);
          setError(null);
          const active = cached.find((t) => t.isActive);
          if (active) setOpenId(active.id);
        } else {
          setError(e.message);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-4 max-w-3xl mx-auto w-full">
      <Tabs defaultValue="categories">
        {/* Header + tab switcher */}
        <div className="flex items-center gap-3 mb-4">
          <Trophy className="size-5 text-primary shrink-0" />
          <h1 className="text-lg font-bold flex-1">Historial</h1>
          <TabsList>
            <TabsTrigger value="categories" className="gap-1.5">
              <Swords className="size-3.5" />
              <span className="hidden sm:inline">Categorías</span>
              {data && <Badge variant="secondary" className="text-[10px] px-1 py-0">{data.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="stats" className="gap-1.5">
              <BarChart3 className="size-3.5" />
              <span className="hidden sm:inline">Estadísticas</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Banner: datos desde caché (servidor offline) */}
        {fromCache && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-3 text-xs text-amber-600 dark:text-amber-400">
            <WifiOff className="size-3.5 shrink-0" />
            <span>Servidor no disponible — mostrando datos guardados localmente.</span>
          </div>
        )}

        {/* ── Categorías tab ── */}
        <TabsContent value="categories" className="space-y-3 mt-0">
          {loading && (
            <div className="flex items-center justify-center gap-3 text-muted-foreground py-16">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-sm">Cargando historial…</span>
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center gap-3 text-destructive py-16">
              <AlertCircle className="size-5" />
              <span className="text-sm">Error al cargar historial: {error}</span>
            </div>
          )}
          {!loading && !error && (!data || data.length === 0) && (
            <Card>
              <CardContent className="py-12 text-center">
                <Swords className="size-10 mx-auto mb-3 text-muted-foreground/40" />
                <p className="text-muted-foreground">Todavía no hay categorías registradas.</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Las categorías aparecen aquí después de su primer combate.
                </p>
              </CardContent>
            </Card>
          )}
          {data?.map((t) => {
            const isOpen = openId === t.id;
            const allDone = t.fightsCompleted === t.fightsTotal && t.fightsTotal > 0;
            return (
              <Card key={t.id} className={cn("transition-all", t.isActive && "ring-1 ring-primary/40")}>
                <CardHeader
                  className="py-3 px-4 cursor-pointer select-none"
                  onClick={() => setOpenId(isOpen ? null : t.id)}
                >
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    {isOpen
                      ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    }
                    <span className="truncate flex-1">
                      {t.category || t.name || `Categoría #${t.id}`}
                    </span>
                    {t.isActive && (
                      <Badge className="bg-green-700/30 text-green-400 border-green-700/50 text-[10px] px-1.5 py-0 shrink-0">
                        En curso
                      </Badge>
                    )}
                    {!t.isActive && allDone && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                        ✓ Finalizada
                      </Badge>
                    )}
                  </CardTitle>
                  <div className="flex items-center gap-3 mt-1 ml-6 text-xs text-muted-foreground">
                    {t.name && t.name !== t.category && (
                      <span className="truncate">{t.name}</span>
                    )}
                    <span className="flex items-center gap-1 shrink-0">
                      <CalendarDays className="size-3" />{formatDate(t.createdAt)}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <Swords className="size-3" />{t.fightsCompleted}/{t.fightsTotal} combates
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <Users className="size-3" />{t.competitors.length}
                    </span>
                  </div>
                </CardHeader>
                {isOpen && (
                  <CardContent className="px-4 pb-4">
                    <TournamentDetail tournament={t} />
                  </CardContent>
                )}
              </Card>
            );
          })}
        </TabsContent>

        {/* ── Estadísticas tab ── */}
        <TabsContent value="stats" className="mt-0">
          <StatsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
