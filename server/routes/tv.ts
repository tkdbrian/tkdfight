import type { Router } from 'express'

export function registerTvRoute(router: Router) {
  router.get('/tv-legacy', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pantalla TV \u2014 TKD</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Arial Black',Arial,sans-serif;background:#0a0a0a;color:#fff;min-height:100dvh;display:flex;flex-direction:column;overflow:hidden}
  .tv-header{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;background:#111;border-bottom:2px solid #1a1a1a}
  .tv-title{font-size:1.1rem;color:#718096;letter-spacing:.12em;text-transform:uppercase}
  .tv-match{font-size:1rem;color:#a0aec0}
  .tv-center{display:flex;flex-direction:column;align-items:center;padding:14px 0 6px}
  .tv-phase{font-size:1.3rem;font-weight:900;letter-spacing:.15em;text-transform:uppercase;color:#718096}
  .tv-round-num{font-size:.9rem;color:#a0aec0;margin-top:2px}
  .tv-clock{font-size:7rem;font-weight:900;letter-spacing:.04em;line-height:1;font-variant-numeric:tabular-nums;transition:color .3s}
  .tv-clock.warning{color:#f6e05e}
  .tv-clock.danger{color:#fc8181}
  .tv-board{display:flex;align-items:stretch;flex:1;gap:0}
  .tv-side{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px 32px}
  .tv-side.red{background:linear-gradient(160deg,#3d0a0a 0%,#1a0505 100%)}
  .tv-side.blue{background:linear-gradient(160deg,#0a1a3d 0%,#050a1a 100%)}
  .tv-comp-name{font-size:2.6rem;font-weight:900;text-align:center;text-transform:uppercase;letter-spacing:.04em;word-break:break-word}
  .tv-side.red .tv-comp-name{color:#fc8181}
  .tv-side.blue .tv-comp-name{color:#63b3ed}
  .tv-score{font-size:10rem;font-weight:900;line-height:1;font-variant-numeric:tabular-nums}
  .tv-side.red .tv-score{color:#fc5050}
  .tv-side.blue .tv-score{color:#3096f0}
  .tv-pen-row{display:flex;gap:14px;margin-top:8px}
  .tv-pen{display:flex;align-items:center;gap:6px;font-size:1rem;font-weight:700;opacity:.85}
  .tv-pen .icon{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:900}
  .tv-pen.warn .icon{background:#b7950b;color:#fff}
  .tv-pen.foul .icon{background:#922b21;color:#fff}
  .tv-pen .cnt{font-variant-numeric:tabular-nums}
  .tv-divider{width:4px;background:#222;align-self:stretch}
  .tv-judges{display:flex;justify-content:center;gap:8px;padding:12px 32px;background:#111;border-top:2px solid #1a1a1a}
  .tv-judge-dot{display:flex;flex-direction:column;align-items:center;gap:4px;font-size:.7rem;color:#4a5568;text-transform:uppercase;letter-spacing:.06em}
  .tv-judge-dot .dot{width:12px;height:12px;border-radius:50%;background:#2d3748}
  .tv-judge-dot.connected .dot{background:#2ecc71}
  .tv-winner-banner{display:none;position:fixed;inset:0;background:rgba(0,0,0,.88);align-items:center;justify-content:center;flex-direction:column;gap:20px;z-index:99}
  .tv-winner-banner.show{display:flex}
  .tv-winner-label{font-size:2rem;color:#a0aec0;letter-spacing:.2em;text-transform:uppercase}
  .tv-winner-name{font-size:5rem;font-weight:900;text-align:center}
  .tv-winner-name.red{color:#fc5050}
  .tv-winner-name.blue{color:#3096f0}
  .tv-winner-name.draw{color:#f6e05e}
</style>
</head>
<body>
<div class="tv-header">
  <div class="tv-title">\ud83e\udd4b TKD Tournament</div>
  <div class="tv-match" id="tv-match">\u2014</div>
</div>
<div class="tv-center">
  <div class="tv-phase" id="tv-phase">\u2014</div>
  <div class="tv-round-num" id="tv-round-num"></div>
  <div class="tv-clock" id="tv-clock">\u2014</div>
</div>
<div class="tv-board">
  <div class="tv-side red">
    <div class="tv-comp-name" id="tv-red-name">Rojo</div>
    <div class="tv-score" id="tv-red-score">0</div>
    <div class="tv-pen-row">
      <div class="tv-pen warn"><div class="icon">A</div><span class="cnt" id="tv-warn-red">0</span></div>
      <div class="tv-pen foul"><div class="icon">F</div><span class="cnt" id="tv-foul-red">0</span></div>
    </div>
  </div>
  <div class="tv-divider"></div>
  <div class="tv-side blue">
    <div class="tv-comp-name" id="tv-blue-name">Azul</div>
    <div class="tv-score" id="tv-blue-score">0</div>
    <div class="tv-pen-row">
      <div class="tv-pen warn"><div class="icon">A</div><span class="cnt" id="tv-warn-blue">0</span></div>
      <div class="tv-pen foul"><div class="icon">F</div><span class="cnt" id="tv-foul-blue">0</span></div>
    </div>
  </div>
</div>
<div class="tv-judges" id="tv-judges">
  <div class="tv-judge-dot" id="tv-jdot-J1"><div class="dot"></div>J1</div>
  <div class="tv-judge-dot" id="tv-jdot-J2"><div class="dot"></div>J2</div>
  <div class="tv-judge-dot" id="tv-jdot-J3"><div class="dot"></div>J3</div>
  <div class="tv-judge-dot" id="tv-jdot-J4"><div class="dot"></div>J4</div>
</div>
<div class="tv-winner-banner" id="tv-winner-banner">
  <div class="tv-winner-label">Ganador</div>
  <div class="tv-winner-name" id="tv-winner-name">\u2014</div>
</div>
<script>
  const PHASE = {idle:'\u2014',round:'Round',rest:'Descanso',overtime:'Pr\u00f3rroga',golden_point:'\u2605 Punto de Oro',penalties:'Penalidades',finished:'Finalizado'};
  const socket = io(location.origin);
  socket.on('state:update', data => {
    const ms = data.matchState, m = data.match;
    if (m) {
      document.getElementById('tv-red-name').textContent  = m.red.name;
      document.getElementById('tv-blue-name').textContent = m.blue.name;
      document.getElementById('tv-match').textContent = m.red.name + ' vs ' + m.blue.name;
    }
    if (ms) {
      document.getElementById('tv-phase').textContent = PHASE[ms.phase] || ms.phase;
      var roundEl = document.getElementById('tv-round-num');
      if (ms.phase === 'round' || ms.phase === 'rest') roundEl.textContent = 'Round ' + ms.currentRound;
      else roundEl.textContent = '';
      const clockEl = document.getElementById('tv-clock');
      if (ms.phase === 'round' || ms.phase === 'overtime' || ms.phase === 'rest') {
        const mm = Math.floor(ms.timeLeft / 60).toString().padStart(2,'0');
        const ss = (ms.timeLeft % 60).toString().padStart(2,'0');
        clockEl.textContent = mm + ':' + ss;
        clockEl.className = 'tv-clock' + (ms.timeLeft <= 10 ? ' danger' : ms.timeLeft <= 30 ? ' warning' : '');
      } else {
        clockEl.textContent = '\u2014';
        clockEl.className = 'tv-clock';
      }
      let red = 0, blue = 0;
      (ms.rounds || []).forEach(r => { red += r.totals.red || 0; blue += r.totals.blue || 0; });
      document.getElementById('tv-red-score').textContent  = red;
      document.getElementById('tv-blue-score').textContent = blue;
      const banner = document.getElementById('tv-winner-banner');
      const winnerNameEl = document.getElementById('tv-winner-name');
      if (ms.phase === 'finished' && ms.result) {
        const w = ms.result.winner;
        banner.className = 'tv-winner-banner show';
        if (w === 'red') { winnerNameEl.textContent = m ? m.red.name : 'Rojo'; winnerNameEl.className = 'tv-winner-name red'; }
        else if (w === 'blue') { winnerNameEl.textContent = m ? m.blue.name : 'Azul'; winnerNameEl.className = 'tv-winner-name blue'; }
        else { winnerNameEl.textContent = 'Empate'; winnerNameEl.className = 'tv-winner-name draw'; }
      } else {
        banner.className = 'tv-winner-banner';
      }
    }
    var pc = data.penaltyCounts;
    if (pc) {
      document.getElementById('tv-warn-red').textContent  = pc.warnings.red;
      document.getElementById('tv-warn-blue').textContent = pc.warnings.blue;
      document.getElementById('tv-foul-red').textContent  = pc.fouls.red;
      document.getElementById('tv-foul-blue').textContent = pc.fouls.blue;
    }
    const connected = data.judges || [];
    ['J1','J2','J3','J4'].forEach(jid => {
      const el = document.getElementById('tv-jdot-' + jid);
      if (el) el.className = 'tv-judge-dot' + (connected.includes(jid) ? ' connected' : '');
    });
  });
</script>
</body>
</html>`)
  })
}
