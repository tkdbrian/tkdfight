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
import {
  createTournament,
  getActiveMatchLock,
  getCategoryTournamentId,
  getStartupTournamentId,
  getRetiredIdleTournamentId,
  getMatchResult,
  isFightPending,
  loadMatchSnapshot,
  setSelectedTournamentId,
} from './db/index.js'
import { state } from './state.js'
import { createMatch } from '../src/engine/match-machine.js'
import { recoverIndividualFlagMatchState, recoverTulPhase } from './recovery.js'
import type { RuleSetSparring, WinReason } from '../src/engine/types.js'
import type { MatchInfo } from './state.js'
import { registerJudgeRoute } from './routes/judge.js'
import { registerTvRoute } from './routes/tv.js'
import { registerQrRoute } from './routes/qr.js'
import { registerRingRoute } from './routes/ring.js'
import { registerCategoryRestartBodyParser } from './routes/category-restart.js'
import { registerCategoryDeletionBodyParser } from './routes/category-deletion.js'
import { registerHistoryRoute } from './routes/history.js'
import { registerPresetsRoute } from './routes/presets.js'
import { registerFullBackupRoutes } from './routes/full-backup.js'
import { logger } from './logger.js'
import { LocalRuntime, parseLocalRuntimeConfig, registerLocalRuntime } from './local-runtime.js'
import { getRestoreReceipt, isSqlIdle } from './db/full-backup.js'
import { stopTicker } from './timer.js'
import db from './db/index.js'

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
  // In portable mode (no Render deployment), allow all origins — judges connect from LAN IPs
  if (!process.env.RENDER_EXTERNAL_URL) return true
  // Always allow the server's own Render origin (browser sends Origin on same-origin socket.io POSTs)
  if (origin === process.env.RENDER_EXTERNAL_URL) return true
  if (allowedOrigins.includes('*')) return true
  if (allowedOrigins.length === 0) return false // prod sin allowlist → denegar cross-origin
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
let backupMaintenanceActive: () => boolean = () => false
const runtime = new LocalRuntime(parseLocalRuntimeConfig(process.env), PORT, () => {
  const reasons: string[] = []
  if (state.match && !state.resultConfirmed) reasons.push('loaded-match')
  if (getActiveMatchLock()) reasons.push('active-lock')
  if (!isSqlIdle()) reasons.push('pending-result')
  if (backupMaintenanceActive() || getRestoreReceipt()?.status === 'pending') reasons.push('maintenance')
  return reasons
}, () => shutdown('portable-supervisor', false))
registerLocalRuntime(app, io, runtime)
const localIp = getLocalIp()
// En producción (Render) usamos la URL pública; en modo portable siempre la IP local.
const publicUrl = process.env.RENDER_EXTERNAL_URL ?? null
setServerUrl(publicUrl ?? `http://${localIp}:${PORT}`)

// ── Init DB ───────────────────────────────────────────────────────────────────

const startupTournamentId = getStartupTournamentId()
const retiredIdleTournamentId = getRetiredIdleTournamentId()
state.activeTournamentId = startupTournamentId ?? retiredIdleTournamentId ?? createTournament('Torneo', '')
if (startupTournamentId !== null || retiredIdleTournamentId === null) setSelectedTournamentId(state.activeTournamentId)

// ── Restore emergency snapshot (si el servidor se reinició en medio de un combate) ─

try {
  const snapshot = loadMatchSnapshot()
  const lock = getActiveMatchLock()
  const operationalState = snapshot?.data?.matchState
    ? recoverIndividualFlagMatchState(snapshot.data) : null
  if (snapshot && lock && lock.fightId === snapshot.fightId) {
    if (!snapshot.categoryId || !snapshot.data || snapshot.corrupted
      || (snapshot.data.matchState && !operationalState)
      || ((snapshot.data.match?.goldenPoint || snapshot.data.match?.requireIndividualFlags) && !operationalState)) {
      state.matchCategoryId = snapshot.categoryId
      state.matchTournamentId = snapshot.tournamentId
      state.legacyMatchAssociationWarning = snapshot.categoryId === null
        ? `El combate ${snapshot.fightId} conserva un lock histórico sin categoryId; no se reasignó.`
        : `El snapshot del combate ${snapshot.fightId} no conserva todos los eventos de mesa; no se liberó ni se recontaron sanciones automáticamente.`
      logger.warn({ fightId: snapshot.fightId, categoryId: snapshot.categoryId, corrupted: snapshot.corrupted }, '[startup] Snapshot no recuperable; nuevas cargas bloqueadas')
    } else if (getCategoryTournamentId(snapshot.categoryId) === snapshot.tournamentId && isFightPending(snapshot.fightId, snapshot.tournamentId)) {
    const { match, rules, roundFlags, pendingResult } = snapshot.data
    const restoredRules = rules as RuleSetSparring
    const restoredMatch = { ...match, categoryId: snapshot.categoryId } as MatchInfo
    const completedRounds = roundFlags.length
    const totalRounds = restoredRules.rounds?.count ?? 2
    const restSeconds = restoredRules.rounds?.rest_seconds ?? 30
    state.activeTournamentId = snapshot.tournamentId
    state.match = restoredMatch
    state.matchCategoryId = snapshot.categoryId
    state.matchTournamentId = snapshot.tournamentId
    state.resultConfirmed = false
    state.tulPhase = recoverTulPhase(snapshot.data)
    state.legacyMatchAssociationWarning = null
    state.rules = restoredRules
    state.roundFlags = roundFlags.map((flag) => ({
      ...flag,
      draw: flag.draw ?? 0,
      winner: flag.winner as 'red' | 'blue' | 'draw',
      votes: flag.votes ?? {},
    }))
    if (restoredRules.judgingMode === 'flags' && !restoredMatch.goldenPoint) {
      for (let i = 1; i <= restoredRules.judgesCount; i++) {
        const judgeId = `J${i}`
        const vote = snapshot.data.judgeVotes?.[judgeId]
        if (vote === 'red' || vote === 'blue' || vote === 'draw') {
          state.judgeVotes.set(judgeId, vote)
        }
      }
    }
    const baseMatchState = createMatch(restoredRules)
    const storedResult = getMatchResult(snapshot.categoryId, snapshot.fightId)
    state.matchState = operationalState ?? {
      ...baseMatchState,
      phase: pendingResult || storedResult?.status === 'pending_confirmation'
        ? 'finished'
        : completedRounds > 0 ? 'rest' : 'idle',
      currentRound: Math.min(completedRounds + 1, totalRounds),
      timeLeft: pendingResult || storedResult?.status === 'pending_confirmation'
        ? 0
        : completedRounds > 0 ? restSeconds : 0,
      result: pendingResult
        ? { winner: pendingResult.winner, reason: pendingResult.reason as WinReason }
        : storedResult?.status === 'pending_confirmation'
          ? { winner: storedResult.winner, reason: storedResult.reason as WinReason }
          : null,
    }
    state.matchPaused = state.matchState.phase !== 'golden_point'
    logger.info({ fightId: snapshot.fightId, categoryId: snapshot.categoryId, completedRounds }, '[startup] Combate restaurado desde snapshot de emergencia')
    } else {
      state.matchCategoryId = snapshot.categoryId
      state.matchTournamentId = snapshot.tournamentId
      state.legacyMatchAssociationWarning = `No se pudo verificar la categoría del combate ${snapshot.fightId}; el lock se conserva.`
      logger.warn({ fightId: snapshot.fightId, categoryId: snapshot.categoryId }, '[startup] Asociación de categoría inválida; nuevas cargas bloqueadas')
    }
  } else if (lock) {
    state.matchCategoryId = lock.categoryId
    state.matchTournamentId = lock.tournamentId
    state.legacyMatchAssociationWarning = `El combate ${lock.fightId} conserva un lock durable sin snapshot recuperable; no se liberó automáticamente.`
    logger.warn({ fightId: lock.fightId, categoryId: lock.categoryId, resultStatus: lock.resultStatus }, '[startup] Lock durable sin snapshot; nuevas cargas bloqueadas')
  }
} catch (err) {
  logger.warn({ err }, '[startup] No se pudo restaurar snapshot — arrancando limpio')
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

// ── CORS allow-list ──────────────────────────────────────────────────────────

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

backupMaintenanceActive = registerFullBackupRoutes(app, io, PORT)
registerCategoryRestartBodyParser(app)
registerCategoryDeletionBodyParser(app)
app.use(express.json({ limit: '100kb' }))
registerJudgeRoute(app)
registerTvRoute(app)
registerQrRoute(app)
registerRingRoute(app, io)
registerHistoryRoute(app)
registerPresetsRoute(app)

// ── Socket ───────────────────────────────────────────────────────────────────

registerSocketHandlers(io)

// ── Serve static build ───────────────────────────────────────────────────────

const distPath = path.join(__dirname, '..', 'dist')
if (existsSync(distPath)) {
  // Assets con hash: cache largo (1 año). index.html: nunca cachear (el browser siempre pide la última versión).
  app.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      }
    },
  }))
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
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

server.listen(PORT, runtime.enabled ? '127.0.0.1' : '0.0.0.0', () => {
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

let shutdownStarted = false
function shutdown(signal: string, forceTimeout = true): void {
  if (shutdownStarted) return
  shutdownStarted = true
  logger.info({ signal }, 'graceful shutdown')
  stopTicker()
  // Socket.IO closes its attached HTTP server and waits for in-flight replies.
  io.close(() => {
    try { db.close(); process.exit(0) }
    catch (error) { logger.error({ error }, 'database close failed'); process.exit(1) }
  })
  // Portable shutdown never force-kills the process. The supervisor reports a hang.
  if (forceTimeout) setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
