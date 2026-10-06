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

afterEach(async () => {
  client?.disconnect();
  client = null;
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
      socket, "match:saveFallo", identity,
    );
    expect(confirmed).toMatchObject({
      ok: true,
      result: { ...expectedResult, status: "confirmed" },
    });
    if (!scenario.recoverWithoutSnapshot) {
      const repeated = await emitAck<{ ok: boolean; result?: unknown }>(
        socket, "match:saveFallo", identity,
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
    socket.emit('match:saveFallo', identity);
    const recovered = await emitAck<{ ok: boolean; result: { status: string } | null }>(socket, 'match:result:get', identity);
    expect(recovered).toMatchObject({
      ok: true,
      result: { status: 'confirmed', flagsRed: 5, flagsBlue: 3 },
    });
    const repeatedConfirmation = await emitAck<{ ok: boolean; result?: { alreadyConfirmed?: boolean } }>(socket, 'match:saveFallo', identity);
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
      categoryId: 'category-b',
      matchId: 'fight-b',
    });
    expect(failedConfirmation.ok).toBe(false);
    expect(db.getActiveMatchLock()).toMatchObject({ fightId: 'fight-b', categoryId: 'category-b' });
    expect(db.countMatchResults('fight-b')).toBe(0);
  });
});
