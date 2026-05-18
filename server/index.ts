import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { getLocalIp } from './helpers.js'
import { setServerUrl } from './broadcast.js'
import { registerSocketHandlers } from './socket/handlers.js'
import { createTournament, getLatestTournament } from './db/index.js'
import { state } from './state.js'
import { registerJudgeRoute } from './routes/judge.js'
import { registerTvRoute } from './routes/tv.js'
import { registerQrRoute } from './routes/qr.js'
import { registerRingRoute } from './routes/ring.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)
const io = new Server(server, { cors: { origin: '*' } })

const PORT = Number.parseInt(process.env.PORT ?? '3001')
const localIp = getLocalIp()
setServerUrl(`http://${localIp}:${PORT}`)

// ── Init DB ───────────────────────────────────────────────────────────────────

const latestTournament = getLatestTournament()
if (!latestTournament) {
  state.activeTournamentId = createTournament('Torneo', '')
} else {
  state.activeTournamentId = latestTournament.id
}

// ── CORS ─────────────────────────────────────────────────────────────────────
// Mesa Central fetches /api/ring/queue cross-origin (different ports on same LAN).
// Without these headers the browser silently blocks the response.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (_req.method === 'OPTIONS') { res.sendStatus(200); return }
  next()
})

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => { res.json({ ok: true }) })

// ── Routes ───────────────────────────────────────────────────────────────────

app.use(express.json())
registerJudgeRoute(app)
registerTvRoute(app)
registerQrRoute(app)
registerRingRoute(app, io)

// ── Socket ───────────────────────────────────────────────────────────────────

registerSocketHandlers(io)

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
  console.log(`   Red:     http://${localIp}:${PORT}`)
  console.log(`   Juez:    http://${localIp}:${PORT}/judge\n`)

  // Keep-alive: Render free tier duerme tras 15 min de inactividad.
  // Este ping propio cada 14 min lo mantiene despierto.
  const selfUrl = process.env.RENDER_EXTERNAL_URL
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/health`).catch(() => {})
    }, 14 * 60 * 1000)
    console.log(`   Keep-alive activo → ${selfUrl}/health`)
  }
})
