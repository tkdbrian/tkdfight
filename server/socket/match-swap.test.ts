// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Server } from 'socket.io'
import { io as createClient, type Socket } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import baselineRules from '../../src/rules/rules/rules_sparring_itf_baseline.json'
import type { MatchSwapReply, MatchSwapRequest } from '../../src/lib/match-swap-contract.js'

let directory: string | null = null
let database: typeof import('../db/index.js') | null = null
let socketServer: Server | null = null
let client: Socket | null = null
let judgeClient: Socket | null = null

afterEach(async () => {
  const { stopTicker } = await import('../timer.js')
  stopTicker()
  client?.disconnect()
  judgeClient?.disconnect()
  if (socketServer) await new Promise<void>((resolve) => socketServer?.close(() => resolve()))
  database?.default.close()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = null
  database = null
  socketServer = null
  client = null
  judgeClient = null
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loaded() {
  directory = mkdtempSync(path.join(tmpdir(), 'tkd-swap-socket-'))
  vi.stubEnv('DATA_DIR', directory)
  vi.resetModules()
  database = await import('../db/index.js')
  const { state } = await import('../state.js')
  const { registerSocketHandlers } = await import('./handlers.js')
  const http = createServer()
  socketServer = new Server(http)
  registerSocketHandlers(socketServer)
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  client = createClient(url, { transports: ['websocket'], forceNew: true })
  await new Promise<void>((resolve, reject) => {
    client?.once('connect', resolve)
    client?.once('connect_error', reject)
  })
  state.activeTournamentId = database.createTournament('Swap test', '')
  const categoryId = 'swap-category'
  const matchId = 'swap-fight'
  const load = await client.timeout(500).emitWithAck('match:load', {
    categoryId,
    tournamentName: 'Swap test',
    rules: baselineRules,
    match: {
      id: matchId, ringId: 'T1', matchMode: 'sparring', timingKind: 'regular',
      red: { id: 'swap-red', name: 'Red', club: 'Red club' },
      blue: { id: 'swap-blue', name: 'Blue', club: 'Blue club' },
    },
  }) as { ok: boolean }
  expect(load.ok).toBe(true)
  const timing = state.match?.preFight
  if (!timing?.loadId) throw new Error('missing load generation')
  const request: MatchSwapRequest = {
    requestId: 'swap-request', categoryId, matchId,
    expectedRevision: timing.revision, expectedLoadId: timing.loadId,
    expectedRedId: 'swap-red', expectedBlueId: 'swap-blue',
  }
  const send = (payload: unknown, socket = client as Socket) =>
    socket.timeout(500).emitWithAck('match:swapCompetitors', payload) as Promise<MatchSwapReply>
  return { db: database, state, client, url, request, send }
}

function fightRow(db: typeof import('../db/index.js')) {
  return db.default.prepare('SELECT * FROM fights WHERE id = ?').get('swap-fight') as Record<string, unknown>
}

describe('loaded sparring competitor swap', () => {
  it('atomically exchanges identities, preserving color channels, topology, and broadcasts to displays', async () => {
    const { db, state, client, url, request, send } = await loaded()
    judgeClient = createClient(url, { transports: ['websocket'], forceNew: true })
    await new Promise<void>((resolve) => judgeClient?.once('connect', resolve))
    expect(await judgeClient.timeout(500).emitWithAck('judge:connect', {
      requestedId: 'J1', token: state.ringToken,
    })).toMatchObject({ judgeId: 'J1' })
    db.default.prepare('UPDATE fights SET round_index = 3, group_id = ? WHERE id = ?')
      .run('bracket-group', request.matchId)
    const original = fightRow(db)
    const originalState = structuredClone(state.matchState)
    const updated = new Promise<Record<string, unknown>>((resolve) => {
      client.on('state:update', (value: Record<string, unknown>) => {
        const match = value.match as { preFight?: { revision: number } } | null
        if (match?.preFight?.revision === 1) resolve(value)
      })
    })
    const judgeUpdated = new Promise<Record<string, unknown>>((resolve) => {
      judgeClient?.on('state:update', (value: Record<string, unknown>) => {
        const match = value.match as { preFight?: { revision: number } } | null
        if (match?.preFight?.revision === 1) resolve(value)
      })
    })
    expect(await send(request)).toMatchObject({ ok: true, match: {
      red: { id: 'swap-blue', name: 'Blue', club: 'Blue club' },
      blue: { id: 'swap-red', name: 'Red', club: 'Red club' },
      preFight: { revision: 1, loadId: request.expectedLoadId },
    } })
    expect((await updated).match).toMatchObject({ red: { id: 'swap-blue' }, blue: { id: 'swap-red' } })
    expect((await judgeUpdated).match).toMatchObject({ red: { id: 'swap-blue' }, blue: { id: 'swap-red' } })
    expect(state.matchState).toEqual(originalState)
    expect(state.rules).toEqual(baselineRules)
    expect(db.loadMatchSnapshot()?.data?.match).toMatchObject({
      red: { id: 'swap-blue', name: 'Blue' }, blue: { id: 'swap-red', name: 'Red' },
      preFight: { revision: 1, loadId: request.expectedLoadId },
    })
    expect(fightRow(db)).toMatchObject({
      id: original.id, tournament_id: original.tournament_id, round_index: 3,
      group_id: 'bracket-group', red_id: 'swap-blue', blue_id: 'swap-red',
      completed: 0, flags_red: 0, flags_blue: 0,
    })
    expect(db.getMatchResult(request.categoryId, request.matchId)).toBeNull()
  })

  it('replays a lost ACK without swapping twice and rejects a changed request fingerprint', async () => {
    const { db, state, request, send } = await loaded()
    expect(await send(request)).toMatchObject({ ok: true })
    expect(await send(request)).toMatchObject({ ok: true, alreadyApplied: true,
      match: { red: { id: 'swap-blue' }, blue: { id: 'swap-red' } } })
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-blue', blue_id: 'swap-red' })
    expect(state.match?.preFight?.revision).toBe(1)
    expect(await send({ ...request, expectedRedId: 'swap-blue' }))
      .toMatchObject({ ok: false, code: 'request_conflict' })
    expect(await send({ ...request, requestId: 'second-swap', expectedRevision: 1,
      expectedRedId: 'swap-blue', expectedBlueId: 'swap-red' })).toMatchObject({ ok: true })
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-red', blue_id: 'swap-blue' })
    expect(await send(request)).toMatchObject({ ok: false, code: 'request_superseded',
      match: { red: { id: 'swap-red' }, blue: { id: 'swap-blue' } } })
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-red', blue_id: 'swap-blue' })
    vi.resetModules()
    const recoveredDb = await import('../db/index.js')
    try {
      const recoveredSwap = await import('../db/match-swap.js')
      expect(recoveredSwap.hasSwapReceipt(request)).toBe(true)
      expect(recoveredDb.loadMatchSnapshot()?.data?.match.red.id).toBe('swap-red')
    } finally {
      recoveredDb.default.close()
    }
  })

  it.each([
    'foreign', 'revision', 'generation', 'red-pair', 'blue-pair', 'started', 'paused',
    'votes', 'events', 'clock', 'result', 'golden', 'tul', 'continuation',
  ])('rejects %s without changing durable or live identity', async (kind) => {
    const { db, state, request, send } = await loaded()
    const payload = { ...request }
    if (kind === 'foreign') payload.categoryId = 'foreign'
    if (kind === 'revision') payload.expectedRevision++
    if (kind === 'generation') payload.expectedLoadId = 'different'
    if (kind === 'red-pair') payload.expectedRedId = 'other'
    if (kind === 'blue-pair') payload.expectedBlueId = 'other'
    if (kind === 'started' && state.match?.preFight) state.match.preFight.started = true
    if (kind === 'paused') state.matchPaused = true
    if (kind === 'votes') state.judgeVotes.set('J1', 'red')
    if (kind === 'events' && state.matchState) state.matchState.rounds.push({
      number: 1, totals: { red: 1, blue: 0 }, deductions: { red: 0, blue: 0 },
      fouls: { red: 0, blue: 0 }, events: [{
        id: 'event', ts: Date.now(), judgeId: 'J1', competitor: 'red', type: 'punch', value: 1,
      }],
    })
    if (kind === 'clock' && state.matchState) state.matchState.timeLeft--
    if (kind === 'result' && state.matchState) state.matchState.result = { winner: 'red', reason: 'points' }
    if (kind === 'golden' && state.match) state.match.goldenPoint = true
    if (kind === 'tul' && state.match) state.match.matchMode = 'tul'
    if (kind === 'continuation' && state.match?.preFight) state.match.preFight.timingKind = 'continuation'
    const before = db.loadMatchSnapshot()
    expect(await send(payload)).toMatchObject({ ok: false })
    expect(db.loadMatchSnapshot()).toEqual(before)
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-red', blue_id: 'swap-blue' })
    expect(state.match?.red.id).toBe('swap-red')
    expect(state.match?.blue.id).toBe('swap-blue')
  })

  it('rejects judge sockets and malformed payloads', async () => {
    const { db, state, url, request, send } = await loaded()
    judgeClient = createClient(url, { transports: ['websocket'], forceNew: true })
    await new Promise<void>((resolve) => judgeClient?.once('connect', resolve))
    const judge = await judgeClient.timeout(500).emitWithAck('judge:connect', {
      requestedId: 'J1', token: state.ringToken,
    }) as { judgeId: string }
    expect(judge.judgeId).toBe('J1')
    expect(await send(request, judgeClient)).toMatchObject({ ok: false, code: 'unauthorized_judge' })
    expect(await send({ ...request, unexpected: true })).toMatchObject({ ok: false, code: 'invalid_payload' })
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-red', blue_id: 'swap-blue' })
  })

  it('fences pre-swap packets even though the match ID and judge socket remain unchanged', async () => {
    const { state, client, url, request, send } = await loaded()
    judgeClient = createClient(url, { transports: ['websocket'], forceNew: true })
    await new Promise<void>((resolve) => judgeClient?.once('connect', resolve))
    expect(await judgeClient.timeout(500).emitWithAck('judge:connect', {
      requestedId: 'J1', token: state.ringToken,
    })).toMatchObject({ judgeId: 'J1' })
    expect(await send(request)).toMatchObject({ ok: true })
    const identity = { categoryId: request.categoryId, matchId: request.matchId }
    const currentAssignment = {
      expectedLoadId: request.expectedLoadId, expectedAssignmentRevision: 1,
    }
    expect(await client?.timeout(500).emitWithAck('match:configure', {
      ...identity, expectedRevision: 1, durationSeconds: 60, rounds: 1,
    })).toMatchObject({ ok: false, code: 'stale_assignment' })
    for (const [event, payload] of [
      ['golden:vote', { ...identity, judgeId: 'J1', competitor: 'red', attempt: 1 }],
      ['mesa:goldenVote', { ...identity, judgeId: 'J1', competitor: 'red', attempt: 1 }],
      ['mesa:confirmGoldenOutcome', { ...identity, attempt: 1 }],
      ['mesa:setSanctionCount', { ...identity, competitor: 'red', kind: 'warning',
        expectedCount: 0, count: 1 }],
    ] as const) {
      expect(await client?.timeout(500).emitWithAck(event, payload))
        .toMatchObject({ ok: false, code: 'stale_assignment' })
    }
    expect(await client?.timeout(500).emitWithAck('match:start', {
      ...identity, expectedTimingRevision: 1,
    })).toMatchObject({ ok: false, code: 'stale_assignment' })
    expect(state.matchState?.phase).toBe('idle')
    expect(await judgeClient.timeout(500).emitWithAck('judge:vote', {
      ...identity, judgeId: 'J1', vote: 'red', expectedLoadId: request.expectedLoadId,
      expectedAssignmentRevision: 0,
    })).toMatchObject({ ok: false, code: 'stale_assignment' })
    expect(state.judgeVotes.size).toBe(0)
    expect(await client?.timeout(500).emitWithAck('match:start', {
      ...identity, ...currentAssignment, expectedTimingRevision: 1,
    })).toMatchObject({ ok: true })
    expect(state.matchState?.phase).toBe('round')
    expect(await judgeClient.timeout(500).emitWithAck('match:event', {
      ...identity, judgeId: 'J1', competitor: 'red', type: 'pts_1',
    })).toMatchObject({ ok: false, code: 'stale_assignment' })
    expect(state.matchState?.rounds[0].events).toEqual([])
    judgeClient.emit('match:event', {
      ...identity, ...currentAssignment, judgeId: 'J1', competitor: 'red', type: 'pts_1',
    })
    await vi.waitFor(() => expect(state.matchState?.rounds[0].events).toHaveLength(1))
    expect(state.matchState?.rounds[0].events[0]).toMatchObject({ competitor: 'red' })
  })

  it('keeps the fence after a post-swap timing revision and rejects the older token', async () => {
    const { state, client, request, send } = await loaded()
    expect(await send(request)).toMatchObject({ ok: true })
    const identity = { categoryId: request.categoryId, matchId: request.matchId }
    expect(await client?.timeout(500).emitWithAck('match:configure', {
      ...identity, expectedRevision: 1, expectedLoadId: request.expectedLoadId,
      durationSeconds: 45, rounds: 1,
    })).toMatchObject({ ok: true, preFight: { revision: 2, swapCount: 1 } })
    expect(await client?.timeout(500).emitWithAck('match:start', {
      ...identity, expectedTimingRevision: 2, expectedLoadId: request.expectedLoadId,
      expectedAssignmentRevision: 1,
    })).toMatchObject({ ok: false, code: 'stale_assignment' })
    expect(state.matchState?.phase).toBe('idle')
    expect(await client?.timeout(500).emitWithAck('match:start', {
      ...identity, expectedTimingRevision: 2, expectedLoadId: request.expectedLoadId,
      expectedAssignmentRevision: 2,
    })).toMatchObject({ ok: true })
    expect(state.matchState?.phase).toBe('round')
  })

  it('rejects stale SQL pair and durable activity even when runtime remains idle', async () => {
    const { db, request, send } = await loaded()
    const snapshot = db.loadMatchSnapshot()
    if (!snapshot?.data?.matchState) throw new Error('missing saved match')
    snapshot.data.matchState.rounds.push({
      number: 1, totals: { red: 1, blue: 0 }, deductions: { red: 0, blue: 0 },
      fouls: { red: 0, blue: 0 }, events: [{
        id: 'saved-event', ts: Date.now(), judgeId: 'J1', competitor: 'red', type: 'punch', value: 1,
      }],
    })
    db.saveMatchSnapshot(request.matchId, snapshot.tournamentId, snapshot.data, request.categoryId)
    expect(await send(request)).toMatchObject({ ok: false })
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-red', blue_id: 'swap-blue' })
    snapshot.data.matchState.rounds = []
    db.saveMatchSnapshot(request.matchId, snapshot.tournamentId, snapshot.data, request.categoryId)
    db.default.prepare('UPDATE fights SET red_id = ? WHERE id = ?').run('swap-blue', request.matchId)
    expect(await send(request)).toMatchObject({ ok: false, code: 'stale_competitors' })
  })

  it('rolls back both SQL pair and snapshot, without receipt, if snapshot write fails', async () => {
    const { db, state, request, send } = await loaded()
    const before = db.loadMatchSnapshot()
    db.default.exec("CREATE TRIGGER reject_swap BEFORE UPDATE ON match_snapshot BEGIN SELECT RAISE(ABORT, 'test'); END")
    expect(await send(request)).toMatchObject({ ok: false, code: 'persistence_failed' })
    expect(db.loadMatchSnapshot()).toEqual(before)
    expect(fightRow(db)).toMatchObject({ red_id: 'swap-red', blue_id: 'swap-blue' })
    expect(state.match?.preFight?.revision).toBe(0)
    db.default.exec('DROP TRIGGER reject_swap')
    expect(await send(request)).toMatchObject({ ok: true })
  })

  it('reports canonical color IDs with the result after the fight is confirmed and unloaded', async () => {
    const { db, state, request, send, client } = await loaded()
    expect(await send(request)).toMatchObject({ ok: true })
    const tournamentId = db.getCategoryTournamentId(request.categoryId)
    if (tournamentId === null) throw new Error('missing tournament')
    db.default.prepare(`INSERT INTO match_results (
      fight_id, category_id, tournament_id, winner, reason, status
    ) VALUES (?, ?, ?, 'red', 'points', 'confirmed')`)
      .run(request.matchId, request.categoryId, tournamentId)
    db.completeFight(request.matchId, 'red', 'points')
    db.clearMatchSnapshot(request.matchId, request.categoryId)
    state.match = null
    state.matchState = null
    const response = await client?.timeout(500).emitWithAck('match:result:get', {
      categoryId: request.categoryId, matchId: request.matchId,
    }) as { ok: boolean; redId?: string; blueId?: string; result?: { winner: string } }
    expect(response).toMatchObject({ ok: true, redId: 'swap-blue', blueId: 'swap-red',
      result: { winner: 'red' } })
    const wrongCategory = await client?.timeout(500).emitWithAck('match:result:get', {
      categoryId: 'wrong-category', matchId: request.matchId,
    }) as { ok: boolean; redId?: string; blueId?: string; result?: unknown }
    expect(wrongCategory).toMatchObject({ ok: true, result: null })
    expect(wrongCategory.redId).toBeUndefined()
    expect(wrongCategory.blueId).toBeUndefined()
  })
})
