import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Server } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import baselineRules from '../../src/rules/rules/rules_sparring_itf_baseline.json';

let directory: string | null = null;
let database: typeof import('../db/index.js') | null = null;
let socketServer: Server | null = null;
let client: Socket | null = null;
let serverAddress: string | null = null;
const extraClients: Socket[] = [];

afterEach(async () => {
  const { stopTicker } = await import('../timer.js');
  stopTicker();
  client?.disconnect();
  for (const extra of extraClients.splice(0)) extra.disconnect();
  client = null;
  serverAddress = null;
  if (socketServer) await new Promise<void>((resolve) => socketServer?.close(() => resolve()));
  socketServer = null;
  database?.default.close();
  database = null;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function setupSocketClient(): Promise<{
  db: typeof import('../db/index.js');
  activeState: typeof import('../state.js').state;
  socket: Socket;
}> {
  directory = mkdtempSync(path.join(tmpdir(), 'tkd-fight-socket-test-'));
  vi.stubEnv('DATA_DIR', directory);
  vi.resetModules();
  database = await import('../db/index.js');
  const { state: activeState } = await import('../state.js');
  const { registerSocketHandlers } = await import('./handlers.js');
  const httpServer = createServer();
  socketServer = new Server(httpServer);
  registerSocketHandlers(socketServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;
  serverAddress = `http://127.0.0.1:${address.port}`;
  const socket = createClient(`http://127.0.0.1:${address.port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  client = socket;
  return { db: database, activeState, socket };
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

describe('socket match persistence protocol', () => {
  it('edits sanctions after the clock and updates pending RR metrics until official confirmation', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('RR post-clock sanctions', '');
    const identity = { categoryId: 'category-rr-sanctions', matchId: 'fight-rr-sanctions' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'RR post-clock sanctions',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags',
        rounds: { ...baselineRules.rounds, count: 1, duration_seconds: 60 } },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'sanction-red', name: 'Rojo' }, blue: { id: 'sanction-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    socket.emit('match:skipToFlags', identity);
    await vi.waitFor(() => expect(activeState.matchState?.phase).toBe('rest'));
    const setCount = (competitor: 'red' | 'blue', kind: 'warning' | 'minus_point',
      expectedCount: number, count: number) =>
      emitAck<{ ok: boolean; code?: string; status?: number; alreadyApplied?: boolean; counts?: {
        warnings: { red: number; blue: number }; fouls: { red: number; blue: number }
      } }>(socket, 'mesa:setSanctionCount', { ...identity, competitor, kind, expectedCount, count });
    expect(await setCount('red', 'warning', 0, 1)).toMatchObject({ ok: true,
      counts: { warnings: { red: 1, blue: 0 }, fouls: { red: 0, blue: 0 } } });
    expect(await setCount('red', 'warning', 0, 1)).toMatchObject({ ok: true, alreadyApplied: true });
    expect(await setCount('blue', 'minus_point', 0, 1)).toMatchObject({ ok: true });
    expect(await setCount('red', 'warning', 0, 2)).toMatchObject({ ok: false, code: 'stale_count', status: 409 });
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0].events).toMatchObject([
      { judgeId: 'arbiter', competitor: 'red', type: 'warning_minor' },
      { judgeId: 'arbiter', competitor: 'blue', type: 'minus_point' },
    ]);
    for (const judgeId of ['J1', 'J2', 'J3', 'J4']) {
      socket.emit('mesa:flagVote', { ...identity, judgeId, vote: judgeId === 'J4' ? 'blue' : 'red' });
    }
    await vi.waitFor(() => expect(activeState.judgeVotes.size).toBe(4));
    socket.emit('mesa:confirmRound', identity);
    await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId)?.status)
      .toBe('pending_confirmation'));
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      winner: 'red', warningsRed: 1, foulsBlue: 1,
    });
    expect(await setCount('red', 'warning', 1, 0)).toMatchObject({ ok: true });
    expect(await setCount('blue', 'minus_point', 1, 0)).toMatchObject({ ok: true });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      status: 'pending_confirmation', winner: 'red', flagsRed: 3, flagsBlue: 1,
      warningsRed: 0, foulsBlue: 0,
    });
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0].events.at(-1))
      .toMatchObject({ type: 'remove_minus_point', competitor: 'blue' });
    expect(await emitAck<{ ok: boolean; result?: { status: string } }>(socket, 'match:saveFallo', { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: true, result: { status: 'confirmed' } });
    expect(await setCount('red', 'warning', 0, 1))
      .toMatchObject({ ok: false, code: 'result_confirmed', status: 409 });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      status: 'confirmed', warningsRed: 0, foulsBlue: 0,
    });
  });

  it('rolls back a pending sanction correction when SQLite rejects its metrics update', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('RR sanction rollback', '');
    const identity = { categoryId: 'category-sanction-rollback', matchId: 'fight-sanction-rollback' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'RR sanction rollback',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags',
        rounds: { ...baselineRules.rounds, count: 1 } },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'rollback-red', name: 'Rojo' }, blue: { id: 'rollback-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    socket.emit('match:skipToFlags', identity);
    await vi.waitFor(() => expect(activeState.matchState?.phase).toBe('rest'));
    for (const judgeId of ['J1', 'J2', 'J3', 'J4']) {
      socket.emit('mesa:flagVote', { ...identity, judgeId, vote: 'red' });
    }
    await vi.waitFor(() => expect(activeState.judgeVotes.size).toBe(4));
    socket.emit('mesa:confirmRound', identity);
    await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId)?.status)
      .toBe('pending_confirmation'));
    const adjust = () => emitAck<{ ok: boolean; code?: string }>(socket, 'mesa:setSanctionCount', {
      ...identity, competitor: 'red', kind: 'warning', expectedCount: 0, count: 1,
    });
    db.default.exec(`CREATE TRIGGER reject_sanction_update BEFORE UPDATE OF warnings_red ON match_results
      BEGIN SELECT RAISE(ABORT, 'test sanction write failure'); END`);
    expect(await adjust()).toMatchObject({ ok: false, code: 'persistence_failed' });
    expect(activeState.matchState?.rounds[0].events).toEqual([]);
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0].events).toEqual([]);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)?.warningsRed).toBe(0);
    db.default.exec('DROP TRIGGER reject_sanction_update');
    expect(await adjust()).toMatchObject({ ok: true });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)?.warningsRed).toBe(1);
  });

  it('preserves votes and sanctions in rest when final result insertion fails, then retries atomically', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('Missing pending result', '');
    const identity = { categoryId: 'category-missing-pending', matchId: 'fight-missing-pending' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'Missing pending result',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags',
        rounds: { ...baselineRules.rounds, count: 1 } },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'missing-red', name: 'Rojo' }, blue: { id: 'missing-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    socket.emit('match:skipToFlags', identity);
    await vi.waitFor(() => expect(activeState.matchState?.phase).toBe('rest'));
    for (const judgeId of ['J1', 'J2', 'J3', 'J4']) {
      socket.emit('mesa:flagVote', { ...identity, judgeId, vote: 'red' });
    }
    await vi.waitFor(() => expect(activeState.judgeVotes.size).toBe(4));
    db.default.exec(`CREATE TRIGGER reject_missing_pending BEFORE INSERT ON match_results
      BEGIN SELECT RAISE(ABORT, 'test pending insert failure'); END`);
    socket.emit('mesa:confirmRound', identity);
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.matchState?.phase).toBe('rest');
    expect(activeState.roundFlags).toEqual([]);
    expect(Object.fromEntries(activeState.judgeVotes)).toEqual({ J1: 'red', J2: 'red', J3: 'red', J4: 'red' });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    expect(db.loadMatchSnapshot()?.data).toMatchObject({ matchState: { phase: 'rest', result: null },
      judgeVotes: { J1: 'red', J2: 'red', J3: 'red', J4: 'red' } });
    expect(await emitAck(socket, 'mesa:setSanctionCount', { ...identity,
      competitor: 'red', kind: 'warning', expectedCount: 0, count: 1 })).toMatchObject({ ok: true });
    db.default.exec('DROP TRIGGER reject_missing_pending');
    socket.emit('mesa:confirmRound', identity);
    await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId))
      .toMatchObject({ status: 'pending_confirmation', winner: 'red', flagsRed: 4, warningsRed: 1 }));
    expect(activeState.roundFlags).toHaveLength(1);
    expect(activeState.matchState?.phase).toBe('finished');
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0].events).toHaveLength(1);
  });

  it('preserves an elimination winner while correcting sanctions after the clock', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('Direct sanction review', '');
    const identity = { categoryId: 'category-direct-sanction', matchId: 'fight-direct-sanction' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'Direct sanction review',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags',
        rounds: { ...baselineRules.rounds, count: 1 } },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        red: { id: 'direct-sanction-red', name: 'Rojo' },
        blue: { id: 'direct-sanction-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    socket.emit('match:skipToFlags', identity);
    await vi.waitFor(() => expect(activeState.matchState?.phase).toBe('rest'));
    const adjust = (competitor: 'red' | 'blue', kind: 'warning' | 'minus_point',
      expectedCount: number, count: number) => emitAck<{ ok: boolean }>(socket,
      'mesa:setSanctionCount', { ...identity, competitor, kind, expectedCount, count });
    expect(await adjust('red', 'warning', 0, 1)).toMatchObject({ ok: true });
    expect(await adjust('blue', 'minus_point', 0, 1)).toMatchObject({ ok: true });
    for (const judgeId of ['J1', 'J2', 'J3', 'J4']) {
      socket.emit('mesa:flagVote', { ...identity, judgeId, vote: judgeId === 'J4' ? 'blue' : 'red' });
    }
    await vi.waitFor(() => expect(activeState.judgeVotes.size).toBe(4));
    socket.emit('mesa:confirmRound', identity);
    await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId)?.status)
      .toBe('pending_confirmation'));
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      winner: 'red', flagsRed: 3, flagsBlue: 1, warningsRed: 1, foulsBlue: 1,
    });
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0].events.length).toBe(2);
    expect(await adjust('blue', 'minus_point', 1, 0)).toMatchObject({ ok: true });
    expect(activeState.matchState?.result?.winner).toBe('red');
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      status: 'pending_confirmation', winner: 'red', flagsRed: 3, flagsBlue: 1, foulsBlue: 0,
    });
    expect(await adjust('blue', 'minus_point', 0, 3)).toMatchObject({ ok: true });
    expect(activeState.matchState?.result).toMatchObject({ winner: 'red' });
    expect(activeState.matchState?.rounds[0].fouls.blue).toBe(0);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      status: 'pending_confirmation', winner: 'red', foulsBlue: 3,
    });
  });

  it('does not erase a disqualification cause while leaving its winner unchanged', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('DQ sanction guard', '');
    const identity = { categoryId: 'category-dq-guard', matchId: 'fight-dq-guard' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'DQ sanction guard',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        red: { id: 'dq-red', name: 'Rojo' }, blue: { id: 'dq-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    socket.emit('match:start', identity);
    await vi.waitFor(() => expect(activeState.matchState?.phase).toBe('round'));
    socket.emit('match:event', { ...identity, judgeId: 'arbiter', competitor: 'red', type: 'disqualify' });
    await vi.waitFor(() => expect(activeState.matchState?.result?.reason).toBe('dq'));
    expect(await emitAck<{ ok: boolean; code?: string; status?: number }>(socket,
      'mesa:setSanctionCount', { ...identity, competitor: 'red', kind: 'warning',
        expectedCount: 0, count: 1 })).toMatchObject({ ok: false, code: 'winner_locked', status: 409 });
    expect(activeState.matchState?.result).toMatchObject({ winner: 'blue', reason: 'dq' });
  });
  it('checkpoints each running RR clock tick for paused recovery after restart', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('RR durable clock', '');
    const identity = { categoryId: 'category-rr-clock', matchId: 'fight-rr-clock' };
    const seconds = 5;
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId,
      tournamentName: 'RR durable clock',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags',
        rounds: { ...baselineRules.rounds, count: 1, duration_seconds: seconds } },
      match: {
        id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'red-clock', name: 'Rojo' }, blue: { id: 'blue-clock', name: 'Azul' },
      },
    })).toMatchObject({ ok: true });
    socket.emit('match:start', identity);
    await vi.waitFor(() => expect(activeState.matchState?.timeLeft).toBeLessThan(seconds),
      { timeout: 2_500 });
    expect(db.loadMatchSnapshot()?.data?.matchState?.timeLeft).toBe(activeState.matchState?.timeLeft);
    db.default.exec(`CREATE TRIGGER reject_rr_clock BEFORE INSERT ON match_snapshot
      BEGIN SELECT RAISE(ABORT, 'test clock write failure'); END`);
    const durableTime = activeState.matchState?.timeLeft;
    await vi.waitFor(() => expect(activeState.matchPaused).toBe(true), { timeout: 2_500 });
    expect(activeState.matchState?.timeLeft).toBe(durableTime);
    expect(db.loadMatchSnapshot()?.data?.matchState?.timeLeft).toBe(durableTime);
  });

  it('reopens only an unconfirmed flags result transactionally without undoing sanctions', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('RR pending undo', '');
    const identity = { categoryId: 'category-pending-undo', matchId: 'fight-pending-undo' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId,
      tournamentName: 'RR pending undo',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: {
        id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'red-undo', name: 'Rojo' }, blue: { id: 'blue-undo', name: 'Azul' },
      },
    })).toMatchObject({ ok: true });
    socket.emit('match:start', identity);
    socket.emit('match:event', { ...identity, judgeId: 'arbiter', competitor: 'red', type: 'minus_point' });
    socket.emit('match:skipToFlags', identity);
    for (const judgeId of ['J1', 'J2', 'J3', 'J4']) {
      socket.emit('mesa:flagVote', { ...identity, judgeId, vote: 'red' });
    }
    socket.emit('mesa:confirmRound', identity);
    await emitAck(socket, 'match:result:get', identity);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      winner: 'red', status: 'pending_confirmation',
    });
    socket.emit('match:undoArbiter', identity);
    expect(await emitAck(socket, 'mesa:undoRound', { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: true, revision: 1 });
    expect(activeState.roundFlags).toHaveLength(0);
    expect(activeState.matchState?.phase).toBe('rest');
    expect(activeState.matchState?.result).toBeNull();
    expect(activeState.matchState?.timeLeft).toBe(0);
    expect(Object.fromEntries(activeState.judgeVotes)).toEqual({ J1: 'red', J2: 'red', J3: 'red', J4: 'red' });
    expect(activeState.matchState?.rounds[0]?.events).toMatchObject([
      { judgeId: 'arbiter', competitor: 'red', type: 'minus_point' },
    ]);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    expect(db.loadMatchSnapshot()?.data).toMatchObject({ resultRevision: 1, judgeVotes: { J1: 'red' },
      matchState: { phase: 'rest', result: null } });
    expect(db.getFights(activeState.matchTournamentId!)[0]).toMatchObject({ completed: 0, winner: null });
  });

  it('persists table-chief penalties before an unfinished RR bout can be recovered', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('RR durable penalties', '');
    const identity = { categoryId: 'category-rr-penalties', matchId: 'fight-rr-penalties' };
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId,
      tournamentName: 'RR durable penalties',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: {
        id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'red-penalties', name: 'Rojo' },
        blue: { id: 'blue-penalties', name: 'Azul' },
      },
    })).toMatchObject({ ok: true });
    socket.emit('match:start', identity);
    socket.emit('match:event', { ...identity, judgeId: 'arbiter', competitor: 'red', type: 'minus_point' });
    socket.emit('match:event', { ...identity, judgeId: 'arbiter', competitor: 'blue', type: 'warning_minor' });
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.matchState?.rounds[0]?.events).toHaveLength(2);
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0]?.events).toMatchObject([
      { judgeId: 'arbiter', competitor: 'red', type: 'minus_point' },
      { judgeId: 'arbiter', competitor: 'blue', type: 'warning_minor' },
    ]);
    socket.emit('match:undoArbiter', identity);
    await emitAck(socket, 'match:result:get', identity);
    expect(db.loadMatchSnapshot()?.data?.matchState?.rounds[0]?.events).toMatchObject([
      { judgeId: 'arbiter', competitor: 'red', type: 'minus_point' },
    ]);
  });

  it('requires every table-chief judge flag for a regular Round Robin bout', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('RR mesa', '');
    const identity = { categoryId: 'category-rr-flags', matchId: 'fight-rr-flags' };
    const loaded = await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId,
      tournamentName: 'RR mesa',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: {
        id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        requireIndividualFlags: true,
        red: { id: 'red-rr', name: 'Rojo' }, blue: { id: 'blue-rr', name: 'Azul' },
      },
    });
    expect(loaded.ok).toBe(true);

    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J1', vote: 'red' });
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.judgeVotes.size).toBe(0); // voting before the bout starts is rejected

    socket.emit('match:skipToFlags', identity);
    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J5', vote: 'red' });
    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J1', vote: 'red' });
    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J2', vote: 'blue' });
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.matchState?.phase).toBe('rest');
    expect(Object.fromEntries(activeState.judgeVotes)).toEqual({ J1: 'red', J2: 'blue' });
    expect(db.loadMatchSnapshot()?.data?.judgeVotes).toEqual({ J1: 'red', J2: 'blue' });
    expect(db.loadMatchSnapshot()?.data?.matchState?.phase).toBe('rest');

    const remote = createClient(serverAddress!, { transports: ['websocket'], forceNew: true });
    extraClients.push(remote);
    await new Promise<void>((resolve) => remote.once('connect', resolve));
    expect(await emitAck<{ judgeId?: string }>(remote, 'judge:connect', {
      requestedId: 'J3', token: activeState.ringToken,
    })).toMatchObject({ judgeId: 'J3' });
    remote.emit('judge:vote', { ...identity, judgeId: 'J3', vote: 'red' });
    remote.emit('mesa:flagVote', { ...identity, judgeId: 'J3', vote: 'red' });
    await emitAck(remote, 'match:result:get', identity);
    expect(Object.fromEntries(activeState.judgeVotes)).toEqual({ J1: 'red', J2: 'blue' });
    expect(db.loadMatchSnapshot()?.data?.judgeVotes).toEqual({ J1: 'red', J2: 'blue' });

    socket.emit('mesa:confirmRound', identity);
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.roundFlags).toHaveLength(0);
    expect(activeState.matchState?.phase).toBe('rest');
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();

    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J3', vote: 'red' });
    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J4', vote: 'blue' });
    socket.emit('mesa:confirmRound', identity);
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.roundFlags).toMatchObject([
      { red: 2, blue: 2, winner: 'draw', votes: {
        J1: 'red', J2: 'blue', J3: 'red', J4: 'blue',
      } },
    ]);
    expect(activeState.matchState?.result?.winner).toBe('draw');
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      flagsRed: 2, flagsBlue: 2, winner: 'draw', status: 'pending_confirmation',
    });
    expect(await emitAck<{ ok: boolean; result: { status: string } }>(socket, 'match:saveFallo', { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: true, result: { status: 'confirmed' } });
  });

  it('does not impose individual-vote enforcement on direct elimination', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('Eliminación mesa', '');
    const identity = { categoryId: 'category-direct', matchId: 'fight-direct' };
    const loaded = await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId,
      tournamentName: 'Eliminación mesa',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: {
        id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring',
        red: { id: 'red-direct', name: 'Rojo' }, blue: { id: 'blue-direct', name: 'Azul' },
      },
    });
    expect(loaded.ok).toBe(true);
    socket.emit('match:skipToFlags', identity);
    socket.emit('mesa:flagVote', { ...identity, judgeId: 'J1', vote: 'red' });
    socket.emit('mesa:confirmRound', identity);
    await emitAck(socket, 'match:result:get', identity);
    expect(activeState.matchState?.result?.winner).toBe('red');
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      flagsRed: 1, flagsBlue: 0, winner: 'red', status: 'pending_confirmation',
    });
  });

  it('accepts only registered remote judges in points mode and reaches majority', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('GP remoto', '');
    const identity = { categoryId: 'category-gp-remote', matchId: 'fight-gp-remote' };
    const loaded = await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'GP remoto',
      rules: { ...baselineRules, judgesCount: 3, judgingMode: 'points' },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring', goldenPoint: true,
        red: { id: 'red-remote', name: 'Rojo' }, blue: { id: 'blue-remote', name: 'Azul' } },
    });
    expect(loaded.ok).toBe(true);
    const judges: Socket[] = [];
    for (let i = 1; i <= 3; i++) {
      const judge = createClient(serverAddress!, { transports: ['websocket'], forceNew: true });
      extraClients.push(judge);
      await new Promise<void>((resolve) => judge.once('connect', resolve));
      expect(await emitAck<{ judgeId: string }>(judge, 'judge:connect', { requestedId: `J${i}`, token: activeState.ringToken }))
        .toMatchObject({ judgeId: `J${i}` });
      judges.push(judge);
    }
    const payload = (judgeId: string, competitor: 'red' | 'blue') => ({ ...identity, judgeId, competitor, attempt: 1 });
    expect(await emitAck<{ ok: boolean; code?: string }>(socket, 'mesa:goldenVote', payload('J1', 'red')))
      .toMatchObject({ ok: false, code: 'wrong_judging_mode' });
    expect(await emitAck<{ ok: boolean; code?: string }>(socket, 'mesa:confirmGoldenOutcome',
      { ...identity, attempt: 1 })).toMatchObject({ ok: false, code: 'wrong_judging_mode' });
    expect(await emitAck<{ ok: boolean; code?: string }>(judges[0], 'golden:vote', { ...payload('J1', 'red'), matchId: 'stale' }))
      .toMatchObject({ ok: false, code: 'stale_match_context' });
    expect(await emitAck<{ ok: boolean; code?: string }>(judges[0], 'golden:vote', payload('J2', 'red')))
      .toMatchObject({ ok: false, code: 'unauthorized_judge' });
    expect(await emitAck<{ ok: boolean }>(judges[0], 'golden:vote', payload('J1', 'red'))).toMatchObject({ ok: true });
    expect(await emitAck<{ ok: boolean }>(judges[1], 'golden:vote', payload('J2', 'blue'))).toMatchObject({ ok: true });
    expect(activeState.matchState?.phase).toBe('golden_point');
    expect(await emitAck<{ ok: boolean }>(judges[2], 'golden:vote', payload('J3', 'red'))).toMatchObject({ ok: true });
    expect(activeState.matchState?.result).toMatchObject({ winner: 'red', reason: 'golden_point' });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({ winner: 'red', status: 'pending_confirmation' });
  });

  it('keeps Golden Point untimed, authenticated and durable through vote attempts', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    const identity = { categoryId: 'category-gp', matchId: 'fight-gp' };
    activeState.activeTournamentId = db.createTournament('Prueba GP', '');
    activeState.matchPaused = true; // stale pause from the preceding fight must not carry over
    const loaded = await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId,
      tournamentName: 'Prueba GP',
      rules: { ...baselineRules, judgesCount: 4 },
      match: {
        id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring', goldenPoint: true,
        red: { id: 'red-gp', name: 'Rojo' }, blue: { id: 'blue-gp', name: 'Azul' },
      },
    });
    expect(loaded.ok).toBe(true);
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', timeLeft: 0, goldenPoint: { attempt: 1 } });
    expect(activeState.matchPaused).toBe(false);
    const registered = await emitAck<{ judgeId?: string }>(socket, 'judge:connect', { requestedId: 'J1', token: activeState.ringToken });
    expect(registered.judgeId).toBe('J1');
    const vote = (judgeId: string, competitor: 'red' | 'blue', attempt: number, event = 'mesa:goldenVote') =>
      emitAck<{ ok: boolean; code?: string }>(socket, event, { ...identity, judgeId, competitor, attempt });
    expect(await vote('J2', 'red', 1, 'golden:vote')).toMatchObject({ ok: false, code: 'unauthorized_judge' });
    expect(await vote('J1', 'red', 1, 'golden:vote')).toMatchObject({ ok: false, code: 'wrong_judging_mode' });
    expect(await vote('J1', 'red', 1)).toMatchObject({ ok: false, code: 'wrong_judging_mode' });
    socket.disconnect();
    const table = createClient(serverAddress!, { transports: ['websocket'], forceNew: true });
    extraClients.push(table);
    await new Promise<void>((resolve) => table.once('connect', resolve));
    const tableVote = (judgeId: string, competitor: 'red' | 'blue', attempt: number) =>
      emitAck<{ ok: boolean; code?: string }>(table, 'mesa:goldenVote', { ...identity, judgeId, competitor, attempt });
    const confirm = (attempt: number) =>
      emitAck<{ ok: boolean; code?: string; alreadyApplied?: boolean; attempt?: number }>(
        table, 'mesa:confirmGoldenOutcome', { ...identity, attempt });
    expect(await tableVote('J1', 'red', 1)).toMatchObject({ ok: true });
    expect(await tableVote('J1', 'blue', 1)).toMatchObject({ ok: true });
    expect(await tableVote('J1', 'red', 1)).toMatchObject({ ok: true });
    expect(db.loadMatchSnapshot()?.data?.matchState?.goldenPoint).toMatchObject({ attempt: 1, votes: { J1: 'red' } });
    expect(await tableVote('J2', 'blue', 1)).toMatchObject({ ok: true });
    expect(await tableVote('J3', 'red', 1)).toMatchObject({ ok: true });
    expect(await tableVote('J4', 'blue', 1)).toMatchObject({ ok: true });
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', result: null,
      goldenPoint: { attempt: 1, votes: { J1: 'red', J2: 'blue', J3: 'red', J4: 'blue' } } });
    expect(await confirm(1)).toMatchObject({ ok: true, attempt: 2 });
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', goldenPoint: { attempt: 2, votes: {} } });
    expect(await confirm(1)).toMatchObject({ ok: true, alreadyApplied: true, attempt: 2 });
    expect(await tableVote('J1', 'red', 1)).toMatchObject({ ok: false, code: 'stale_or_duplicate_vote' });
    table.emit('match:event', { ...identity, judgeId: 'J1', competitor: 'red', type: 'pts_1' });
    table.emit('match:resolveJury', { ...identity, winner: 'red' });
    table.emit('mesa:flagVote', { ...identity, judgeId: 'J1', vote: 'red' });
    table.emit('match:finishRound', identity);
    await emitAck(table, 'match:result:get', identity);
    expect(activeState.matchState?.phase).toBe('golden_point');
    expect(activeState.judgeVotes.size).toBe(0);
    expect(await tableVote('J1', 'blue', 2)).toMatchObject({ ok: true });
    expect(await tableVote('J2', 'blue', 2)).toMatchObject({ ok: true });
    expect(await tableVote('J3', 'blue', 2)).toMatchObject({ ok: true });
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', result: null });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    expect(await confirm(2)).toMatchObject({ ok: true, attempt: 2 });
    expect(await confirm(2)).toMatchObject({ ok: true, alreadyApplied: true });
    expect(activeState.matchState).toMatchObject({ phase: 'finished', result: { winner: 'blue', reason: 'golden_point' } });
    expect(db.loadMatchSnapshot()?.data?.matchState?.result).toMatchObject({ winner: 'blue' });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      winner: 'blue', flagsRed: 0, flagsBlue: 3, status: 'pending_confirmation',
    });
  });

  it('keeps table-chief Golden Point votes provisional and replaceable before explicit confirmation', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    const identity = { categoryId: 'category-reviewable-gp', matchId: 'fight-reviewable-gp' };
    activeState.activeTournamentId = db.createTournament('Reviewable GP', '');
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'Reviewable GP',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring', goldenPoint: true,
        red: { id: 'review-red', name: 'Rojo' }, blue: { id: 'review-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    const vote = (judgeId: string, competitor: 'red' | 'blue', attempt = 1) =>
      emitAck<{ ok: boolean; code?: string; alreadyApplied?: boolean }>(socket, 'mesa:goldenVote',
        { ...identity, judgeId, competitor, attempt });
    for (const judgeId of ['J1', 'J2', 'J3']) {
      expect(await vote(judgeId, 'red')).toMatchObject({ ok: true });
    }
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', result: null,
      goldenPoint: { votes: { J1: 'red', J2: 'red', J3: 'red' } } });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    expect(await vote('J3', 'blue')).toMatchObject({ ok: true });
    expect(await vote('J3', 'blue')).toMatchObject({ ok: true, alreadyApplied: true });
    expect(activeState.matchState?.goldenPoint?.votes.J3).toBe('blue');
    const confirm = (attempt = 1) => emitAck<{ ok: boolean; code?: string; attempt?: number }>(
      socket, 'mesa:confirmGoldenOutcome', { ...identity, attempt });
    expect(await emitAck<{ ok: boolean; code?: string }>(socket, 'mesa:confirmGoldenOutcome',
      { ...identity, matchId: 'wrong-fight', attempt: 1 }))
      .toMatchObject({ ok: false, code: 'stale_match_context' });
    expect(await confirm(2)).toMatchObject({ ok: false, code: 'wrong_phase' });
    expect(await confirm()).toMatchObject({ ok: false, code: 'insufficient_votes' });
    expect(await vote('J4', 'blue')).toMatchObject({ ok: true });
    expect(await confirm()).toMatchObject({ ok: true, attempt: 2 });
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', result: null,
      goldenPoint: { attempt: 2, votes: {} } });
    expect(db.loadMatchSnapshot()?.data?.matchState?.goldenPoint).toMatchObject({ attempt: 2, votes: {} });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
  });

  it('does not finish or acknowledge a majority if pending-result persistence fails', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    const identity = { categoryId: 'category-gp-fail-closed', matchId: 'fight-gp-fail-closed' };
    activeState.activeTournamentId = db.createTournament('GP fail closed', '');
    expect(await emitAck<{ ok: boolean }>(socket, 'match:load', {
      categoryId: identity.categoryId, tournamentName: 'GP fail closed',
      rules: { ...baselineRules, judgesCount: 4, judgingMode: 'flags' },
      match: { id: identity.matchId, ringId: 'ring-1', matchMode: 'sparring', goldenPoint: true,
        red: { id: 'gp-fail-red', name: 'Rojo' }, blue: { id: 'gp-fail-blue', name: 'Azul' } },
    })).toMatchObject({ ok: true });
    for (const judgeId of ['J1', 'J2', 'J3']) {
      expect(await emitAck<{ ok: boolean }>(socket, 'mesa:goldenVote',
        { ...identity, judgeId, competitor: 'red', attempt: 1 })).toMatchObject({ ok: true });
    }
    expect(await emitAck<{ ok: boolean }>(socket, 'mesa:goldenVote',
      { ...identity, judgeId: 'J3', competitor: 'blue', attempt: 1 })).toMatchObject({ ok: true });
    expect(await emitAck<{ ok: boolean }>(socket, 'mesa:goldenVote',
      { ...identity, judgeId: 'J4', competitor: 'red', attempt: 1 })).toMatchObject({ ok: true });
    const confirm = () => emitAck<{ ok: boolean; code?: string; alreadyApplied?: boolean }>(
      socket, 'mesa:confirmGoldenOutcome', { ...identity, attempt: 1 });
    db.default.exec(`CREATE TRIGGER reject_gp_pending BEFORE INSERT ON match_results
      BEGIN SELECT RAISE(ABORT, 'test pending result write failure'); END`);
    expect(await confirm()).toMatchObject({ ok: false, code: 'persistence_failed' });
    expect(activeState.matchState).toMatchObject({ phase: 'golden_point', result: null });
    expect(db.loadMatchSnapshot()?.data?.matchState).toMatchObject({ phase: 'golden_point', result: null });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    db.default.exec('DROP TRIGGER reject_gp_pending');
    const updated = new Promise<{ matchState: { phase: string } }>((resolve) =>
      socket.once('state:update', resolve));
    expect(await confirm()).toMatchObject({ ok: true });
    expect(await updated).toMatchObject({ matchState: { phase: 'finished' } });
    const retryUpdate = new Promise<{ matchState: { phase: string } }>((resolve) =>
      socket.once('state:update', resolve));
    expect(await confirm()).toMatchObject({ ok: true, alreadyApplied: true });
    expect(await retryUpdate).toMatchObject({ matchState: { phase: 'finished' } });
    expect(activeState.matchState).toMatchObject({ phase: 'finished',
      result: { winner: 'red', reason: 'golden_point' } });
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({
      status: 'pending_confirmation', winner: 'red', flagsRed: 3, flagsBlue: 1,
    });
    expect(db.loadMatchSnapshot()?.data?.matchState).toMatchObject({ phase: 'finished' });
  });
  it.each([
    {
      name: "unanimous votes and idempotent confirmation",
      judgesCount: 4,
      votes: [["J1", "red"], ["J2", "red"], ["J3", "red"], ["J4", "red"]],
      flagsRed: 4,
      flagsBlue: 0,
      recoverWithoutSnapshot: false,
    },
    {
      name: "updated, absent and out-of-range votes with snapshotless recovery",
      judgesCount: 5,
      votes: [
        ["J1", "blue"], ["J1", "red"], ["J2", "red"],
        ["J3", "blue"], ["J4", "draw"], ["J6", "blue"],
      ],
      flagsRed: 2,
      flagsBlue: 1,
      recoverWithoutSnapshot: true,
    },
  ])("preserves durable Tul flag counts for $name", async (scenario) => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament("Torneo Tul", "");
    const identity = { categoryId: "category-tul", matchId: "fight-tul" };
    const loaded = await emitAck<{ ok: boolean; tournamentId: number }>(socket, "match:load", {
      categoryId: identity.categoryId,
      tournamentName: "Torneo Tul",
      rules: { ...baselineRules, judgesCount: scenario.judgesCount },
      match: {
        id: identity.matchId,
        ringId: "ring-1",
        category: "Adultos",
        matchMode: "tul",
        red: { id: "red-tul", name: "Rojo Tul" },
        blue: { id: "blue-tul", name: "Azul Tul" },
      },
    });
    expect(loaded.ok).toBe(true);
    expect(db.getSelectedTournamentId()).toBe(loaded.tournamentId);
    socket.emit("match:start", identity);
    for (const [judgeId, vote] of scenario.votes) {
      socket.emit("mesa:flagVote", { ...identity, judgeId, vote });
    }
    socket.emit("tul:finish", identity);
    const pending = await emitAck<{ ok: boolean; result: unknown }>(
      socket, "match:result:get", identity,
    );
    const expectedResult = {
      fightId: identity.matchId,
      categoryId: identity.categoryId,
      tournamentId: loaded.tournamentId,
      winner: "red",
      flagsRed: scenario.flagsRed,
      flagsBlue: scenario.flagsBlue,
    };
    expect(pending).toMatchObject({
      ok: true,
      result: { ...expectedResult, status: "pending_confirmation" },
    });
    expect(activeState.roundFlags).toEqual([]);
    expect(db.default.prepare("SELECT flags_red, flags_blue, status FROM match_results").get())
      .toEqual({
        flags_red: scenario.flagsRed,
        flags_blue: scenario.flagsBlue,
        status: "pending_confirmation",
      });

    // Confirmation must use the durable pending counts, not vanished live votes.
    activeState.judgeVotes.clear();
    if (scenario.recoverWithoutSnapshot) {
      db.clearMatchSnapshot();
      activeState.match = null;
      activeState.matchState = null;
      expect(db.getActiveMatchLock()).toMatchObject({
        fightId: identity.matchId,
        categoryId: identity.categoryId,
        resultStatus: "pending_confirmation",
      });
    }
    const confirmed = await emitAck<{ ok: boolean; result?: unknown }>(
      socket, "match:saveFallo", { ...identity, expectedRevision: 0 },
    );
    expect(confirmed).toMatchObject({
      ok: true,
      result: { ...expectedResult, status: "confirmed" },
    });
    if (!scenario.recoverWithoutSnapshot) {
      const repeated = await emitAck<{ ok: boolean; result?: unknown }>(
        socket, "match:saveFallo", { ...identity, expectedRevision: 0 },
      );
      expect(repeated).toMatchObject({
        ok: true,
        result: { ...expectedResult, status: "confirmed", alreadyConfirmed: true },
      });
    }
    expect(db.getConfirmedMatchResult(identity.categoryId, identity.matchId))
      .toMatchObject({ ...expectedResult, status: "confirmed" });
    expect(db.getFights(loaded.tournamentId)).toMatchObject([{
      id: identity.matchId,
      completed: 1,
      winner: "red",
      flags_red: scenario.flagsRed,
      flags_blue: scenario.flagsBlue,
    }]);
    expect(db.countMatchResults(identity.matchId)).toBe(1);
    expect(db.getActiveMatchLock()).toBeNull();
  });

  it('confirms a durable pending result after restart without a recoverable snapshot', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    const tournamentId = db.createTournament('Torneo', '');
    db.resolveCategoryTournament({
      categoryId: 'category-a',
      tournamentName: 'Torneo',
      categoryName: 'Adultos',
      preferredTournamentId: tournamentId,
    });
    db.upsertCompetitor({ id: 'red-a', tournament_id: tournamentId, name: 'Rojo A' });
    db.upsertCompetitor({ id: 'blue-a', tournament_id: tournamentId, name: 'Azul A' });
    db.insertFightIfNew({ id: 'fight-a', tournament_id: tournamentId, red_id: 'red-a', blue_id: 'blue-a' });
    db.savePendingMatchResult({
      fightId: 'fight-a',
      categoryId: 'category-a',
      tournamentId,
      winner: 'red',
      reason: 'points',
      flagsRed: 0,
      flagsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    });
    db.clearMatchSnapshot();
    activeState.match = null;
    activeState.matchCategoryId = 'category-a';
    activeState.matchTournamentId = tournamentId;
    activeState.resultConfirmed = false;

    expect(db.getActiveMatchLock()).toMatchObject({
      fightId: 'fight-a',
      categoryId: 'category-a',
      resultStatus: 'pending_confirmation',
    });
    const confirmed = await emitAck<{ ok: boolean; result?: { status: string } }>(socket, 'match:saveFallo', {
      expectedRevision: 0,
      categoryId: 'category-a',
      matchId: 'fight-a',
    });
    expect(confirmed).toMatchObject({ ok: true, result: { status: 'confirmed' } });
    expect(db.getActiveMatchLock()).toBeNull();
  });

  it('rejects incompatible loads, recovers lost acknowledgements and keeps failed saves locked', async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament('Torneo', '');
    const rules = baselineRules as unknown as typeof activeState.rules;
    const loadA = {
      categoryId: 'category-a',
      tournamentName: 'Torneo',
      rules,
      match: {
        id: 'fight-a',
        ringId: 'ring-1',
        category: 'Adultos',
        red: { id: 'red-a', name: 'Rojo A' },
        blue: { id: 'blue-a', name: 'Azul A' },
      },
    };

    const loaded = await emitAck<{ ok: boolean }>(socket, 'match:load', loadA);
    const repeatedLoad = await emitAck<{ ok: boolean; alreadyLoaded?: boolean }>(socket, 'match:load', loadA);
    const incompatibleLoad = await emitAck<{ ok: boolean; code?: string }>(socket, 'match:load', {
      ...loadA,
      categoryId: 'category-b',
      match: { ...loadA.match, id: 'fight-b' },
    });
    expect(loaded.ok).toBe(true);
    expect(repeatedLoad).toMatchObject({ ok: true, alreadyLoaded: true });
    expect(incompatibleLoad).toMatchObject({ ok: false, code: 'match_in_progress' });
    expect(db.default.prepare('SELECT COUNT(*) AS count FROM category_tournaments').get()).toMatchObject({ count: 1 });

    activeState.matchState = {
      phase: 'finished',
      currentRound: 1,
      timeLeft: 0,
      rounds: [],
      firstPoint: null,
      pendingJuryDecision: false,
      result: { winner: 'red', reason: 'points' },
    };
    activeState.roundFlags = [
      { red: 3, blue: 1, draw: 0, winner: "red", votes: {} },
      { red: 2, blue: 2, draw: 0, winner: "draw", votes: {} },
    ];
    activeState.judgeVotes = new Map([
      ["J1", "blue"], ["J2", "blue"], ["J3", "blue"], ["J4", "blue"],
    ]);
    const identity = { categoryId: 'category-a', matchId: 'fight-a' };
    socket.emit('match:saveFallo', { ...identity, expectedRevision: 0 });
    const recovered = await emitAck<{ ok: boolean; result: { status: string } | null }>(socket, 'match:result:get', identity);
    expect(recovered).toMatchObject({
      ok: true,
      result: { status: 'confirmed', flagsRed: 5, flagsBlue: 3 },
    });
    const repeatedConfirmation = await emitAck<{ ok: boolean; result?: { alreadyConfirmed?: boolean } }>(socket, 'match:saveFallo', { ...identity, expectedRevision: 0 });
    expect(repeatedConfirmation).toMatchObject({ ok: true, result: { alreadyConfirmed: true } });
    expect(db.countMatchResults('fight-a')).toBe(1);
    expect(db.getActiveMatchLock()).toBeNull();

    socket.disconnect();
    const reconnectingClient = createClient(`http://127.0.0.1:${(socketServer?.httpServer.address() as AddressInfo).port}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    client = reconnectingClient;
    await new Promise<void>((resolve, reject) => {
      reconnectingClient.once('connect', resolve);
      reconnectingClient.once('connect_error', reject);
    });
    const afterReconnect = await emitAck<{ ok: boolean; result: { status: string } | null }>(reconnectingClient, 'match:result:get', identity);
    expect(afterReconnect).toMatchObject({ ok: true, result: { status: 'confirmed' } });

    const loadB = await emitAck<{ ok: boolean }>(reconnectingClient, 'match:load', {
      ...loadA,
      categoryId: 'category-b',
      match: { ...loadA.match, id: 'fight-b', red: { id: 'red-b', name: 'Rojo B' }, blue: { id: 'blue-b', name: 'Azul B' } },
    });
    expect(loadB.ok).toBe(true);
    activeState.matchState = {
      ...activeState.matchState!,
      result: { winner: 'blue', reason: 'points' },
    };
    db.default.exec(`
      CREATE TRIGGER reject_socket_result BEFORE INSERT ON match_results
      BEGIN SELECT RAISE(ABORT, 'test write failure'); END;
    `);
    const failedConfirmation = await emitAck<{ ok: boolean }>(reconnectingClient, 'match:saveFallo', {
      expectedRevision: 0,
      categoryId: 'category-b',
      matchId: 'fight-b',
    });
    expect(failedConfirmation.ok).toBe(false);
    expect(db.getActiveMatchLock()).toMatchObject({ fightId: 'fight-b', categoryId: 'category-b' });
    expect(db.countMatchResults('fight-b')).toBe(0);
  });
});


async function pendingFlagsBout() {
  const context = await setupSocketClient();
  const { db, activeState, socket } = context;
  activeState.activeTournamentId = db.createTournament("RR correction", "");
  const identity = { categoryId: "rr-correct", matchId: "rr-correct-fight" };
  expect(await emitAck(socket, "match:load", { categoryId: identity.categoryId,
    tournamentName: "RR correction", rules: { ...baselineRules, judgesCount: 4, judgingMode: "flags",
      rounds: { ...baselineRules.rounds, count: 1 } },
    match: { id: identity.matchId, ringId: "TEST", matchMode: "sparring", requireIndividualFlags: true,
      red: { id: "r", name: "Rojo" }, blue: { id: "b", name: "Azul" } },
  })).toMatchObject({ ok: true });
  socket.emit("match:skipToFlags", identity);
  for (let i = 1; i <= 4; i++) socket.emit("mesa:flagVote", { ...identity, judgeId: `J${i}`, vote: "red" });
  socket.emit("mesa:confirmRound", identity);
  await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId)?.status)
    .toBe("pending_confirmation"));
  return { ...context, identity };
}

describe("correction of pending individual flags", () => {
  it.each([1, 2])("replaces 4-0 by %i red flags once and rejects stale confirmations", async (redFlags) => {
    const { db, activeState, socket, identity } = await pendingFlagsBout();
    expect(await emitAck(socket, "mesa:undoRound", { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: true, revision: 1 });
    expect(await emitAck(socket, "match:saveFallo", identity)).toMatchObject({ ok: false });
    for (let i = 1; i <= 4; i++) socket.emit("mesa:flagVote", { ...identity, judgeId: `J${i}`,
      vote: i <= redFlags ? "red" : "blue" });
    socket.emit("mesa:confirmRound", identity);
    await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId))
      .toMatchObject({ flagsRed: redFlags, flagsBlue: 4 - redFlags,
        winner: redFlags === 2 ? "draw" : "blue", revision: 1 }));
    expect(activeState.matchState?.phase).toBe("finished");
    expect(activeState.roundFlags).toHaveLength(1);
    expect(await emitAck(socket, "match:saveFallo", { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "stale_result_revision" });
    expect(await emitAck(socket, "match:saveFallo", { ...identity, expectedRevision: 1 }))
      .toMatchObject({ ok: true, result: { status: "confirmed", revision: 1 } });
    expect(db.countMatchResults(identity.matchId)).toBe(1);
    expect(await emitAck(socket, "mesa:undoRound", { ...identity, expectedRevision: 1 }))
      .toMatchObject({ ok: false, code: "result_confirmed" });
    expect(await emitAck(socket, "match:saveFallo", { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "stale_result_revision" });
  });

  it("does not change memory or durable result if reopening snapshot persistence fails", async () => {
    const { db, activeState, socket, identity } = await pendingFlagsBout();
    const before = JSON.stringify({ flags: activeState.roundFlags, matchState: activeState.matchState });
    const snapshot = db.loadMatchSnapshot();
    db.default.exec(`CREATE TRIGGER reject_reopen BEFORE INSERT ON match_snapshot
      BEGIN SELECT RAISE(ABORT, 'reopen persistence failure'); END`);
    expect(await emitAck(socket, "mesa:undoRound", { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "persistence_failed" });
    expect(JSON.stringify({ flags: activeState.roundFlags, matchState: activeState.matchState })).toBe(before);
    expect(db.loadMatchSnapshot()).toEqual(snapshot);
    expect(db.getMatchResult(identity.categoryId, identity.matchId))
      .toMatchObject({ winner: "red", flagsRed: 4, revision: 0 });
    expect(db.getFights(activeState.matchTournamentId!)[0]).toMatchObject({ completed: 1 });
  });

  it("rejects a wrong context with an ACK and never invents missing historic judge votes", async () => {
    const { db, activeState, socket, identity } = await pendingFlagsBout();
    expect(await emitAck(socket, "mesa:undoRound", { ...identity, categoryId: "other", expectedRevision: 0 }))
      .toMatchObject({ ok: false, code: "stale_match_context" });
    expect(activeState.roundFlags).toHaveLength(1);
    activeState.roundFlags[0].votes = {};
    expect(await emitAck(socket, "mesa:undoRound", { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: true, revision: 1, requiresAllVotes: true });
    expect(activeState.judgeVotes.size).toBe(0);
    socket.emit("mesa:confirmRound", identity);
    await emitAck(socket, "match:result:get", identity);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    expect(activeState.matchState?.phase).toBe("rest");
  });

  it("persists increasing revisions across multiple corrections and database restart", async () => {
    const { db, activeState, socket, identity } = await pendingFlagsBout();
    for (let revision = 0; revision < 2; revision++) {
      expect(await emitAck(socket, "mesa:undoRound", { ...identity, expectedRevision: revision }))
        .toMatchObject({ ok: true, revision: revision + 1 });
      expect(db.loadMatchSnapshot()?.data).toMatchObject({ resultRevision: revision + 1,
        matchState: { phase: "rest", result: null }, judgeVotes: { J1: "red", J4: "red" } });
      if (revision === 0) {
        socket.emit("mesa:confirmRound", identity);
        await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId)?.status)
          .toBe("pending_confirmation"));
      }
    }
    expect(activeState.matchState?.phase).toBe("rest");
    expect(db.getMatchResultRevision(identity.categoryId, identity.matchId)).toBe(2);
    // Open another connection to emulate durable process recovery without altering this test's socket.
    const Database = (await import("better-sqlite3")).default;
    const recovered = new Database(path.join(directory!, "tournament.db"));
    expect(recovered.prepare("SELECT result_revision FROM fights WHERE id = ?").get(identity.matchId))
      .toEqual({ result_revision: 2 });
    const row = recovered.prepare("SELECT data FROM match_snapshot WHERE id=1").get() as { data: string };
    expect(JSON.parse(row.data)).toMatchObject({ resultRevision: 2,
      matchState: { phase: "rest", result: null }, judgeVotes: { J1: "red", J4: "red" } });
    recovered.close();
  });
});


describe("flag correction durability guards", () => {
  it.each([false, true])("identifies a pending load blocker by names without exposing UUIDs (DB fallback %s)", async (fallback) => {
    const { db, activeState, socket, identity } = await pendingFlagsBout();
    if (fallback) activeState.match = null;
    const response = await emitAck<{ ok: boolean; code: string; error: string;
      blockedFightId: string; blockedCategoryId: string; pendingConfirmation: boolean;
      blockedRedName: string; blockedBlueName: string }>(socket, "match:load", {
      categoryId: identity.categoryId, rules: baselineRules,
      match: { id: "different-fight", red: { id: "new-r", name: "Nuevo rojo" },
        blue: { id: "new-b", name: "Nuevo azul" } },
    });
    expect(response).toMatchObject({ ok: false, code: "match_in_progress",
      blockedFightId: identity.matchId, blockedCategoryId: identity.categoryId,
      pendingConfirmation: true, blockedRedName: "Rojo", blockedBlueName: "Azul" });
    expect(response.error).toContain("Rojo vs. Azul");
    expect(response.error).toMatch(/confirmar el resultado/);
    expect(response.error).not.toContain(identity.matchId);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toMatchObject({ status: "pending_confirmation" });
  });

  it("still permits legacy between-round undo without a pending result or revision", async () => {
    const { db, activeState, socket } = await setupSocketClient();
    activeState.activeTournamentId = db.createTournament("Between rounds", "");
    const identity = { categoryId: "between-round", matchId: "between-fight" };
    expect(await emitAck(socket, "match:load", { categoryId: identity.categoryId,
      rules: { ...baselineRules, judgesCount: 4, judgingMode: "flags", rounds: { ...baselineRules.rounds, count: 2 } },
      match: { id: identity.matchId, requireIndividualFlags: true,
        red: { id: "br", name: "Red" }, blue: { id: "bb", name: "Blue" } } })).toMatchObject({ ok: true });
    socket.emit("match:skipToFlags", identity);
    for (let i = 1; i <= 4; i++) socket.emit("mesa:flagVote", { ...identity, judgeId: `J${i}`, vote: "red" });
    socket.emit("mesa:confirmRound", identity);
    await emitAck(socket, "match:result:get", identity);
    expect(activeState.roundFlags).toHaveLength(1);
    expect(await emitAck(socket, "mesa:undoRound", identity)).toMatchObject({ ok: true, revision: 0 });
    expect(activeState.roundFlags).toHaveLength(0);
    expect(activeState.matchState?.phase).toBe("rest");
  });

  it("retains reopened revision, votes and sanctions if a corrected vote cannot be persisted", async () => {
    const { db, activeState, socket, identity } = await pendingFlagsBout();
    expect(await emitAck(socket, "mesa:undoRound", { ...identity, expectedRevision: 0 }))
      .toMatchObject({ ok: true, revision: 1 });
    expect(await emitAck(socket, "mesa:setSanctionCount", { ...identity, competitor: "red", kind: "warning",
      expectedCount: 0, count: 1 })).toMatchObject({ ok: true });
    socket.emit("mesa:flagVote", { ...identity, judgeId: "J4", vote: "blue" });
    await emitAck(socket, "match:result:get", identity);
    const snapshot = db.loadMatchSnapshot();
    db.default.exec(`CREATE TRIGGER reject_corrected_vote BEFORE INSERT ON match_results
      BEGIN SELECT RAISE(ABORT, 'corrected vote persist failure'); END`);
    socket.emit("mesa:confirmRound", identity);
    await emitAck(socket, "match:result:get", identity);
    expect(activeState.matchState?.phase).toBe("rest");
    expect(activeState.roundFlags).toHaveLength(0);
    expect(activeState.judgeVotes.get("J4")).toBe("blue");
    expect(db.loadMatchSnapshot()).toEqual(snapshot);
    expect(db.getMatchResultRevision(identity.categoryId, identity.matchId)).toBe(1);
    expect(db.getMatchResult(identity.categoryId, identity.matchId)).toBeNull();
    db.default.exec("DROP TRIGGER reject_corrected_vote");
    socket.emit("mesa:confirmRound", identity);
    await vi.waitFor(() => expect(db.getMatchResult(identity.categoryId, identity.matchId))
      .toMatchObject({ revision: 1, flagsRed: 3, flagsBlue: 1, warningsRed: 1 }));
    expect(await emitAck(socket, "match:saveFallo", { ...identity, expectedRevision: 1 }))
      .toMatchObject({ ok: true, result: { status: "confirmed" } });
  });
});
