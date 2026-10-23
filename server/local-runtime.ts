import { timingSafeEqual } from 'node:crypto'
import type { Express, Request } from 'express'
import type { Server } from 'socket.io'

export interface LocalRuntimeConfig { installationId: string; secret: string; buildId: string; role: string }
interface RuntimePeer { address: string | undefined; host: string | undefined; origin: string | undefined; authorization: string | undefined }
interface RuntimeStatus { ok: true; installationId: string; buildId: string; role: string; pid: number; port: number; state: 'ready' | 'shutting-down'; busy: boolean; busyReasons: string[] }
export function parseLocalRuntimeConfig(env: Record<string, string | undefined>): LocalRuntimeConfig | null {
  const installationId = env.TKD_PORTABLE_INSTALLATION_ID
  const secret = env.TKD_PORTABLE_SUPERVISOR_SECRET
  const buildId = env.TKD_PORTABLE_BUILD_ID
  const roles = new Map<string, string>([['T1', 'T1'], ['T2', 'T2'], ['T3', 'T3'], ['MC', 'MC'], ['CENTRAL', 'MC'],
    ['cuadrilatero1', 'T1'], ['cuadrilatero2', 'T2'], ['cuadrilatero3', 'T3'], ['mesacentral', 'MC']])
  const role = roles.get(env.TKD_ROLE ?? '')
  if (!installationId && !secret && !buildId) return null
  if (!installationId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(installationId)
    || !secret || !/^[a-f0-9]{64}$/i.test(secret) || !buildId || !/^[\w.-]{1,160}$/.test(buildId)
    || !role) {
    throw new Error('Invalid portable supervisor configuration')
  }
  return { installationId, secret, buildId, role }
}

/** One event-loop turn checks busy state and closes the mutation gate atomically. */
export class LocalRuntime {
  private closing = false
  private closeDispatched = false
  private inFlightMutations = 0
  constructor(private readonly config: LocalRuntimeConfig | null, private readonly port: number,
    private readonly readBusyReasons: () => string[], private readonly close: () => void) {}
  get enabled(): boolean { return this.config !== null }
  get shuttingDown(): boolean { return this.closing }
  authorized(peer: RuntimePeer): boolean {
    if (!this.config || peer.origin !== undefined
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer.address ?? '')
      || ![`localhost:${this.port}`, `127.0.0.1:${this.port}`].includes(peer.host ?? '')) return false
    const supplied = Buffer.from(peer.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.config.secret}`)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }
  private busyReasons(): string[] {
    try { return [...this.readBusyReasons(), ...(this.inFlightMutations > 0 ? ['pending-operation'] : [])] }
    catch { return ['unknown-state'] }
  }
  status(): RuntimeStatus {
    if (!this.config) throw new Error('Portable supervisor disabled')
    const { installationId, buildId, role } = this.config
    const busyReasons = this.busyReasons()
    return { ok: true, installationId, buildId, role, pid: process.pid, port: this.port,
      state: this.closing ? 'shutting-down' : 'ready', busy: busyReasons.length > 0, busyReasons }
  }
  beginMutation(): () => void {
    if (this.closing) throw new Error('Server shutting down')
    this.inFlightMutations++
    let done = false
    return () => { if (!done) { this.inFlightMutations--; done = true } }
  }
  beginShutdown(): { accepted: boolean; busyReasons: string[] } {
    if (this.closing) return { accepted: true, busyReasons: [] }
    const busyReasons = this.busyReasons()
    if (busyReasons.length > 0) return { accepted: false, busyReasons }
    this.closing = true
    return { accepted: true, busyReasons: [] }
  }
  completeShutdown(): void {
    if (this.closing && !this.closeDispatched) { this.closeDispatched = true; this.close() }
  }
}

export function registerLocalRuntime(app: Express, io: Server, runtime: LocalRuntime): void {
  const peer = (req: Request): RuntimePeer => ({ address: req.socket.remoteAddress,
    host: req.get('host'), origin: req.get('origin'), authorization: req.get('authorization') })
  // Before CORS, body parsers and API rate limits: these are supervisor-only routes.
  app.use('/api/local', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!runtime.enabled) { res.sendStatus(404); return }
    if (!runtime.authorized(peer(req))) { res.sendStatus(403); return }
    next()
  })
  app.get('/api/local/identity', (_req, res) => { res.json(runtime.status()) })
  app.post('/api/local/shutdown', (_req, res) => {
    const result = runtime.beginShutdown()
    if (!result.accepted) {
      res.status(409).json({ error: 'El tatami tiene un combate, resultado u operación pendiente.', code: 'RUNTIME_BUSY', busyReasons: result.busyReasons })
      return
    }
    res.once('finish', () => { setImmediate(() => runtime.completeShutdown()) })
    res.status(202).json({ ok: true, state: 'shutting-down' })
  })
  app.use((req, res, next) => {
    if (!runtime.enabled || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return }
    if (runtime.shuttingDown) { res.status(503).json({ error: 'El sistema se está cerrando.', code: 'RUNTIME_SHUTTING_DOWN' }); return }
    const complete = runtime.beginMutation()
    res.once('finish', complete); res.once('close', complete)
    next()
  })
  io.use((socket, next) => {
    if (runtime.shuttingDown) { next(new Error('El sistema se está cerrando.')); return }
    socket.use((packet, packetNext) => {
      if (!runtime.shuttingDown) { packetNext(); return }
      const callback: unknown = packet.at(-1)
      if (typeof callback === 'function') callback({ ok: false, error: 'El sistema se está cerrando.', code: 'RUNTIME_SHUTTING_DOWN' })
      else socket.emit('error', { message: 'El sistema se está cerrando.' })
    })
    next()
  })
}
