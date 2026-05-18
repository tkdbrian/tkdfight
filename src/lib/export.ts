import type { FightEntry, CompetitorEntry, TournamentConfig } from "@/store/tournament";

interface Standing {
  id: string;
  name: string;
  team?: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
}

function computeStandings(fights: FightEntry[], competitors: CompetitorEntry[]): Standing[] {
  const map = new Map<string, Standing>();
  for (const c of competitors) {
    map.set(c.id, { id: c.id, name: c.name, team: c.team, played: 0, wins: 0, losses: 0, draws: 0, points: 0 });
  }
  for (const f of fights) {
    if (!f.completed) continue;
    const red = map.get(f.red.id);
    const blue = map.get(f.blue.id);
    if (!red || !blue) continue;
    red.played++;
    blue.played++;
    if (f.winner === "red") { red.wins++; red.points += 3; blue.losses++; }
    else if (f.winner === "blue") { blue.wins++; blue.points += 3; red.losses++; }
    else { red.draws++; red.points += 1; blue.draws++; blue.points += 1; }
  }
  return [...map.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses);
}

export function exportTournamentHTML(
  fights: FightEntry[],
  competitors: CompetitorEntry[],
  config: TournamentConfig
): void {
  const standings = computeStandings(fights, competitors);
  const completed = fights.filter((f) => f.completed);
  const date = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" });

  const podiumRows = standings.slice(0, 3).map((s, i) => {
    const medal = ["🥇", "🥈", "🥉"][i];
    return `<tr class="podium-${i + 1}"><td>${medal}</td><td><strong>${s.name}</strong></td><td>${s.team ?? "—"}</td><td>${s.wins}G / ${s.losses}P</td></tr>`;
  }).join("\n");

  const standingRows = standings.map((s, i) =>
    `<tr><td>${i + 1}</td><td>${s.name}</td><td>${s.team ?? "—"}</td><td>${s.played}</td><td><strong>${s.points}</strong></td><td>${s.wins}</td><td>${s.losses}</td><td>${s.draws}</td></tr>`
  ).join("\n");

  const fightRows = completed.map((f, i) => {
    let winner: string;
    if (f.winner === "red") winner = f.red.name;
    else if (f.winner === "blue") winner = f.blue.name;
    else winner = "Empate";
    return `<tr><td>${i + 1}</td><td>${f.red.name}</td><td>${f.blue.name}</td><td>${winner}</td><td>${f.winReason ?? "—"}</td></tr>`;
  }).join("\n");

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resultados — ${config.categoryName || "Categoría TKD"}</title>
<style>
  :root { --gold: #f59e0b; --silver: #94a3b8; --bronze: #b45309; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; background: #0f172a; color: #e2e8f0; }
  h1 { color: #f59e0b; margin-bottom: 0.25rem; }
  .subtitle { color: #94a3b8; font-size: 0.875rem; margin-bottom: 2rem; }
  h2 { border-bottom: 1px solid #334155; padding-bottom: 0.5rem; margin-top: 2.5rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #1e293b; font-size: 0.875rem; }
  th { background: #1e293b; color: #94a3b8; font-weight: 600; }
  tr:hover td { background: #1e293b; }
  .podium-1 td { color: var(--gold); font-size: 1rem; }
  .podium-2 td { color: var(--silver); }
  .podium-3 td { color: var(--bronze); }
  @media print { body { background: white; color: black; } th { background: #f1f5f9; color: #334155; } }
</style>
</head>
<body>
<h1>🥋 ${config.categoryName || "Categoría Taekwondo"}</h1>
<p class="subtitle">Generado el ${date} · ${completed.length} combates · ${competitors.length} competidores</p>

<h2>🏆 Podio</h2>
<table>
  <thead><tr><th>#</th><th>Nombre</th><th>Equipo</th><th>Balance</th></tr></thead>
  <tbody>${podiumRows}</tbody>
</table>

<h2>📊 Clasificación completa</h2>
<table>
  <thead><tr><th>Pos</th><th>Nombre</th><th>Equipo</th><th>PJ</th><th style="color:var(--gold)">Pts</th><th>PG</th><th>PP</th><th>PE</th></tr></thead>
  <tbody>${standingRows}</tbody>
</table>

<h2>📋 Combates</h2>
<table>
  <thead><tr><th>#</th><th>Rojo</th><th>Azul</th><th>Ganador</th><th>Motivo</th></tr></thead>
  <tbody>${fightRows}</tbody>
</table>

<p style="margin-top:3rem;color:#475569;font-size:0.75rem;text-align:center">TKD Fight · tkdfight.onrender.com · Open source</p>
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `resultados_${(config.categoryName || "categoria").replaceAll(" ", "_")}.html`;
  a.click();
  URL.revokeObjectURL(url);
}
