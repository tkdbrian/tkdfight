import { useTournamentStore } from "@/store/tournament";
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
import { Trophy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { WIN_REASON_LABELS } from "@/lib/fight-utils";

interface Standing {
  competitor: { id: string; name: string; team?: string };
  wins: number;
  losses: number;
  draws: number;
  fought: number;
}

function computeStandings(
  fights: ReturnType<typeof useTournamentStore.getState>["fights"]
): Standing[] {
  const map = new Map<string, Standing>();

  for (const f of fights) {
    for (const side of ["red", "blue"] as const) {
      const c = f[side];
      if (!map.has(c.id)) {
        map.set(c.id, { competitor: c, wins: 0, losses: 0, draws: 0, fought: 0 });
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
      blueStanding.losses++;
    } else if (f.winner === "blue") {
      blueStanding.wins++;
      redStanding.losses++;
    } else {
      redStanding.draws++;
      blueStanding.draws++;
    }
  }

  return [...map.values()].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.losses - b.losses;
  });
}

export function ResultsPage() {
  const { fights, competitors, config, reset } = useTournamentStore();
  const standings = computeStandings(fights);
  const completed = fights.filter((f) => f.completed).length;
  const total = fights.length;

  return (
    <div className="flex-1 overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="size-6 text-yellow-400" />
            Resultados
          </h1>
          {config.categoryName && (
            <p className="text-muted-foreground text-sm mt-0.5">{config.categoryName}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {completed} / {total} combates
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            className="text-destructive border-destructive/50 hover:bg-destructive/10"
          >
            <RotateCcw className="size-4" />
            Nuevo torneo
          </Button>
        </div>
      </div>

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
                <TableHead className="text-center">G</TableHead>
                <TableHead className="text-center">E</TableHead>
                <TableHead className="text-center">P</TableHead>
                <TableHead className="text-center">Combates</TableHead>
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
            {fights.map((f, i) => (
              <div
                key={f.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-border px-4 py-2.5 text-sm",
                  f.completed ? "opacity-100" : "opacity-50"
                )}
              >
                <span className="text-muted-foreground w-6 text-right">{i + 1}</span>
                <span
                  className={cn(
                    "flex-1 font-medium",
                    f.winner === "red" && "text-red-400 font-bold"
                  )}
                >
                  {f.red.name}
                </span>
                <div className="text-center min-w-20">
                  {f.completed ? (
                    <Badge
                      className={cn(
                        "text-xs",
                        f.winner === "draw" ? "bg-secondary" : ""
                      )}
                    >
                      {f.winner === "draw"
                        ? "Empate"
                        : WIN_REASON_LABELS[f.winReason ?? ""] ?? f.winReason}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">pendiente</span>
                  )}
                </div>
                <span
                  className={cn(
                    "flex-1 text-right font-medium",
                    f.winner === "blue" && "text-blue-400 font-bold"
                  )}
                >
                  {f.blue.name}
                </span>
              </div>
            ))}
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
