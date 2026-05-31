import type { FightEntry, CompetitorEntry, TournamentConfig, BracketMatch } from "@/store/tournament";

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

function roundLabel(round: number, maxRound: number, position: number): string {
  const fromEnd = maxRound - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinal";
  if (fromEnd === 2) return "Cuartos";
  if (fromEnd === 3) return "Octavos";
  return `Ronda ${round + 1}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function renderBracketHTML(matches: BracketMatch[]): string {
  if (matches.length === 0) return "";
  const groupedByRound = new Map<number, BracketMatch[]>();
  for (const m of matches) {
    if (!groupedByRound.has(m.round)) groupedByRound.set(m.round, []);
    groupedByRound.get(m.round)!.push(m);
  }
  const rounds = [...groupedByRound.entries()].sort(([a], [b]) => a - b);
  const maxRound = Math.max(...rounds.map(([r]) => r));

  const columns = rounds.map(([round, ms]) => {
    const sorted = [...ms].sort((a, b) => a.position - b.position);
    const matchesHtml = sorted.map((m, i) => {
      const redName = m.red.competitor?.name ?? (m.red.fromMatchId ? "—" : "BYE");
      const blueName = m.blue.competitor?.name ?? (m.blue.fromMatchId ? "—" : "BYE");
      const redIsWinner = m.completed && m.winnerId === m.red.competitor?.id;
      const blueIsWinner = m.completed && m.winnerId === m.blue.competitor?.id;
      const matchNum = matches.findIndex((x) => x.id === m.id) + 1;
      return `
        <div class="br-match">
          <div class="br-match-num">${matchNum}</div>
          <div class="br-slot ${redIsWinner ? "br-winner" : ""}">${escapeHtml(redName)}</div>
          <div class="br-slot ${blueIsWinner ? "br-winner" : ""}">${escapeHtml(blueName)}</div>
        </div>
      `;
    }).join("\n");
    return `
      <div class="br-column">
        <div class="br-col-title">${roundLabel(round, maxRound, 0)}</div>
        <div class="br-matches">${matchesHtml}</div>
      </div>
    `;
  }).join("\n");

  return `
    <h2>🏗️ Bracket de Eliminación</h2>
    <div class="bracket-wrap">${columns}</div>
  `;
}

export function exportTournamentHTML(
  fights: FightEntry[],
  competitors: CompetitorEntry[],
  config: TournamentConfig,
  bracketMatches: BracketMatch[] = []
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

  const isElimination = config.mode === "elimination" && bracketMatches.length > 0;
  const bracketHtml = isElimination ? renderBracketHTML(bracketMatches) : "";

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
  /* Bracket */
  .bracket-wrap { display: flex; gap: 1.5rem; overflow-x: auto; padding: 1rem 0.25rem; }
  .br-column { flex-shrink: 0; min-width: 170px; display: flex; flex-direction: column; }
  .br-col-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; text-align: center; margin-bottom: 0.5rem; font-weight: 600; }
  .br-matches { display: flex; flex-direction: column; justify-content: space-around; flex: 1; gap: 0.75rem; }
  .br-match { position: relative; border: 1px solid #334155; border-radius: 6px; overflow: hidden; background: #1e293b; }
  .br-match-num { position: absolute; top: 50%; left: -20px; transform: translateY(-50%); font-size: 0.625rem; color: #64748b; font-family: monospace; }
  .br-slot { padding: 0.5rem 0.75rem; font-size: 0.8125rem; border-bottom: 1px solid #334155; color: #cbd5e1; }
  .br-slot:last-child { border-bottom: none; }
  .br-winner { color: #4ade80; font-weight: 700; background: rgba(34, 197, 94, 0.08); }
  @media print {
    body { background: white; color: black; }
    th { background: #f1f5f9; color: #334155; }
    .br-match { background: #f8fafc; border-color: #cbd5e1; }
    .br-slot { color: #1e293b; border-color: #e2e8f0; }
    .br-winner { color: #15803d; background: #dcfce7; }
    .br-col-title { color: #475569; }
    .bracket-wrap { overflow-x: visible; flex-wrap: wrap; }
  }
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

${bracketHtml}

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
