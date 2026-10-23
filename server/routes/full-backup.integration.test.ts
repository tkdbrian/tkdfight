// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { Server } from "socket.io";
import { afterEach, expect, it, vi } from "vitest";

let directory: string | null = null;
let server: ReturnType<typeof createServer> | null = null;
let io: Server | null = null;
let database: typeof import("../db/index.js") | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => io?.close(() => resolve()) ?? resolve());
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  database?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  server = null;
  io = null;
  database = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("guards a loopback lease, durable lost-ACK receipt, and completion", async () => {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-backup-route-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("TKD_ROLE", "cuadrilatero1");
  vi.resetModules();
  database = await import("../db/index.js");
  const { registerFullBackupRoutes } = await import("./full-backup.js");
  const app = express();
  server = createServer(app);
  io = new Server(server);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const buildPath = path.join(directory, "build-id.json");
  writeFileSync(buildPath, JSON.stringify({ buildId: "fixture-build", backupSchemaVersion: 1 }));
  writeFileSync(
    path.join(directory, "ring.json"),
    JSON.stringify({ alias: "T1", name: "Tatami 1" })
  );
  registerFullBackupRoutes(app, io, port, buildPath);
  app.post("/api/operational-write", (_req, res) => {
    res.json({ ok: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const send = async (endpoint: string, body: unknown, origin = base) =>
    fetch(`${base}/api/backup/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  expect((await send("begin", {}, "http://evil.test")).status).toBe(403);
  const begin = await send("begin", {});
  expect(begin.status).toBe(200);
  const { token } = (await begin.json()) as { token: string };
  expect((await fetch(`${base}/api/operational-write`, { method: "POST" })).status).toBe(423);
  const browser = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  expect(
    (
      await send("export", {
        token,
        browser: {
          ...browser,
          "tkd-tournament": JSON.stringify({
            version: 1,
            state: { phase: "setup", competitors: "not-an-array" },
          }),
        },
      })
    ).status
  ).toBe(422);
  const exported = await send("export", { token, browser });
  expect(exported.status).toBe(200);
  const backup = (await exported.json()) as {
    backupId: string;
    payloadHash: string;
    payload: { browser: unknown };
  };
  const restore = await send("restore", { token, backup: JSON.stringify(backup) });
  expect(restore.status).toBe(200);
  const status = await fetch(`${base}/api/backup/status`);
  expect(((await status.json()) as { receipt: { status: string } }).receipt.status).toBe("pending");
  expect((await send("restore", { token, backup: JSON.stringify(backup) })).status).toBe(200);
  const { sha256Hex, canonicalJson } = await import("../../src/lib/full-backup-contract.js");
  const browserHash = await sha256Hex(canonicalJson(browser));
  expect(
    (
      await send("complete", {
        token,
        backupId: backup.backupId,
        payloadHash: backup.payloadHash,
        browserHash,
      })
    ).status
  ).toBe(200);
  expect(
    (
      (await fetch(`${base}/boot-status`).then((response) => response.json())) as {
        maintenanceRequired: boolean;
      }
    ).maintenanceRequired
  ).toBe(false);
});

it("refuses a same-build T1 archive at a pristine T2 server", async () => {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-backup-route-t2-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("TKD_ROLE", "cuadrilatero2");
  vi.resetModules();
  database = await import("../db/index.js");
  const { registerFullBackupRoutes } = await import("./full-backup.js");
  const { createBackupEnvelope } = await import("../../src/lib/full-backup-contract.js");
  const app = express();
  server = createServer(app);
  io = new Server(server);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const buildPath = path.join(directory, "build-id.json");
  writeFileSync(buildPath, JSON.stringify({ buildId: "shared-build", backupSchemaVersion: 1 }));
  writeFileSync(
    path.join(directory, "ring.json"),
    JSON.stringify({ alias: "T2", name: "Tatami 2" })
  );
  registerFullBackupRoutes(app, io, port, buildPath);
  const base = `http://127.0.0.1:${port}`;
  const send = async (endpoint: string, body: unknown) =>
    fetch(`${base}/api/backup/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify(body),
    });
  const begin = await send("begin", {});
  expect(begin.status).toBe(200);
  const { token } = (await begin.json()) as { token: string };
  const browser = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  const t1 = await createBackupEnvelope(
    { sql: { tables: {}, sequences: {} }, browser },
    "shared-build",
    "T1",
    "id",
    "2026-10-23T00:00:00.000Z"
  );
  expect((await send("restore", { token, backup: JSON.stringify(t1) })).status).toBe(409);
  expect(
    (await fetch(`${base}/api/backup/status`).then((response) => response.json())) as {
      receipt: unknown;
      role: string;
    }
  ).toMatchObject({ receipt: null, role: "T2" });
});

async function backupIdleFixture() {
  directory = mkdtempSync(path.join(tmpdir(), 'tkd-backup-idle-'));
  vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('TKD_ROLE', 'cuadrilatero1');
  vi.resetModules();
  database = await import('../db/index.js');
  const {state} = await import('../state.js');
  const {registerFullBackupRoutes} = await import('./full-backup.js');
  const app = express();
  server = createServer(app);
  io = new Server(server);
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const buildPath = path.join(directory, 'build-id.json');
  writeFileSync(buildPath, JSON.stringify({buildId: 'fixture-build', backupSchemaVersion: 1}));
  writeFileSync(path.join(directory, 'ring.json'), JSON.stringify({alias: 'T1', name: 'Tatami 1'}));
  registerFullBackupRoutes(app, io, port, buildPath);
  const base = `http://127.0.0.1:${port}`;
  const send = (endpoint: string, body: unknown) => fetch(`${base}/api/backup/${endpoint}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: base}, body: JSON.stringify(body),
  });
  return {state, db: database, send, base};
}

it.each(['sparring', 'tul'] as const)('allows backup with a confirmed finished %s display without exporting it as active', async mode => {
  const {state, send, base} = await backupIdleFixture();
  const {createMatch} = await import('../../src/engine/match-machine.js');
  const {default: rules} = await import('../../src/rules/rules/rules_sparring_itf_baseline.json');
  state.match = {id: 'finished-display', ringId: 'T1', matchMode: mode,
    red: {id: 'red', name: 'Red'}, blue: {id: 'blue', name: 'Blue'}};
  state.matchState = {...createMatch(rules as import('../../src/engine/types.js').RuleSetSparring),
    phase: 'finished', result: {winner: 'red', reason: 'points'}};
  state.tulPhase = mode === 'tul' ? 'finished' : 'idle';
  state.resultConfirmed = true;
  expect(((await fetch(`${base}/api/backup/status`).then(r => r.json())) as {idle: boolean}).idle).toBe(true);
  const begin = await send('begin', {});
  expect(begin.status).toBe(200);
  const {token} = await begin.json() as {token: string};
  const exported = await send('export', {token, browser: {'tkd-tournament': null,
    'tkd-tournament-categories': null, 'tkd-category-deletions-v1': null, 'tkd-retired-category-sources-v1': null}});
  expect(exported.status).toBe(200);
  expect(JSON.stringify(await exported.json())).not.toContain('finished-display');
  expect((await send('begin', {})).status).toBe(423);
});

it.each(['loaded', 'running', 'paused', 'unconfirmed', 'unknown', 'missing-result', 'confirmed-idle', 'snapshot', 'pending-result'] as const)(
  'still refuses backup when %s is operational or unresolved', async kind => {
    const {state, db, send} = await backupIdleFixture();
    const {createMatch} = await import('../../src/engine/match-machine.js');
    const {default: baseline} = await import('../../src/rules/rules/rules_sparring_itf_baseline.json');
    const rules = baseline as import('../../src/engine/types.js').RuleSetSparring;
    state.match = {id: 'blocked-fight', ringId: 'T1', matchMode: 'sparring',
      red: {id: 'red', name: 'Red'}, blue: {id: 'blue', name: 'Blue'}};
    state.matchState = {...createMatch(rules), phase: kind === 'running' || kind === 'paused' ? 'round' : kind === 'loaded' || kind === 'confirmed-idle' ? 'idle' : 'finished',
      result: kind === 'missing-result' ? null : {winner: 'red', reason: 'points'}};
    state.matchPaused = kind === 'paused';
    state.resultConfirmed = kind === 'unknown' || kind === 'missing-result' || kind === 'confirmed-idle' || kind === 'snapshot' || kind === 'pending-result';
    if (kind === 'unknown') state.matchState = null;
    if (kind === 'snapshot') {
      const tournament = db.createTournament('Recovery snapshot', '');
      db.saveMatchSnapshot(state.match.id, tournament, {match: state.match, rules, roundFlags: []});
    }
    if (kind === 'pending-result') {
      const association = db.resolveCategoryTournament({categoryId: 'blocked-category', categoryName: 'C', tournamentName: 'T'});
      db.upsertCompetitor({id: 'red', tournament_id: association.tournamentId, name: 'Red'});
      db.upsertCompetitor({id: 'blue', tournament_id: association.tournamentId, name: 'Blue'});
      db.insertFightIfNew({id: state.match.id, tournament_id: association.tournamentId, red_id: 'red', blue_id: 'blue'});
      db.savePendingMatchResult({fightId: state.match.id, categoryId: 'blocked-category', tournamentId: association.tournamentId,
        winner: 'red', reason: 'points', flagsRed: 4, flagsBlue: 0, warningsRed: 0, warningsBlue: 0, foulsRed: 0, foulsBlue: 0});
      expect(db.getActiveMatchLock()).not.toBeNull();
    }
    expect((await send('begin', {})).status).toBe(409);
  });

it('still refuses maintenance while another system socket remains connected', async () => {
  const {send, base} = await backupIdleFixture();
  const {io: connect} = await import('socket.io-client');
  const client = connect(base, {transports: ['websocket'], forceNew: true});
  try {
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    expect((await send('begin', {})).status).toBe(409);
  } finally {
    client.disconnect();
  }
});
