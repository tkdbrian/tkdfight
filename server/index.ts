import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import os from 'node:os'
import QRCode from 'qrcode'
import {
  createMatch,
  startPhase,
  addMatchEvent,
  tick,
  endPhase,
  resolveJury,
  confirmPenalties,
  undoLastEvent,
} from '../src/engine/match-machine'
import type { Competitor, MatchState, RuleSetSparring } from '../src/engine/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)
const io = new Server(server, {
  cors: { origin: '*' },
})

// ── State ────────────────────────────────────────────────────────────────────

type MatchInfo = {
  id: string
  ringId: string
  red: { id: string; name: string; club?: string }
  blue: { id: string; name: string; club?: string }
}

let rules: RuleSetSparring | null = null
let match: MatchInfo | null = null
let matchState: MatchState | null = null
let matchPaused = false
const judges = new Map<string, string>()     // socketId → judgeId
const judgeVotes = new Map<string, string>()  // judgeId  → 'red'|'tie'|'blue'
let nextJudgeNum = 1
let tickInterval: ReturnType<typeof setInterval> | null = null

type FalloEntry = { id: number; time: string; redName: string; blueName: string; redScore: number; blueScore: number; winner: string }
const fallos: FalloEntry[] = []
let falloSeq = 1

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLocalIp(): string {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return 'localhost'
}

const PORT = parseInt(process.env.PORT ?? '3001')
const localIp = getLocalIp()
const serverUrl = `http://${localIp}:${PORT}`

function computeJudgeTotals(): Record<string, { red: number; blue: number; redFav: number; blueFav: number; redContra: number; blueContra: number }> {
  const totals: Record<string, { red: number; blue: number; redFav: number; blueFav: number; redContra: number; blueContra: number }> = {}
  if (!matchState) return totals
  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId === 'arbiter') continue
      if (!totals[ev.judgeId]) totals[ev.judgeId] = { red: 0, blue: 0, redFav: 0, blueFav: 0, redContra: 0, blueContra: 0 }
      const t = totals[ev.judgeId]
      if (ev.value > 0) {
        t[ev.competitor === 'red' ? 'redFav' : 'blueFav'] += ev.value
      } else if (ev.value < 0) {
        t[ev.competitor === 'red' ? 'redContra' : 'blueContra'] += Math.abs(ev.value)
      }
    }
  }
  // Compute net totals, clamp at 0
  for (const t of Object.values(totals)) {
    t.red = Math.max(0, t.redFav - t.redContra)
    t.blue = Math.max(0, t.blueFav - t.blueContra)
  }
  return totals
}

function computePenaltyCounts(): { warnings: { red: number; blue: number }; fouls: { red: number; blue: number } } {
  const warnings = { red: 0, blue: 0 }
  const fouls = { red: 0, blue: 0 }
  if (!matchState) return { warnings, fouls }
  for (const round of matchState.rounds) {
    for (const ev of round.events) {
      if (ev.judgeId !== 'arbiter') continue
      if (ev.type === 'warning_minor' || ev.type === 'warning_serious') {
        warnings[ev.competitor] += 1
      } else if (ev.type === 'minus_point') {
        fouls[ev.competitor] += 1
      }
    }
  }
  return { warnings, fouls }
}

function broadcast() {
  io.emit('state:update', {
    rules,
    match,
    matchState,
    matchPaused,
    judges: Array.from(judges.values()),
    judgeVotes: Object.fromEntries(judgeVotes),
    judgeTotals: computeJudgeTotals(),
    penaltyCounts: computePenaltyCounts(),
    fallos: [...fallos],
    serverUrl,
  })
}

// ── Timer ────────────────────────────────────────────────────────────────────

function startTicker() {
  if (tickInterval) return
  tickInterval = setInterval(() => {
    if (!matchState || !rules || matchPaused) return
    const phase = matchState.phase
    if (phase === 'round' || phase === 'overtime') {
      matchState = tick(matchState, rules)
      broadcast()
    } else if (phase === 'rest') {
      if (matchState.timeLeft > 0) {
        matchState = { ...matchState, timeLeft: matchState.timeLeft - 1 }
        broadcast()
      }
    }
  }, 1000)
}

function stopTicker() {
  if (tickInterval) {
    clearInterval(tickInterval)
    tickInterval = null
  }
}

// ── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Send current state on connect
  socket.emit('state:update', {
    rules,
    match,
    matchState,
    judges: Array.from(judges.values()),
    judgeVotes: Object.fromEntries(judgeVotes),
    serverUrl,
  })

  socket.on('judge:connect', (data: { requestedId?: string } | null, callback: (r: { judgeId?: string; error?: string }) => void) => {
    const maxJudges = rules?.judgesCount ?? 5
    if (judges.size >= maxJudges) {
      callback({ error: 'Máximo de jueces alcanzado' })
      return
    }
    const requested = data?.requestedId
    if (requested) {
      const alreadyTaken = Array.from(judges.values()).includes(requested)
      if (alreadyTaken) {
        callback({ error: `${requested} ya está ocupado` })
        return
      }
      judges.set(socket.id, requested)
      callback({ judgeId: requested })
    } else {
      const judgeId = `J${nextJudgeNum++}`
      judges.set(socket.id, judgeId)
      callback({ judgeId })
    }
    broadcast()
  })

  socket.on('match:load', (data: { rules: RuleSetSparring; match: MatchInfo }) => {
    rules = data.rules
    match = data.match
    matchState = createMatch(rules)
    nextJudgeNum = 1
    judges.clear()
    judgeVotes.clear()
    stopTicker()
    broadcast()
  })

  socket.on('match:start', () => {
    if (!matchState || !rules) return
    const phase = matchState.phase
    if (phase === 'idle' || phase === 'rest') {
      matchState = startPhase(matchState, rules)
      startTicker()
      broadcast()
    }
  })

  socket.on('match:event', (data: { judgeId: string; competitor: Competitor; type: string }) => {
    if (!matchState || !rules) return
    matchState = addMatchEvent(matchState, data, rules)
    broadcast()
  })

  socket.on('match:finishRound', () => {
    if (!matchState || !rules) return
    if (matchState.phase !== 'round' && matchState.phase !== 'overtime') return
    matchPaused = false
    matchState = endPhase({ ...matchState, timeLeft: 0 }, rules)
    // Si el combate terminó, guardar fallo automáticamente
    if (matchState.phase === 'finished') {
      const jt = computeJudgeTotals()
      let redTotal = 0, blueTotal = 0
      for (const v of Object.values(jt)) { redTotal += v.red; blueTotal += v.blue }
      const now = new Date()
      const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0')
      const winner = redTotal > blueTotal ? 'red' : blueTotal > redTotal ? 'blue' : 'draw'
      fallos.push({ id: falloSeq++, time: timeStr, redName: match?.red.name ?? 'Rojo', blueName: match?.blue.name ?? 'Azul', redScore: redTotal, blueScore: blueTotal, winner })
    }
    broadcast()
  })

  socket.on('match:confirmPenalties', () => {
    if (!matchState || !rules) return
    if (matchState.phase !== 'penalties') return
    matchState = confirmPenalties(matchState, rules)
    broadcast()
  })

  socket.on('match:resolveJury', (data: { winner: Competitor }) => {
    if (!matchState) return
    matchState = resolveJury(matchState, data.winner)
    broadcast()
  })

  socket.on('match:reset', () => {
    if (!rules) return
    matchState = createMatch(rules)
    judgeVotes.clear()
    stopTicker()
    broadcast()
  })

  socket.on('judge:vote', (data: { judgeId: string; vote: string }) => {
    const myJudgeId = judges.get(socket.id)
    if (!myJudgeId || myJudgeId !== data.judgeId) return
    if (!['red', 'tie', 'blue'].includes(data.vote)) return
    judgeVotes.set(data.judgeId, data.vote)
    broadcast()
  })

  socket.on('match:undo', (data: { judgeId: string }) => {
    if (!matchState) return
    const myJudgeId = judges.get(socket.id)
    if (!myJudgeId || myJudgeId !== data.judgeId) return
    matchState = undoLastEvent(matchState, data.judgeId)
    broadcast()
  })

  socket.on('match:pause', () => {
    if (!matchState || matchPaused) return
    if (matchState.phase !== 'round' && matchState.phase !== 'overtime') return
    matchPaused = true
    broadcast()
  })

  socket.on('match:resume', () => {
    if (!matchState || !matchPaused) return
    matchPaused = false
    broadcast()
  })

  socket.on('match:dq', (data: { competitor: Competitor }) => {
    if (!matchState || !rules) return
    if (!['red', 'blue'].includes(data.competitor)) return
    // DQ: añadir evento de descalificación y terminar la fase
    matchState = addMatchEvent(matchState, { judgeId: 'arbiter', competitor: data.competitor, type: 'disqualify' }, rules)
    matchPaused = false
    matchState = endPhase({ ...matchState, timeLeft: 0 }, rules)
    stopTicker()
    // Registrar en fallos
    const jt = computeJudgeTotals()
    let redTotal = 0, blueTotal = 0
    for (const v of Object.values(jt)) { redTotal += v.red; blueTotal += v.blue }
    const now = new Date()
    const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0')
    fallos.push({ id: falloSeq++, time: timeStr, redName: match?.red.name ?? 'Rojo', blueName: match?.blue.name ?? 'Azul', redScore: redTotal, blueScore: blueTotal, winner: data.competitor === 'red' ? 'blue-dq' : 'red-dq' })
    broadcast()
  })

  socket.on('match:medical', (data: { competitor: Competitor }) => {
    if (!matchState || !rules) return
    if (!['red', 'blue'].includes(data.competitor)) return
    matchPaused = true
    broadcast()
  })

  socket.on('match:saveFallo', () => {
    if (!matchState) return
    const jt = computeJudgeTotals()
    let redTotal = 0, blueTotal = 0
    for (const v of Object.values(jt)) { redTotal += v.red; blueTotal += v.blue }
    const now = new Date()
    const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0')
    const winner = redTotal > blueTotal ? 'red' : blueTotal > redTotal ? 'blue' : 'draw'
    fallos.push({ id: falloSeq++, time: timeStr, redName: match?.red.name ?? 'Rojo', blueName: match?.blue.name ?? 'Azul', redScore: redTotal, blueScore: blueTotal, winner })
    broadcast()
  })

  socket.on('match:deleteFallo', (data: { id: number }) => {
    const idx = fallos.findIndex(f => f.id === data.id)
    if (idx !== -1) fallos.splice(idx, 1)
    broadcast()
  })

  socket.on('match:clearFallos', () => {
    fallos.length = 0
    broadcast()
  })

  socket.on('disconnect', () => {
    judges.delete(socket.id)
    broadcast()
  })
})

// ── Judge page ───────────────────────────────────────────────────────────────

app.get('/judge', (req, res) => {
  const judgeNum = parseInt((req.query.id as string) ?? '1', 10)
  const safeNum = (judgeNum >= 1 && judgeNum <= 4) ? judgeNum : 1
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
  /* Header con colores ROJO / Puntos / AZUL */
  .header-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:4px;margin-top:4px}
  .hdr-side{text-align:center;font-size:1rem;font-weight:900;text-transform:uppercase;letter-spacing:.04em;padding:8px 0;border-radius:8px}
  .hdr-side.red{background:#c0392b;color:#fff}
  .hdr-side.blue{background:#1a5fa8;color:#fff}
  .hdr-center{font-size:1rem;font-weight:900;color:#aaa;text-align:center;padding:0 6px}
  /* Scoring rows: +/- buttons */
  .score-row{display:grid;grid-template-columns:1fr 1fr auto 1fr 1fr;align-items:center;gap:6px}
  .score-row .level{font-size:2.2rem;font-weight:900;text-align:center;color:#fff;min-width:36px}
  .s-btn{width:100%;padding:14px 0;font-size:1.8rem;font-weight:900;border:none;border-radius:12px;cursor:pointer;transition:transform .06s;line-height:1;text-align:center}
  .s-btn:active{transform:scale(.92)}
  .s-btn.plus.red{background:#c0392b;color:#fff}
  .s-btn.minus.red{background:#1e1e1e;color:#e74c3c;border:2px solid #7b1a1a}
  .s-btn.plus.blue{background:#1a5fa8;color:#fff}
  .s-btn.minus.blue{background:#1e1e1e;color:#63b3ed;border:2px solid #0d2d5c}
  .s-btn:disabled{opacity:.3;cursor:default}
  /* Totals row */
  .totals-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;background:#1a1a1a;border-radius:12px;padding:10px 16px;margin-top:2px}
  .total-side{text-align:center}
  .total-side .t-score{font-size:3rem;font-weight:900;line-height:1}
  .total-side.red .t-score{color:#e74c3c}
  .total-side.blue .t-score{color:#3498db}
  .total-label{font-size:.9rem;font-weight:700;color:#555;text-align:center}
  /* Undo + wait */
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
  const statusEl  = document.getElementById('status');
  const subtitleEl= document.getElementById('subtitle');
  const phaseEl   = document.getElementById('phase');
  const waitMsg   = document.getElementById('wait-msg');
  const myRedEl   = document.getElementById('my-red');
  const myBlueEl  = document.getElementById('my-blue');

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
    // disable buttons when idle
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
    if (current < pts) return; // can't go negative
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
<\/script>
</body>
</html>`)
})

// ── TV screen ─────────────────────────────────────────────────────────────────

app.get('/tv', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="0">
<title>Pantalla TV — TKD</title>
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
    const ms = data.matchState;
    const m  = data.match;

    if (m) {
      document.getElementById('tv-red-name').textContent  = m.red.name;
      document.getElementById('tv-blue-name').textContent = m.blue.name;
      document.getElementById('tv-match').textContent = m.red.name + ' vs ' + m.blue.name;
    }

    if (ms) {
      document.getElementById('tv-phase').textContent = PHASE[ms.phase] || ms.phase;

      // Round number
      var roundEl = document.getElementById('tv-round-num');
      if (ms.phase === 'round' || ms.phase === 'rest') {
        roundEl.textContent = 'Round ' + ms.currentRound;
      } else {
        roundEl.textContent = '';
      }

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

    // Penalties
    var pc = data.penaltyCounts;
    if (pc) {
      document.getElementById('tv-warn-red').textContent  = pc.warnings.red;
      document.getElementById('tv-warn-blue').textContent = pc.warnings.blue;
      document.getElementById('tv-foul-red').textContent  = pc.fouls.red;
      document.getElementById('tv-foul-blue').textContent = pc.fouls.blue;
    }

    // Judge dots
    const connected = data.judges || [];
    ['J1','J2','J3','J4'].forEach(jid => {
      const el = document.getElementById('tv-jdot-' + jid);
      if (el) el.className = 'tv-judge-dot' + (connected.includes(jid) ? ' connected' : '');
    });
  });
<\/script>
</body>
</html>`)
})

// ── QR codes ─────────────────────────────────────────────────────────────────

app.get('/qr/:id', async (req, res) => {
  const judgeNum = parseInt(req.params.id, 10)
  if (judgeNum < 1 || judgeNum > 4) { res.status(400).end(); return }
  const url = `${serverUrl}/judge?id=${judgeNum}`
  try {
    const png = await QRCode.toBuffer(url, { width: 200, margin: 1, color: { dark: '#000000', light: '#ffffff' } })
    res.set('Content-Type', 'image/png').send(png)
  } catch {
    res.status(500).end()
  }
})

// ── Serve static build ───────────────────────────────────────────────────────

const distPath = path.join(__dirname, '..', 'dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🥋 TKD Scoring Server`)
  console.log(`   Local:   http://localhost:${PORT}`)
  console.log(`   Red:     ${serverUrl}`)
  console.log(`   Juez:    ${serverUrl}/judge\n`)
})
