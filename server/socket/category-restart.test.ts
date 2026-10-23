import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server } from "socket.io";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, expect, it, vi } from "vitest";
import { generateGroupsTournament } from "../../src/lib/bracket";
import type { CategoryRestartSnapshot } from "../../src/lib/category-restart-contract";
import baselineRules from "../../src/rules/rules/rules_sparring_itf_baseline.json";

let directory: string | null = null;
let db: typeof import("../db/index.js") | null = null;
let io: Server | null = null;
let client: Socket | null = null;
afterEach(async () => {
  client?.disconnect();
  if (io) await new Promise<void>((resolve) => io?.close(() => resolve()));
  db?.default.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = null;
  db = null;
  io = null;
  client = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});
function graph(): CategoryRestartSnapshot {
  const competitors = ["Uno", "Dos", "Tres"].map((name) => ({ id: randomUUID(), name }));
  return {
    phase: "fighting",
    config: {
      id: randomUUID(),
      tournamentName: "Evento",
      categoryName: "Categoría",
      tableChief: "Mesa",
      ruleSet: null,
      judgesCount: 3,
      mode: "round-robin",
      matchType: "sparring",
    },
    competitors,
    ...generateGroupsTournament(competitors),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}
async function setup(registered: boolean): Promise<{
  old: CategoryRestartSnapshot;
  replacement: string;
  socket: Socket;
  state: typeof import("../state.js").state;
}> {
  directory = mkdtempSync(path.join(tmpdir(), "tkd-restart-socket-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.resetModules();
  db = await import("../db/index.js");
  const { state } = await import("../state.js");
  const old = graph();
  if (registered) {
    const source = db.resolveCategoryTournament({
      categoryId: old.config.id,
      tournamentName: old.config.tournamentName,
      categoryName: old.config.categoryName,
    });
    for (const entry of old.competitors)
      db.upsertCompetitor({ ...entry, tournament_id: source.tournamentId });
    for (const fight of old.fights)
      db.insertFightIfNew({
        id: fight.id,
        tournament_id: source.tournamentId,
        red_id: fight.red.id,
        blue_id: fight.blue.id,
      });
    const fight = old.fights[0];
    db.confirmMatchResult({
      fightId: fight.id,
      categoryId: old.config.id,
      tournamentId: source.tournamentId,
      winner: "red",
      reason: "points",
      flagsRed: 3,
      flagsBlue: 0,
      warningsRed: 0,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    });
    Object.assign(fight, { completed: true, winner: "red", flagsRed: 3 });
  }
  const result = db.restartCategoryExecution({
    requestId: randomUUID(),
    categoryId: old.config.id,
    previousSnapshot: old,
    replacementSnapshot: graph(),
  });
  state.activeTournamentId = result.archive.replacementTournamentId;
  const { registerSocketHandlers } = await import("./handlers.js");
  const server = createServer();
  io = new Server(server);
  registerSocketHandlers(io);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  client = createClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
    transports: ["websocket"],
    forceNew: true,
  });
  await new Promise<void>((resolve) => client?.once("connect", resolve));
  return { old, replacement: result.replacementCategoryId, socket: client, state };
}
function ack(socket: Socket, event: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(1000)
      .emit(event, payload, (error: Error | null, result: Record<string, unknown>) => {
        if (error) reject(error);
        else resolve(result);
      });
  });
}

it.each([
  true,
  false,
])("returns category_archived on stale load/result/sanction/undo owners (SQL=%s)", async (registered) => {
  const { old, replacement, socket } = await setup(registered);
  const fight = old.fights[0];
  const context = { categoryId: old.config.id, matchId: fight.id };
  const commands: Array<[string, object]> = [
    [
      "match:load",
      {
        categoryId: old.config.id,
        tournamentName: "Evento",
        rules: baselineRules,
        match: { id: fight.id, ringId: "T1", red: fight.red, blue: fight.blue },
      },
    ],
    [
      "match:load",
      {
        categoryId: randomUUID(),
        tournamentName: "Evento",
        rules: baselineRules,
        match: { id: fight.id, ringId: "T1", red: fight.red, blue: fight.blue },
      },
    ],
    ["match:saveFallo", { ...context, expectedRevision: 0 }],
    [
      "mesa:setSanctionCount",
      { ...context, competitor: "red", kind: "warning", expectedCount: 0, count: 1 },
    ],
    ["mesa:undoRound", { ...context, expectedRevision: 0 }],
    ["golden:vote", { ...context, judgeId: "J1", competitor: "red", attempt: 1 }],
    ["match:reset", context],
  ];
  for (const [event, payload] of commands) {
    expect(await ack(socket, event, payload), event).toMatchObject({
      ok: false,
      code: "category_archived",
      replacementCategoryId: replacement,
    });
  }
  const historical = await ack(socket, "match:result:get", context);
  expect(historical.ok).toBe(true);
  if (registered) expect(historical.result).toMatchObject({ status: "confirmed", winner: "red" });
  else expect(historical.result).toBeNull();
});

it("blocks context-free legacy mutations of archived memory remnants and leaves replacement writable", async () => {
  const { old, replacement, socket, state } = await setup(true);
  state.matchCategoryId = old.config.id;
  state.fallos = [
    {
      id: 1,
      time: "now",
      redName: "R",
      blueName: "B",
      redScore: 0,
      blueScore: 0,
      winner: "red",
      categoryId: old.config.id,
      matchId: old.fights[0].id,
    },
  ];
  const errorEvent = new Promise<Record<string, unknown>>((resolve) =>
    socket.once("category:archived", resolve)
  );
  socket.emit("match:clearFallos");
  expect(await errorEvent).toMatchObject({
    code: "category_archived",
    replacementCategoryId: replacement,
  });
  expect(state.fallos).toHaveLength(1);
  state.matchCategoryId = null;
  const fresh = db!.getCategoryReplacement(old.config.id)!.replacementSnapshot;
  const fight = fresh.fights[0];
  expect(
    await ack(socket, "match:load", {
      categoryId: replacement,
      tournamentName: "Evento",
      rules: baselineRules,
      match: { id: fight.id, ringId: "T1", red: fight.red, blue: fight.blue },
    })
  ).toMatchObject({ ok: true });
});
