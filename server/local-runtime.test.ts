// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { LocalRuntime, parseLocalRuntimeConfig } from './local-runtime.js'

const env = { TKD_PORTABLE_INSTALLATION_ID: '742958a7-d631-4230-a1eb-70563d139528', TKD_PORTABLE_SUPERVISOR_SECRET: 'a'.repeat(64), TKD_PORTABLE_BUILD_ID: 'test-build', TKD_ROLE: 'T1' }
const peer = { address: '127.0.0.1', host: 'localhost:43101', origin: undefined, authorization: `Bearer ${env.TKD_PORTABLE_SUPERVISOR_SECRET}` }
function runtime(reasons: string[] = []) {
  const close = vi.fn()
  const instance = new LocalRuntime(parseLocalRuntimeConfig(env), 43101, () => reasons, close)
  return { instance, close }
}
describe('portable local runtime', () => {
  it('is disabled on normal deployment and fails closed on partial or weak config', () => {
    expect(parseLocalRuntimeConfig({})).toBeNull()
    expect(() => parseLocalRuntimeConfig({ TKD_PORTABLE_INSTALLATION_ID: env.TKD_PORTABLE_INSTALLATION_ID })).toThrow()
    expect(() => parseLocalRuntimeConfig({ ...env, TKD_PORTABLE_SUPERVISOR_SECRET: 'short' })).toThrow()
  })
  it.each([
    ['T1', 'T1'], ['T2', 'T2'], ['T3', 'T3'], ['MC', 'MC'], ['CENTRAL', 'MC'],
    ['cuadrilatero1', 'T1'], ['cuadrilatero2', 'T2'], ['cuadrilatero3', 'T3'], ['mesacentral', 'MC'],
  ])('normalizes launcher role %s to canonical supervisor identity %s', (role, canonical) => {
    expect(parseLocalRuntimeConfig({ ...env, TKD_ROLE: role })?.role).toBe(canonical)
  })
  it.each(['', 'T4', 'central', 'constructor', '__proto__'])('rejects unknown supervisor role %s', role => {
    expect(() => parseLocalRuntimeConfig({ ...env, TKD_ROLE: role })).toThrow()
  })
  it('authenticates exact loopback peer/host, rejects all browser origins and never reveals secret', () => {
    const { instance } = runtime()
    expect(instance.authorized(peer)).toBe(true)
    for (const patch of [{ address: '192.168.1.10' }, { host: 'evil.test:43101' }, { origin: 'http://localhost:43101' }, { authorization: 'Bearer wrong' }, { host: 'localhost:3101' }]) {
      expect(instance.authorized({ ...peer, ...patch })).toBe(false)
    }
    expect(JSON.stringify(instance.status())).not.toContain(env.TKD_PORTABLE_SUPERVISOR_SECRET)
    expect(instance.status()).toMatchObject({ installationId: env.TKD_PORTABLE_INSTALLATION_ID, buildId: 'test-build', role: 'T1', port: 43101, busy: false, state: 'ready' })
  })
  it.each(['loaded-match', 'active-lock', 'pending-result', 'maintenance', 'unknown-state'])('blocks shutdown for %s', (reason) => {
    const { instance, close } = runtime([reason])
    expect(instance.beginShutdown()).toEqual({ accepted: false, busyReasons: [reason] })
    expect(instance.shuttingDown).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })
  it('blocks shutdown while an HTTP mutation is unfinished and releases once only', () => {
    const { instance } = runtime()
    const end = instance.beginMutation()
    expect(instance.beginShutdown().accepted).toBe(false)
    end(); end()
    expect(instance.beginShutdown().accepted).toBe(true)
    expect(() => instance.beginMutation()).toThrow()
  })
  it('gates mutations atomically and only invokes graceful shutdown after acknowledgement', () => {
    const { instance, close } = runtime()
    expect(instance.beginShutdown().accepted).toBe(true)
    expect(instance.shuttingDown).toBe(true)
    expect(close).not.toHaveBeenCalled()
    instance.completeShutdown(); instance.completeShutdown()
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('fails closed when busy status cannot be read', () => {
    const instance = new LocalRuntime(parseLocalRuntimeConfig(env), 43101, () => { throw new Error('db failed') }, vi.fn())
    expect(instance.status().busyReasons).toEqual(['unknown-state'])
    expect(instance.beginShutdown().accepted).toBe(false)
  })
})

import express from 'express'
import { createServer, request } from 'node:http'
import { Server } from 'socket.io'
import { registerLocalRuntime } from './local-runtime.js'
import { io as clientIo } from 'socket.io-client'

async function fixture(enabled = true) {
  const app = express(); const server = createServer(app); const io = new Server(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing port')
  let reasons: string[] = []; const close = vi.fn()
  const runtime = new LocalRuntime(enabled ? parseLocalRuntimeConfig(env) : null, address.port, () => reasons, close)
  registerLocalRuntime(app, io, runtime)
  let finishSlow: (() => void) | undefined
  app.post('/slow', (_req, res) => { finishSlow = () => { res.json({ok: true}) } })
  app.post('/write', (_req, res) => { res.json({ok: true}) })
  io.on('connection', socket => socket.on('write', (reply: (value: unknown) => void) => reply({ok: true})))
  const http = (pathname: string, method = 'GET', headers: Record<string, string> = {}) => new Promise<{status: number; body: string; headers: Record<string, unknown>}>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: pathname, method, headers: { Authorization: `Bearer ${env.TKD_PORTABLE_SUPERVISOR_SECRET}`, ...headers } }, response => {
      let body = ''; response.on('data', chunk => {body += String(chunk)}); response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }))
    }); req.on('error', reject); req.end()
  })
  return { runtime, http, close, setReasons: (value: string[]) => { reasons = value }, endSlow: () => { const finish = finishSlow; finishSlow = undefined; finish?.() },
    url: `http://127.0.0.1:${address.port}`, dispose: () => new Promise<void>(resolve => io.close(() => resolve())) }
}

it('HTTP identity authenticates before CORS and shutdown responds before graceful close', async () => {
  const f = await fixture()
  try {
    expect((await f.http('/api/local/identity', 'GET', {Authorization: ''})).status).toBe(403)
    const crossOrigin = await f.http('/api/local/identity', 'GET', {Origin: f.url})
    expect(crossOrigin.status).toBe(403)
    expect(crossOrigin.headers['access-control-allow-origin']).toBeUndefined()
    expect((await f.http('/api/local/identity', 'GET', {Host: 'evil.test'})).status).toBe(403)
    expect(JSON.parse((await f.http('/api/local/identity')).body)).toMatchObject({role:'T1', busy:false})
    expect((await f.http('/api/local/shutdown', 'POST')).status).toBe(202)
    await new Promise(resolve => setImmediate(resolve)); expect(f.close).toHaveBeenCalledTimes(1)
    expect((await f.http('/write','POST')).status).toBe(503)
    expect((await f.http('/api/local/shutdown', 'POST')).status).toBe(202)
    expect(f.close).toHaveBeenCalledTimes(1)
  } finally { await f.dispose() }
})
it('HTTP endpoints are absent without portable configuration', async () => {
  const f = await fixture(false)
  try { expect((await f.http('/api/local/identity')).status).toBe(404); expect((await f.http('/write', 'POST')).status).toBe(200) }
  finally { await f.dispose() }
})
it('rejects pending HTTP writes without closing and permits after reply completes', async () => {
  const f = await fixture()
  try {
    const writing = f.http('/slow', 'POST')
    while (!f.runtime.status().busy) await new Promise(resolve => setTimeout(resolve, 5))
    expect((await f.http('/api/local/shutdown', 'POST')).status).toBe(409)
    f.endSlow(); await writing
    f.setReasons(['maintenance']); expect((await f.http('/api/local/shutdown', 'POST')).status).toBe(409)
    f.setReasons([]); expect((await f.http('/api/local/shutdown', 'POST')).status).toBe(202)
  } finally { f.endSlow(); await f.dispose() }
})
it('gates packets from existing socket clients once shutdown is accepted', async () => {
  const f = await fixture(); const client = clientIo(f.url, { transports: ['websocket'], forceNew: true })
  try {
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error',reject) })
    expect(await client.emitWithAck('write')).toEqual({ok:true})
    expect((await f.http('/api/local/shutdown', 'POST')).status).toBe(202)
    expect(await client.emitWithAck('write')).toMatchObject({ok:false,code:'RUNTIME_SHUTTING_DOWN'})
  } finally { client.disconnect(); await f.dispose() }
})
