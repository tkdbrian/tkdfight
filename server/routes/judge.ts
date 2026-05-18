import type { Router } from 'express'

export function registerJudgeRoute(router: Router) {
  router.get('/judge', (req, res) => {
    const judgeNum = Number.parseInt((req.query.id as string) ?? '1', 10)
    const safeNum = judgeNum >= 1 && judgeNum <= 4 ? judgeNum : 1
    const judgeId = `J${safeNum}`
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Juez ${safeNum} \u2014 TKD</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;background:#111;color:#fff;min-height:100dvh;display:flex;flex-direction:column;align-items:stretch;padding:12px 10px;gap:10px}
  h1{font-size:1.4rem;font-weight:900;text-align:center;letter-spacing:.04em;color:#2ecc71}
  .subtitle{font-size:.8rem;color:#aaa;text-align:center}
  .status{font-size:.75rem;text-align:center;padding:4px 10px;border-radius:20px;background:#1e1e1e;align-self:center}
  .phase-badge{text-align:center;font-size:.75rem;background:#222;border-radius:8px;padding:4px 10px;color:#aaa;align-self:center}
  .header-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:4px;margin-top:4px}
  .hdr-side{text-align:center;font-size:1rem;font-weight:900;text-transform:uppercase;letter-spacing:.04em;padding:8px 0;border-radius:8px}
  .hdr-side.red{background:#c0392b;color:#fff}
  .hdr-side.blue{background:#1a5fa8;color:#fff}
  .hdr-center{font-size:1rem;font-weight:900;color:#aaa;text-align:center;padding:0 6px}
  .score-row{display:grid;grid-template-columns:1fr 1fr auto 1fr 1fr;align-items:center;gap:6px}
  .score-row .level{font-size:2.2rem;font-weight:900;text-align:center;color:#fff;min-width:36px}
  .s-btn{width:100%;padding:14px 0;font-size:1.8rem;font-weight:900;border:none;border-radius:12px;cursor:pointer;transition:transform .06s;line-height:1;text-align:center}
  .s-btn:active{transform:scale(.92)}
  .s-btn.plus.red{background:#c0392b;color:#fff}
  .s-btn.minus.red{background:#1e1e1e;color:#e74c3c;border:2px solid #7b1a1a}
  .s-btn.plus.blue{background:#1a5fa8;color:#fff}
  .s-btn.minus.blue{background:#1e1e1e;color:#63b3ed;border:2px solid #0d2d5c}
  .s-btn:disabled{opacity:.3;cursor:default}
  .totals-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;background:#1a1a1a;border-radius:12px;padding:10px 16px;margin-top:2px}
  .total-side{text-align:center}
  .total-side .t-score{font-size:3rem;font-weight:900;line-height:1}
  .total-side.red .t-score{color:#e74c3c}
  .total-side.blue .t-score{color:#3498db}
  .total-label{font-size:.9rem;font-weight:700;color:#555;text-align:center}
  .undo-row{display:flex;align-items:center;gap:10px;justify-content:center;margin-top:2px}
  .undo-btn{padding:10px 20px;font-size:.9rem;font-weight:700;border:2px solid #555;border-radius:12px;background:#1e1e1e;color:#aaa;cursor:pointer}
  .undo-btn:active{background:#333}
  .undo-btn:disabled{opacity:.35;cursor:default}
  .undo-last{font-size:.72rem;color:#666;flex:1;text-align:left}
  .wait-msg{text-align:center;color:#f90;font-size:.9rem;padding:16px;display:none}
</style>
</head>
<body>
<h1>JUEZ ${safeNum}</h1>
<div class="subtitle" id="subtitle">Esperando combate...</div>
<div class="status" id="status">Conectando...</div>
<div class="phase-badge" id="phase">\u2014</div>
<div class="header-row">
  <div class="hdr-side red" id="hdr-red">ROJO</div>
  <div class="hdr-center">Puntos</div>
  <div class="hdr-side blue" id="hdr-blue">AZUL</div>
</div>
<div class="score-row">
  <button class="s-btn plus red" onclick="score('red','pts_1',1)">+</button>
  <button class="s-btn minus red" onclick="unscore('red',1)">\u2212</button>
  <div class="level">1</div>
  <button class="s-btn minus blue" onclick="unscore('blue',1)">\u2212</button>
  <button class="s-btn plus blue" onclick="score('blue','pts_1',1)">+</button>
</div>
<div class="score-row">
  <button class="s-btn plus red" onclick="score('red','pts_2',2)">+</button>
  <button class="s-btn minus red" onclick="unscore('red',2)">\u2212</button>
  <div class="level">2</div>
  <button class="s-btn minus blue" onclick="unscore('blue',2)">\u2212</button>
  <button class="s-btn plus blue" onclick="score('blue','pts_2',2)">+</button>
</div>
<div class="score-row">
  <button class="s-btn plus red" onclick="score('red','pts_3',3)">+</button>
  <button class="s-btn minus red" onclick="unscore('red',3)">\u2212</button>
  <div class="level">3</div>
  <button class="s-btn minus blue" onclick="unscore('blue',3)">\u2212</button>
  <button class="s-btn plus blue" onclick="score('blue','pts_3',3)">+</button>
</div>
<div class="totals-row">
  <div class="total-side red"><div class="t-score" id="my-red">0</div></div>
  <div class="total-label">Total</div>
  <div class="total-side blue"><div class="t-score" id="my-blue">0</div></div>
</div>
<div class="undo-row">
  <button class="undo-btn" id="undo-btn" onclick="undoLast()" disabled>&#8629; Deshacer</button>
  <span class="undo-last" id="undo-last"></span>
</div>
<div class="wait-msg" id="wait-msg">Esperando que inicie el combate...</div>
<script>
  const JUDGE_ID = '${judgeId}';
  const socket = io(location.origin);
  let connected = false;
  let myRed = 0, myBlue = 0;
  const scoreHistory = [];
  const PHASE_LABELS = {idle:'\u2014',round:'Round',rest:'Descanso',overtime:'Pr\u00f3rroga',golden_point:'\u2605 Punto de Oro',penalties:'Penalidades',finished:'Finalizado'};
  const statusEl   = document.getElementById('status');
  const subtitleEl = document.getElementById('subtitle');
  const phaseEl    = document.getElementById('phase');
  const waitMsg    = document.getElementById('wait-msg');
  const myRedEl    = document.getElementById('my-red');
  const myBlueEl   = document.getElementById('my-blue');

  socket.on('connect', () => {
    socket.emit('judge:connect', { requestedId: JUDGE_ID }, (res) => {
      if (res.error) { statusEl.textContent = '\u274c ' + res.error; statusEl.style.color = '#e74c3c'; }
      else { connected = true; statusEl.textContent = '\u2705 ' + res.judgeId + ' listo'; statusEl.style.color = '#2ecc71'; }
    });
  });
  socket.on('disconnect', () => { connected = false; statusEl.textContent = '\u26a0\ufe0f Reconectando...'; statusEl.style.color = '#f90'; });
  socket.on('state:update', (data) => {
    const m = data.match, ms = data.matchState;
    if (m) {
      subtitleEl.textContent = m.red.name + ' vs ' + m.blue.name;
      document.getElementById('hdr-red').textContent = m.red.name;
      document.getElementById('hdr-blue').textContent = m.blue.name;
    }
    if (ms) phaseEl.textContent = PHASE_LABELS[ms.phase] || ms.phase;
    const jt = data.judgeTotals && data.judgeTotals[JUDGE_ID];
    if (jt) { myRed = jt.red; myBlue = jt.blue; myRedEl.textContent = myRed; myBlueEl.textContent = myBlue; }
    const idle = !ms || ms.phase === 'idle' || ms.phase === 'finished';
    waitMsg.style.display = idle ? 'block' : 'none';
    document.querySelectorAll('.s-btn').forEach(b => b.disabled = idle);
  });
  function score(competitor, type, pts) {
    if (!connected) return;
    socket.emit('match:event', { judgeId: JUDGE_ID, competitor, type });
    if (competitor === 'red') { myRed += pts; myRedEl.textContent = myRed; }
    else { myBlue += pts; myBlueEl.textContent = myBlue; }
    scoreHistory.push({ competitor, pts, action: '+' });
    document.getElementById('undo-last').textContent = '\u00dalt: +' + pts + ' ' + (competitor === 'red' ? 'rojo' : 'azul');
    document.getElementById('undo-btn').disabled = false;
  }
  function unscore(competitor, pts) {
    if (!connected) return;
    const current = competitor === 'red' ? myRed : myBlue;
    if (current < pts) return;
    socket.emit('match:event', { judgeId: JUDGE_ID, competitor, type: 'subtract_' + pts });
    if (competitor === 'red') { myRed -= pts; myRedEl.textContent = myRed; }
    else { myBlue -= pts; myBlueEl.textContent = myBlue; }
    scoreHistory.push({ competitor, pts, action: '-' });
    document.getElementById('undo-last').textContent = '\u00dalt: -' + pts + ' ' + (competitor === 'red' ? 'rojo' : 'azul');
    document.getElementById('undo-btn').disabled = false;
  }
  function undoLast() {
    if (!connected || scoreHistory.length === 0) return;
    socket.emit('match:undo', { judgeId: JUDGE_ID });
    const last = scoreHistory.pop();
    if (last.action === '+') {
      if (last.competitor === 'red') { myRed = Math.max(0, myRed - last.pts); myRedEl.textContent = myRed; }
      else { myBlue = Math.max(0, myBlue - last.pts); myBlueEl.textContent = myBlue; }
    } else {
      if (last.competitor === 'red') { myRed += last.pts; myRedEl.textContent = myRed; }
      else { myBlue += last.pts; myBlueEl.textContent = myBlue; }
    }
    const prev = scoreHistory[scoreHistory.length - 1];
    document.getElementById('undo-last').textContent = prev ? '\u00dalt: ' + prev.action + prev.pts + ' ' + (prev.competitor === 'red' ? 'rojo' : 'azul') : '';
    document.getElementById('undo-btn').disabled = scoreHistory.length === 0;
  }
</script>
</body>
</html>`)
  })
}
