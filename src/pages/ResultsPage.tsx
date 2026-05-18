import { useTournamentStore } from "@/store/tournament";
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
import { exportTournamentHTML } from "@/lib/export";

interface Standing {
  competitor: { id: string; name: string; team?: string };
  wins: number;
  losses: number;
  draws: number;
  fought: number;
  points: number;
}

function computeStandings(
  fights: ReturnType<typeof useTournamentStore.getState>["fights"]
): Standing[] {
  const map = new Map<string, Standing>();

  for (const f of fights) {
    for (const side of ["red", "blue"] as const) {
      const c = f[side];
      if (!map.has(c.id)) {
        map.set(c.id, { competitor: c, wins: 0, losses: 0, draws: 0, fought: 0, points: 0 });
      }
    }
    if (!f.completed) continue;
    const redStanding = map.get(f.red.id);
    const blueStanding = map.get(f.blue.id);
    if (!redStanding || !blueStanding) continue;
    redStanding.fought++;
    blueStanding.fought++;
    if (f.winner === "red") {
      redStanding.wins++;
      redStanding.points += 3;
      blueStanding.losses++;
    } else if (f.winner === "blue") {
      blueStanding.wins++;
      blueStanding.points += 3;
      redStanding.losses++;
    } else {
      redStanding.draws++;
      redStanding.points += 1;
      blueStanding.draws++;
      blueStanding.points += 1;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.losses - b.losses;
  });
}

export function ResultsPage() {
  const { fights, competitors, config, reset } = useTournamentStore(
    useShallow((s) => ({ fights: s.fights, competitors: s.competitors, config: s.config, reset: s.reset }))
  );
  const standings = computeStandings(fights);
  const completed = fights.filter((f) => f.completed).length;
  const total = fights.length;

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
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">
            {completed} / {total} combates
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportTournamentHTML(fights, competitors, config)}
            disabled={completed === 0}
          >
            <Download className="size-3.5" />
            Exportar HTML
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            className="text-destructive border-destructive/50 hover:bg-destructive/10"
          >
            <RotateCcw className="size-4" />
            Nueva categoría
          </Button>
        </div>
      </div>

      {/* Podio */}
      {standings.length >= 1 && completed > 0 && (
        <div className="grid grid-cols-3 gap-3 items-end">
          {standings[1] ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-secondary/20 p-4 mt-4">
              <div className="text-4xl">🥈</div>
              <p className="font-bold text-sm text-center text-gray-300 truncate max-w-full">{standings[1].competitor.name}</p>
              {standings[1].competitor.team && (
                <p className="text-xs text-muted-foreground text-center truncate w-full">{standings[1].competitor.team}</p>
              )}
              <Badge variant="secondary">{standings[1].points} pts</Badge>
            </div>
          ) : <div />}
          <div className="flex flex-col items-center gap-2 rounded-xl border border-yellow-700/40 bg-yellow-950/20 p-5">
            <div className="text-5xl">🥇</div>
            <p className="font-bold text-base text-center text-yellow-300 truncate max-w-full">{standings[0].competitor.name}</p>
            {standings[0].competitor.team && (
              <p className="text-xs text-yellow-600 text-center truncate w-full">{standings[0].competitor.team}</p>
            )}
            <Badge className="bg-yellow-600 text-yellow-950 border-0 hover:bg-yellow-600">{standings[0].points} pts</Badge>
          </div>
          {standings[2] ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-secondary/20 p-4 mt-4">
              <div className="text-4xl">🥉</div>
              <p className="font-bold text-sm text-center text-amber-600 truncate max-w-full">{standings[2].competitor.name}</p>
              {standings[2].competitor.team && (
                <p className="text-xs text-muted-foreground text-center truncate w-full">{standings[2].competitor.team}</p>
              )}
              <Badge variant="secondary">{standings[2].points} pts</Badge>
            </div>
          ) : <div />}
        </div>
      )}

      {/* Standings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clasificación</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Competidor</TableHead>
                <TableHead className="text-center font-bold text-yellow-400">Pts</TableHead>
                <TableHead className="text-center">G</TableHead>
                <TableHead className="text-center">E</TableHead>
                <TableHead className="text-center">P</TableHead>
                <TableHead className="text-center">PJ</TableHead>
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
                        i === 2 && "text-amber-600"
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
                  <TableCell className="text-center font-black text-yellow-400 text-base">
                    {s.points}
                  </TableCell>
                  <TableCell className="text-center text-green-400 font-bold">
                    {s.wins}
                  </TableCell>
                  <TableCell className="text-center text-muted-foreground">
                    {s.draws}
                  </TableCell>
                  <TableCell className="text-center text-red-400 font-bold">
                    {s.losses}
                  </TableCell>
                  <TableCell className="text-center text-muted-foreground">
                    {s.fought}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Fight log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Combates</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {fights.map((f, i) => {
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
              const hasFlags =
                (f.flagsRed ?? 0) > 0 || (f.flagsBlue ?? 0) > 0;

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
                            "text-xs",
                            f.winner === "draw"
                              ? "bg-secondary text-secondary-foreground"
                              : "bg-primary/20 text-primary border-primary/30"
                          )}
                        >
                          {winnerName ? `${winnerName} ganó` : "Empate"}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{reasonLabel}</span>
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
