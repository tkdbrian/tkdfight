import express, { type NextFunction, type Request, type Response } from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
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
import { logger } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const server = createServer(app)

// ── CORS allow-list ──────────────────────────────────────────────────────────
// In production, ALLOWED_ORIGINS is a CSV (e.g. "https://tkdfight.onrender.com").
// In development we allow any localhost / LAN origin and reflect it back.

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const isDev = process.env.NODE_ENV !== 'production'

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true // same-origin / curl / server-to-server
  if (isDev) return true
  if (allowedOrigins.length === 0) return true // no allowlist configured → open
  if (allowedOrigins.includes('*')) return true
  return allowedOrigins.includes(origin)
}

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin)) cb(null, true)
      else cb(new Error(`Origin not allowed: ${origin}`))
    },
    methods: ['GET', 'POST'],
  },
})

const PORT = Number.parseInt(process.env.PORT ?? '3001', 10)
const localIp = getLocalIp()
// En producción (Render) usamos la URL pública; en LAN usamos la IP local.
const publicUrl = process.env.RENDER_EXTERNAL_URL ?? (allowedOrigins.length === 1 ? allowedOrigins[0] : null)
setServerUrl(publicUrl ?? `http://${localIp}:${PORT}`)

// ── Init DB ───────────────────────────────────────────────────────────────────

const latestTournament = getLatestTournament()
if (!latestTournament) {
  state.activeTournamentId = createTournament('Torneo', '')
} else {
  state.activeTournamentId = latestTournament.id
}

// ── Security headers ─────────────────────────────────────────────────────────
// `contentSecurityPolicy: false` so the SPA bundle and inline runtime work;
// SPA already serves only its own assets.

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
)

// ── CORS ─────────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.sendStatus(204); return }
  next()
})

// ── Rate limiting ────────────────────────────────────────────────────────────
// 200 req/min/IP on API routes. /health excluded so Render's healthcheck pings
// don't get throttled.

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
})
app.use('/api', apiLimiter)

// ── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => { res.json({ ok: true, uptime: process.uptime() }) })

// ── Routes ───────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '100kb' }))
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

// ── Global error handler ─────────────────────────────────────────────────────
// Must be the LAST middleware. Express 5 forwards async rejections here.

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ method: req.method, url: req.url, err: err.message }, 'request error')
  if (res.headersSent) return
  res.status(500).json({ error: 'Internal server error' })
})

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection')
})
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException')
})

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  logger.info(
    {
      local: `http://localhost:${PORT}`,
      red: `http://${localIp}:${PORT}`,
      judge: `http://${localIp}:${PORT}/judge`,
      cors: allowedOrigins.length ? allowedOrigins.join(', ') : isDev ? 'dev (open)' : 'none',
    },
    '🥋 TKD Scoring Server',
  )

  // Keep-alive: Render free tier duerme tras 15 min de inactividad.
  // Este ping propio cada 14 min lo mantiene despierto.
  const selfUrl = process.env.RENDER_EXTERNAL_URL
  if (selfUrl) {
    setInterval(() => {
      fetch(`${selfUrl}/health`).catch(() => {})
    }, 14 * 60 * 1000)
    logger.info({ url: `${selfUrl}/health` }, 'keep-alive activo')
  }
})

// ── Graceful shutdown ────────────────────────────────────────────────────────
// On SIGTERM (Render redeploy) close sockets and HTTP cleanly so in-flight
// writes flush before the process exits.

function shutdown(signal: string) {
  logger.info({ signal }, 'graceful shutdown')
  io.close()
  server.close((err) => {
    if (err) logger.error({ err }, 'server.close error during shutdown')
    process.exit(err ? 1 : 0)
  })
  // Force-exit fallback in case something hangs.
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
