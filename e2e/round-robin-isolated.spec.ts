import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./isolated-test";
import { io, type Socket } from "socket.io-client";
import { FightPage } from "./fight-page";
import { CategoriesPage } from "./categories-page";
import {
  RoundRobinPage,
  type RrFight,
  readConfirmedFight,
  readFightResult,
  readRrServerState,
} from "./round-robin-page";
import { SetupPage } from "./setup-page";

const baselineRules = JSON.parse(
  readFileSync(join(process.cwd(), "src/rules/rules/rules_sparring_itf_baseline.json"), "utf8")
) as Record<string, unknown>;

async function launchExtraServer(port: number, dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
  });
  let childOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childOutput += chunk.toString();
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Extra isolated server exited before bind: ${childOutput}`);
    if (childOutput.includes("TKD Scoring Server")) {
      const response = await fetch(`http://127.0.0.1:${port}/api/ring/status`);
      if (response.ok) return child;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Extra isolated server did not bind: ${childOutput}`);
}

async function stopExtraServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (!child.kill()) throw new Error(`Could not terminate isolated server PID ${child.pid}`);
  await Promise.race([
    stopped,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Isolated server PID ${child.pid} did not exit`)), 5_000)
    ),
  ]);
}

async function freeTcpPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No ephemeral port allocated");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

async function extraServerState(port: number): Promise<{
  match?: { id: string } | null;
  penaltyCounts?: {
    warnings: { red: number; blue: number };
    fouls: { red: number; blue: number };
  };
  matchState?: {
    phase: string;
    rounds: Array<{ events: Array<{ type: string; competitor: string }> }>;
    goldenPoint?: { attempt: number; votes: Record<string, "red" | "blue"> };
    result?: { winner: "red" | "blue" | "draw"; reason: string };
  } | null;
}> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], timeout: 2_000 });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error("state:update timeout"));
    }, 3_000);
    socket.once("state:update", (state) => {
      clearTimeout(timeout);
      socket.disconnect();
      resolve(state);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      socket.disconnect();
      reject(error);
    });
  });
}

function removeExtraDataDir(dataDir: string): void {
  const target = resolve(dataDir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !/^tkd-rr-restart-e2e-[A-Za-z0-9]+$/.test(basename(target))
  ) {
    throw new Error(`Unsafe isolated restart data directory: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

async function connectExtraSocket(port: number): Promise<Socket> {
  const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], timeout: 3_000 });
  await new Promise<void>((resolveConnected, reject) => {
    socket.once("connect", resolveConnected);
    socket.once("connect_error", reject);
  });
  return socket;
}

async function extraAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolveAck, reject) => {
    socket.timeout(5_000).emit(event, payload, (error: Error | null, result: T) => {
      if (error) reject(error);
      else resolveAck(result);
    });
  });
}

async function setupRoundRobin(page: Page, count: number, white = false): Promise<RoundRobinPage> {
  const setup = new SetupPage(page);
  await setup.goto();
  await page
    .getByRole("button", { name: "Seleccionar perfil Yusan 2026 para este torneo" })
    .click();
  async function keepCategoryEditorOpen(): Promise<void> {
    const reopen = page.getByRole("button", { name: /Configurar categoría/ });
    if (await reopen.isVisible()) await reopen.click();
  }
  for (const label of [
    "ADULTOS (18-35)",
    "GUPS",
    white ? "Blancos y Puntas Amarillas" : "Amarillos a Puntas Azules",
    "Liviano A",
    "Masculino",
    "Round Robin",
  ]) {
    await keepCategoryEditorOpen();
    await setup.selectCategoryOption(label);
  }
  await keepCategoryEditorOpen();
  await page.getByRole("button", { name: "Aplicar Yusan 2026 a esta categoría" }).click();
  await setup.addCompetitors(Array.from({ length: count }, (_, index) => `RR ${index + 1}`));
  await setup.startCategory();
  return new RoundRobinPage(page);
}

function favoredSide(
  fight: RrFight,
  groups: Awaited<ReturnType<RoundRobinPage["progress"]>>["groups"]
): "red" | "blue" {
  const group = groups.find((entry) => entry.id === fight.groupId);
  if (!group) throw new Error(`Missing group ${fight.groupId}`);
  const redRank = group.competitors.findIndex((entry) => entry.id === fight.red.id);
  const blueRank = group.competitors.findIndex((entry) => entry.id === fight.blue.id);
  if (redRank < 0 || blueRank < 0) throw new Error("Fight entrant absent from group");
  return redRank < blueRank ? "red" : "blue";
}

test.beforeEach(async ({ page }) => {
  const status = await page.request.get("/api/ring/status");
  expect(status.ok()).toBe(true);
  expect((await status.json()).port).toBe(3397);
  const reset = await page.request.post("/api/ring/full-reset");
  expect(reset.ok()).toBe(true);
});

const sizes = [
  { count: 3, groupSizes: [3], regularCount: 3, white: true },
  { count: 4, groupSizes: [4], regularCount: 6, white: false },
  { count: 6, groupSizes: [3, 3], regularCount: 6, white: true },
  { count: 8, groupSizes: [4, 4], regularCount: 12, white: false },
] as const;

for (const scenario of sizes) {
  test(`real chief completes ${scenario.count}-athlete fixture before any extra`, async ({
    page,
  }) => {
    const rr = await setupRoundRobin(page, scenario.count, scenario.white);
    const initial = await rr.progress();
    expect(initial.config.profileId).toBe("yusan-2026");
    expect(initial.groups.map((group) => group.competitors.length)).toEqual(scenario.groupSizes);
    expect(initial.fights).toHaveLength(scenario.regularCount);
    expect(new Set(initial.fights.map((fight) => fight.id)).size).toBe(scenario.regularCount);
    const expectedSeconds = scenario.white ? 40 : 60;

    for (let index = 0; index < scenario.regularCount; index++) {
      const before = await rr.progress();
      const fight = before.fights[before.currentFightIndex];
      expect(fight).toBeDefined();
      const side = favoredSide(fight, before.groups);
      const votes =
        scenario.count === 3 && index === 0
          ? (["red", "blue", "red", "blue"] as const)
          : ([side, side, side, side] as const);
      const result = await rr.finishTimed(votes);
      expect(result.serverBefore.match).toMatchObject({
        id: fight.id,
        requireIndividualFlags: true,
      });
      expect(result.serverBefore.rules?.rounds.duration_seconds).toBe(expectedSeconds);
      expect(result.progress.fights).toHaveLength(scenario.regularCount);
      expect(result.progress.fights.filter((entry) => entry.completed)).toHaveLength(index + 1);
    }

    if (scenario.groupSizes.length === 1) {
      await expect(page.getByText("Campeón", { exact: true })).toBeVisible();
      expect((await rr.progress()).fights).toHaveLength(scenario.regularCount);
      return;
    }

    await expect(page.getByRole("button", { name: "Iniciar Fase Final" })).toBeVisible();
    await page.getByRole("button", { name: "Iniciar Fase Final" }).click();
    await expect
      .poll(async () => (await rr.progress()).fights.length)
      .toBe(scenario.regularCount + 1);
    const final = await rr.currentFight();
    expect(final).toMatchObject({ groupId: "FINAL", isFinalFight: true, completed: false });
    const server = await rr.loadCurrent();
    expect(server.rules?.rounds.duration_seconds).toBe(scenario.white ? 40 : 120);
    expect(server.match?.requireIndividualFlags).toBe(false);
    const completedFinal = await rr.finishTimed(["red", "red", "red", "red"]);
    expect(completedFinal.progress.fights.find((fight) => fight.id === final.id)).toMatchObject({
      completed: true,
      winner: "red",
    });
  });
}

test("completed fight review stays selected while next group fight runs", async ({ page }) => {
  const sentFrames: string[] = [];
  let captureCommands = false;
  page.on("websocket", (webSocket) => {
    webSocket.on("framesent", (frame) => {
      if (captureCommands) sentFrames.push(String(frame.payload));
    });
  });
  const rr = await setupRoundRobin(page, 6, true);
  const initial = await rr.progress();
  expect(initial.groups.map((group) => group.competitors.length)).toEqual([3, 3]);
  const first = initial.fights[0];
  const fightPage = new FightPage(page);
  await rr.loadCurrent();
  await fightPage.startFight();
  await fightPage.endRound();
  await expect.poll(async () => (await readRrServerState()).matchState?.phase).toBe("rest");
  await rr.adjustSanction("red", "warning", "add");
  await rr.adjustSanction("red", "warning", "add");
  await rr.adjustSanction("blue", "warning", "add");
  await rr.adjustSanction("red", "minus_point", "add");
  for (const [index, vote] of (["red", "red", "red", "blue"] as const).entries()) {
    await fightPage.voteJudge(index + 1, vote);
  }
  await page.getByRole("button", { name: /Confirmar.*Rojo gana el round/ }).click();
  const overlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(overlay).toBeVisible();
  await overlay.getByRole("button", { name: /Confirmar resultado/ }).click();
  const dialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect(dialog).not.toBeVisible();
  const storedFirst = await readConfirmedFight(initial.config.id, first.id);
  expect(storedFirst).toMatchObject({
    status: "confirmed",
    winner: "red",
    flagsRed: 3,
    flagsBlue: 1,
    warningsRed: 2,
    warningsBlue: 1,
    foulsRed: 1,
    foulsBlue: 0,
  });
  const second = await rr.currentFight();
  expect(second.id).not.toBe(first.id);
  const firstStep = page.getByTestId(`fight-progress-${first.id}`);
  const secondStep = page.getByTestId(`fight-progress-${second.id}`);

  // Completed result stays reviewable even while the server still reports A as confirmed.
  await firstStep.click();
  await expect(firstStep).toHaveAttribute("aria-current", "step");
  await page.waitForTimeout(1_300);
  await expect(firstStep).toHaveAttribute("aria-current", "step");
  expect((await rr.progress()).currentFightIndex).toBe(0);
  await secondStep.click();
  await expect(secondStep).toHaveAttribute("aria-current", "step");
  await expect(fightPage.loadFightButton.or(fightPage.startFightButton).first()).toBeVisible();
  await expect(page.getByText("2 adv", { exact: true })).toHaveCount(0);

  const loadedSecond = await rr.loadCurrent();
  expect(loadedSecond.match?.id).toBe(second.id);
  await fightPage.startFight();
  const timeBeforeReview = (await readRrServerState()).matchState?.timeLeft;
  if (timeBeforeReview == null) throw new Error("Second fight has no running clock");
  captureCommands = true;
  await firstStep.click();
  await expect(firstStep).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("fight-review-notice")).toBeVisible();
  await expect(fightPage.endRoundButton).toHaveCount(0);
  await expect(page.getByText(/2 adv/)).toBeVisible();
  await expect(page.getByText("1 directo", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await readRrServerState()).matchState?.timeLeft ?? 999)
    .toBeLessThan(timeBeforeReview - 1);
  await expect(firstStep).toHaveAttribute("aria-current", "step");
  expect((await rr.progress()).currentFightIndex).toBe(0);
  expect(await readConfirmedFight(initial.config.id, first.id)).toEqual(storedFirst);
  const serverDuringReview = await readRrServerState();
  expect(serverDuringReview.match?.id).toBe(second.id);
  expect(serverDuringReview.matchState?.phase).toBe("round");

  await page.getByRole("button", { name: "Volver al combate activo" }).click();
  await expect(secondStep).toHaveAttribute("aria-current", "step");
  await expect(fightPage.endRoundButton).toBeVisible();
  captureCommands = false;
  expect(
    sentFrames.filter((frame) =>
      /"(?:match:(?:load|start|reset|pause|resume|finishRound|event|saveFallo|result:get)|mesa:)/.test(
        frame
      )
    )
  ).toEqual([]);
  expect((await readRrServerState()).match?.id).toBe(second.id);

  // Leave the isolated tatami unlocked so the next test can request full-reset.
  await fightPage.endRound();
  await expect.poll(async () => (await readRrServerState()).matchState?.phase).toBe("rest");
  for (let judge = 1; judge <= 4; judge++) await fightPage.voteJudge(judge, "red");
  await page.getByRole("button", { name: /Confirmar.*Rojo gana el round/ }).click();
  const secondOverlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(secondOverlay).toBeVisible();
  await secondOverlay.getByRole("button", { name: /Confirmar resultado/ }).click();
  const secondDialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(secondDialog).toBeVisible();
  await secondDialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect(secondDialog).not.toBeVisible();
});

test("pending round flags can be corrected before official confirmation", async ({ page }) => {
  const rr = await setupRoundRobin(page, 3, true);
  const initial = await rr.progress();
  const fight = initial.fights[0];
  const fightPage = new FightPage(page);
  await rr.loadCurrent();
  await fightPage.startFight();
  await fightPage.endRound();
  await expect.poll(async () => (await readRrServerState()).matchState?.phase).toBe("rest");
  await rr.adjustSanction("red", "warning", "add");
  await rr.adjustSanction("blue", "minus_point", "add");
  for (let judge = 1; judge <= 4; judge++) await fightPage.voteJudge(judge, "red");
  await page.getByRole("button", { name: /Confirmar.*Rojo gana el round/ }).click();
  const overlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => await readFightResult(initial.config.id, fight.id))
    .toMatchObject({
      status: "pending_confirmation",
      winner: "red",
      flagsRed: 4,
      flagsBlue: 0,
      warningsRed: 1,
      foulsBlue: 1,
    });

  await overlay.getByRole("button", { name: /Corregir bande/ }).click();
  await expect(overlay).not.toBeVisible();
  await expect(fightPage.getJudgeVoteButton(1, "blue")).toBeEnabled();
  await expect(fightPage.getJudgeVoteButton(1, "red")).toHaveClass(/bg-red-600/);
  for (const [index, side] of (["blue", "blue", "blue", "red"] as const).entries()) {
    await fightPage.voteJudge(index + 1, side);
  }
  await page.getByRole("button", { name: /Confirmar.*Azul gana el round/ }).click();
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => await readFightResult(initial.config.id, fight.id))
    .toMatchObject({
      status: "pending_confirmation",
      winner: "blue",
      flagsRed: 1,
      flagsBlue: 3,
      warningsRed: 1,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 1,
    });
  await overlay.getByRole("button", { name: /Confirmar resultado/ }).click();
  const dialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await readConfirmedFight(initial.config.id, fight.id)).toMatchObject({
    status: "confirmed",
    winner: "blue",
    flagsRed: 1,
    flagsBlue: 3,
    warningsRed: 1,
    foulsBlue: 1,
  });
  expect((await rr.progress()).fights[0]).toMatchObject({
    completed: true,
    winner: "blue",
    flagsRed: 1,
    flagsBlue: 3,
  });
});

test("correcting a regular Round Robin round to 2-2 records a draw without extra", async ({
  page,
}) => {
  const rr = await setupRoundRobin(page, 3, true);
  const initial = await rr.progress();
  const fight = initial.fights[0];
  const fightPage = new FightPage(page);
  await rr.loadCurrent();
  await fightPage.startFight();
  await fightPage.endRound();
  for (let judge = 1; judge <= 4; judge++) await fightPage.voteJudge(judge, "red");
  await page.getByRole("button", { name: /Confirmar.*Rojo gana el round/ }).click();
  const overlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(overlay).toBeVisible();
  await overlay.getByRole("button", { name: /Corregir bande/ }).click();
  await expect(overlay).not.toBeVisible();
  await expect(fightPage.getJudgeVoteButton(1, "red")).toHaveClass(/bg-red-600/);
  await fightPage.voteJudge(2, "blue");
  await fightPage.voteJudge(4, "blue");
  await page.getByRole("button", { name: "Confirmar — Empate en banderas" }).click();
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => await readFightResult(initial.config.id, fight.id))
    .toMatchObject({
      status: "pending_confirmation",
      winner: "draw",
      flagsRed: 2,
      flagsBlue: 2,
    });
  await overlay.getByRole("button", { name: /Confirmar resultado/ }).click();
  const dialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await readConfirmedFight(initial.config.id, fight.id)).toMatchObject({
    status: "confirmed",
    winner: "draw",
    flagsRed: 2,
    flagsBlue: 2,
  });
  const progress = await rr.progress();
  expect(progress.fights).toHaveLength(3);
  expect(progress.fights[0]).toMatchObject({ completed: true, winner: "draw" });
  expect(progress.fights.every((entry) => !entry.isTiebreakExtra)).toBe(true);
});

test("409 and lost sync response keep local phase and retry identical fight UUID", async ({
  page,
}) => {
  const rr = await setupRoundRobin(page, 3);
  const first = (await rr.progress()).fights[0];
  await rr.finishTimed(["red", "blue", "red", "blue"]);
  for (let index = 1; index < 3; index++) {
    const fight = await rr.currentFight();
    const side = fight.red.id === first.red.id || fight.red.id === first.blue.id ? "red" : "blue";
    await rr.finishTimed([side, side, side, side]);
  }
  const resolve = page.getByRole("button", {
    name: /Resolver desempate — 2 competidores empatados/,
  });
  const proposals: string[] = [];
  await page.route("**/api/ring/sync-fights", async (route) => {
    const body = route.request().postDataJSON() as { fights: Array<{ id: string }> };
    proposals.push(body.fights.at(-1)?.id ?? "");
    if (proposals.length === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "pending_confirmation", message: "Rechazo aislado 409" }),
      });
      return;
    }
    if (proposals.length === 2) {
      const committed = await route.fetch();
      expect(committed.ok()).toBe(true);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await resolve.click();
  await expect(page.getByText("Rechazo aislado 409")).toBeVisible();
  expect((await rr.progress()).fights).toHaveLength(3);
  await resolve.click();
  await expect(page.getByText(/Failed to fetch/i)).toBeVisible();
  expect((await rr.progress()).fights).toHaveLength(3);
  await resolve.click();
  await expect.poll(async () => (await rr.progress()).fights.length).toBe(4);
  expect(proposals.length).toBeGreaterThanOrEqual(3);
  expect(new Set(proposals).size).toBe(1);
  await page.unrouteAll();
  await rr.finishTimed(["red", "red", "red", "red"]);
});

test("three-way first-place tie creates a complete mini round-robin with individual votes", async ({
  page,
}) => {
  const rr = await setupRoundRobin(page, 3);
  for (let index = 0; index < 3; index++) {
    await rr.finishTimed(["red", "blue", "red", "blue"]);
    expect((await rr.progress()).fights).toHaveLength(3);
  }
  const resolve = page.getByRole("button", {
    name: /Resolver desempate — 3 competidores empatados/,
  });
  await expect(resolve).toBeVisible();
  await resolve.click();
  await expect.poll(async () => (await rr.progress()).fights.length).toBe(6);
  const progress = await rr.progress();
  const mini = progress.fights.slice(3);
  expect(mini.every((fight) => fight.isTiebreakExtra && fight.playoffKind === "mini")).toBe(true);
  expect(new Set(mini.map((fight) => [fight.red.id, fight.blue.id].sort().join("/"))).size).toBe(3);
  const championId = progress.groups[0].competitors[0].id;
  for (let index = 0; index < 3; index++) {
    const fight = await rr.currentFight();
    const side =
      fight.red.id === championId ? "red" : fight.blue.id === championId ? "blue" : "red";
    const result = await rr.finishTimed([side, side, side, side]);
    expect(result.serverBefore.match?.requireIndividualFlags).toBe(true);
  }
  await expect(page.getByText("Campeón", { exact: true })).toBeVisible();
});

test("three-way mini replay stays tied and requires another complete mini round-robin", async ({
  page,
}) => {
  const rr = await setupRoundRobin(page, 3);
  for (let index = 0; index < 3; index++) await rr.finishTimed(["red", "blue", "red", "blue"]);
  const resolve = page.getByRole("button", {
    name: /Resolver desempate — 3 competidores empatados/,
  });
  await resolve.click();
  await expect.poll(async () => (await rr.progress()).fights.length).toBe(6);
  for (let index = 0; index < 3; index++) {
    const result = await rr.finishTimed(["red", "blue", "red", "blue"]);
    expect(result.serverBefore.match?.requireIndividualFlags).toBe(true);
    expect(result.progress.fights).toHaveLength(6);
  }
  await expect(resolve).toBeVisible();
  await resolve.click();
  await expect.poll(async () => (await rr.progress()).fights.length).toBe(9);
  const cycle = (await rr.progress()).fights.slice(6);
  expect(cycle.every((fight) => fight.playoffKind === "mini" && fight.isTiebreakExtra)).toBe(true);
  expect(new Set(cycle.map((fight) => [fight.red.id, fight.blue.id].sort().join("/"))).size).toBe(
    3
  );
  const championId = (await rr.progress()).groups[0].competitors[0].id;
  for (let index = 0; index < 3; index++) {
    const fight = await rr.currentFight();
    const side =
      fight.red.id === championId ? "red" : fight.blue.id === championId ? "blue" : "red";
    const result = await rr.finishTimed([side, side, side, side]);
    expect(result.serverBefore.match?.requireIndividualFlags).toBe(true);
  }
  await expect(page.getByText("Campeón", { exact: true })).toBeVisible();
});

test("first-place tie waits for all fixtures, then direct extra, rematch and untimed golden point", async ({
  page,
}) => {
  const rr = await setupRoundRobin(page, 3);
  const initial = await rr.progress();
  const first = initial.fights[0];
  await rr.finishTimed(["red", "blue", "red", "blue"]);
  expect((await rr.progress()).fights).toHaveLength(3);
  for (let index = 1; index < 3; index++) {
    const fight = await rr.currentFight();
    const side = fight.red.id === first.red.id || fight.red.id === first.blue.id ? "red" : "blue";
    await rr.finishTimed([side, side, side, side]);
    expect((await rr.progress()).fights).toHaveLength(3);
  }
  const resolve = page.getByRole("button", {
    name: /Resolver desempate — 2 competidores empatados/,
  });
  await expect(resolve).toBeVisible();
  await resolve.click();
  await expect.poll(async () => (await rr.progress()).fights.length).toBe(4);
  const extra = await rr.currentFight();
  expect(extra).toMatchObject({ isTiebreakExtra: true, playoffKind: "direct", completed: false });
  await rr.finishTimed(["red", "blue", "red", "blue"]);
  const rematch = await rr.currentFight();
  expect(rematch.id).not.toBe(extra.id);
  expect(rematch).toMatchObject({ isTiebreakExtra: true, playoffKind: "direct", completed: false });
  expect(rematch.isGoldenPointFight).not.toBe(true);
  await rr.finishTimed(["red", "blue", "red", "blue"]);
  const golden = await rr.currentFight();
  expect(golden).toMatchObject({
    isTiebreakExtra: false,
    playoffKind: "direct",
    isGoldenPointFight: true,
  });
  const loadGolden = page.getByRole("button", { name: "Cargar combate", exact: true });
  if (await loadGolden.isVisible()) await loadGolden.click();
  await expect.poll(async () => (await readRrServerState()).match?.id).toBe(golden.id);
  const state = await readRrServerState();
  expect(state.match?.id).toBe(golden.id);
  expect(state.match?.goldenPoint).toBe(true);
  expect(state.match?.requireIndividualFlags).toBe(false);
  await expect(page.getByText("SIN RELOJ").first()).toBeVisible();
  const round = await readRrServerState();
  expect(round.matchState?.phase).toBe("golden_point");
  await page.getByRole("button", { name: "Por juez", exact: true }).click();
  await rr.voteGoldenJudge(1, "red");
  await rr.voteGoldenJudge(2, "red");
  expect((await readRrServerState()).matchState?.phase).toBe("golden_point");
  await rr.voteGoldenJudge(3, "blue");
  await rr.voteGoldenJudge(4, "blue");
  expect((await readRrServerState()).matchState?.goldenPoint?.attempt).toBe(1);
  await rr.confirmGoldenOutcome();
  await expect
    .poll(async () => (await readRrServerState()).matchState?.goldenPoint?.attempt)
    .toBe(2);
  expect((await readRrServerState()).matchState?.phase).toBe("golden_point");
  await rr.voteGoldenJudge(1, "red");
  await rr.voteGoldenJudge(2, "red");
  await rr.voteGoldenJudge(3, "red");
  expect((await readRrServerState()).matchState).toMatchObject({ phase: "golden_point" });
  expect(await readFightResult((await rr.progress()).config.id, golden.id)).toBeNull();
  await rr.confirmGoldenOutcome();
  await expect
    .poll(async () => (await readFightResult((await rr.progress()).config.id, golden.id))?.status)
    .toBe("pending_confirmation");
  const winnerOverlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(winnerOverlay).toBeVisible();
  await rr.reviewGoldenResult();
  const resultDialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(resultDialog).toBeVisible();
  await resultDialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect
    .poll(async () => (await rr.progress()).fights.find((fight) => fight.id === golden.id))
    .toMatchObject({ completed: true, winner: "red" });
  expect(await readConfirmedFight((await rr.progress()).config.id, golden.id)).toMatchObject({
    status: "confirmed",
    winner: "red",
    flagsRed: 3,
    flagsBlue: 0,
  });
});

test("two-group adult final draw advances timed rematch then untimed majority golden point", async ({
  page,
}) => {
  const rr = await setupRoundRobin(page, 6);
  for (let index = 0; index < 6; index++) {
    const progress = await rr.progress();
    const fight = progress.fights[progress.currentFightIndex];
    const side = favoredSide(fight, progress.groups);
    await rr.finishTimed([side, side, side, side]);
  }
  await page.getByRole("button", { name: "Iniciar Fase Final" }).click();
  await expect.poll(async () => (await rr.progress()).fights.length).toBe(7);
  const final = await rr.currentFight();
  expect(final).toMatchObject({ groupId: "FINAL", isFinalFight: true });
  const finalResult = await rr.finishTimed(["red", "blue", "red", "blue"]);
  expect(finalResult.serverBefore.rules?.rounds.duration_seconds).toBe(120);
  expect(finalResult.serverBefore.match?.requireIndividualFlags).toBe(false);
  const rematch = await rr.currentFight();
  expect(rematch).toMatchObject({ groupId: "FINAL", isTiebreakExtra: true, playoffKind: "direct" });
  const rematchResult = await rr.finishTimed(["red", "blue", "red", "blue"]);
  expect(rematchResult.serverBefore.rules?.rounds.duration_seconds).toBe(60);
  const golden = await rr.currentFight();
  expect(golden).toMatchObject({ groupId: "FINAL", isGoldenPointFight: true });
  const loadGolden = page.getByRole("button", { name: "Cargar combate", exact: true });
  if (await loadGolden.isVisible()) await loadGolden.click();
  await expect.poll(async () => (await readRrServerState()).match?.id).toBe(golden.id);
  const state = await readRrServerState();
  expect(state.match?.id).toBe(golden.id);
  expect(state.matchState?.phase).toBe("golden_point");
  expect(state.match?.requireIndividualFlags).toBe(false);
  await expect(page.getByText("SIN RELOJ").first()).toBeVisible();
  await page.getByRole("button", { name: "Por juez", exact: true }).click();
  // A third vote proposes a winner; it must not finish or persist until the chief reviews it.
  await rr.voteGoldenJudge(1, "red");
  await rr.voteGoldenJudge(2, "red");
  await rr.voteGoldenJudge(3, "red");
  await expect
    .poll(async () => (await readRrServerState()).matchState?.goldenPoint?.votes)
    .toEqual({ J1: "red", J2: "red", J3: "red" });
  expect((await readRrServerState()).matchState?.phase).toBe("golden_point");
  expect(await readFightResult((await rr.progress()).config.id, golden.id)).toBeNull();
  await expect(page.getByRole("dialog", { name: "Resultado del combate" })).not.toBeVisible();
  await expect(page.getByTestId("gp-provisional")).toContainText("todavía no confirmado");
  await expect(page.getByRole("button", { name: "Reiniciar", exact: true })).not.toBeVisible();

  // Correct one erroneous flag, complete a 2-2 attempt, then retry without a clock.
  await rr.voteGoldenJudge(3, "blue");
  await rr.voteGoldenJudge(4, "blue");
  await expect
    .poll(async () => (await readRrServerState()).matchState?.goldenPoint?.votes)
    .toEqual({ J1: "red", J2: "red", J3: "blue", J4: "blue" });
  await rr.confirmGoldenOutcome();
  await expect
    .poll(async () => (await readRrServerState()).matchState?.goldenPoint)
    .toEqual({ attempt: 2, votes: {} });
  expect(await readFightResult((await rr.progress()).config.id, golden.id)).toBeNull();

  for (let judge = 1; judge <= 3; judge++) await rr.voteGoldenJudge(judge, "blue");
  expect((await readRrServerState()).matchState?.phase).toBe("golden_point");
  await rr.confirmGoldenOutcome();
  await expect
    .poll(async () => (await readFightResult((await rr.progress()).config.id, golden.id))?.status)
    .toBe("pending_confirmation");
  const winnerOverlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(winnerOverlay).toBeVisible();
  await expect(winnerOverlay.getByTestId("gp-pending-result")).toBeVisible();
  await expect(winnerOverlay.getByTestId("gp-result-votes")).toContainText("0 — 3");
  await expect(winnerOverlay.getByRole("button", { name: /Corregir banderas/ })).not.toBeVisible();
  await rr.reviewGoldenResult();
  const resultDialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await resultDialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect
    .poll(async () => (await rr.progress()).fights.find((fight) => fight.id === golden.id))
    .toMatchObject({ completed: true, winner: "blue" });
  expect(await readConfirmedFight((await rr.progress()).config.id, golden.id)).toMatchObject({
    status: "confirmed",
    winner: "blue",
    flagsRed: 0,
    flagsBlue: 3,
  });
});

test("chief corrects post-clock sanctions before confirmation and Round Robin podium uses them", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1758, height: 879 });
  const rr = await setupRoundRobin(page, 3);
  const initial = await rr.progress();
  const first = initial.fights[0];
  const unaffected = initial.groups[0].competitors.find(
    (competitor) => competitor.id !== first.red.id && competitor.id !== first.blue.id
  );
  expect(unaffected).toBeDefined();
  const fightPage = new FightPage(page);
  await rr.loadCurrent();
  await fightPage.startFight();
  await fightPage.endRound();
  await expect.poll(async () => (await readRrServerState()).matchState?.phase).toBe("rest");
  await expect(page.getByTestId("sanction-review-pending")).toHaveCount(0);
  for (const side of ["red", "blue"] as const) {
    await expect(page.getByTestId(`score-sanctions-${side}-desktop`)).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("post-clock-1758x879.png") });
  const scoreBox = await fightPage.redScore.boundingBox();
  const judgeButton = await fightPage.getJudgeVoteButton(1, "red").boundingBox();
  if (!scoreBox || !judgeButton) throw new Error("Missing score or judge controls after clock");
  expect(scoreBox.y + scoreBox.height).toBeLessThan(879);
  expect(judgeButton.y + judgeButton.height).toBeLessThan(879);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("sanction-review-pending")).toHaveCount(0);
  const mobileArena = page
    .getByTestId("score-sanctions-red-mobile")
    .locator("xpath=ancestor::div[contains(@class, 'md:hidden')][1]/parent::div");
  const arenaBounds = await mobileArena.boundingBox();
  if (!arenaBounds) throw new Error("Missing mobile fight arena");
  const mobileActions = [
    { kind: "warning", action: "add", label: "agregar advertencia" },
    { kind: "warning", action: "remove", label: "quitar advertencia" },
    { kind: "minus_point", action: "add", label: "agregar punto en contra directo" },
    { kind: "minus_point", action: "remove", label: "quitar punto en contra directo" },
  ] as const;
  for (const [side, fighter] of [
    ["red", first.red],
    ["blue", first.blue],
  ] as const) {
    await expect(page.getByTestId(`score-sanctions-${side}-mobile`)).toBeVisible();
    for (const { kind, action, label } of mobileActions) {
      const control = page.getByTestId(`score-sanction-${side}-${kind}-${action}-mobile`);
      await expect(control).toHaveAttribute(
        "aria-label",
        `${fighter.name} (${side === "red" ? "rojo" : "azul"}): ${label}`
      );
      const bounds = await control.boundingBox();
      if (!bounds) throw new Error(`Missing mobile touch target for ${side} ${kind} ${action}`);
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.y).toBeGreaterThanOrEqual(arenaBounds.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(arenaBounds.y + arenaBounds.height);
    }
  }
  await page.screenshot({ path: testInfo.outputPath("post-clock-mobile-390x844.png") });
  const judgePanel = page.locator("#tour-bottom-tabs");
  const judgeMetrics = await judgePanel.evaluate((panel) => ({
    clientHeight: panel.clientHeight,
    scrollHeight: panel.scrollHeight,
    overflowY: getComputedStyle(panel).overflowY,
  }));
  expect(judgeMetrics.overflowY).toMatch(/auto|scroll/);
  if (judgeMetrics.scrollHeight > judgeMetrics.clientHeight + 1) {
    await judgePanel.hover();
    await page.mouse.wheel(0, 500);
    await expect
      .poll(async () => judgePanel.evaluate((panel) => panel.scrollTop))
      .toBeGreaterThan(0);
  }
  const judgePanelBounds = await judgePanel.boundingBox();
  const fourthJudgeBounds = await fightPage.getJudgeVoteButton(4, "blue").boundingBox();
  if (!judgePanelBounds || !fourthJudgeBounds) throw new Error("Missing mobile judge controls");
  expect(fourthJudgeBounds.y + fourthJudgeBounds.height).toBeLessThanOrEqual(
    judgePanelBounds.y + judgePanelBounds.height
  );
  await page.getByTestId("score-sanction-red-warning-add-mobile").click();
  await expect.poll(async () => (await readRrServerState()).penaltyCounts.warnings.red).toBe(1);
  await page.getByTestId("score-sanction-red-warning-remove-mobile").click();
  await expect.poll(async () => (await readRrServerState()).penaltyCounts.warnings.red).toBe(0);
  await page.setViewportSize({ width: 1758, height: 879 });

  // An offline table must not optimistically increment the displayed sanctions.
  const warningButton = page.getByTestId("score-sanction-red-warning-add-desktop");
  await page.context().setOffline(true);
  await expect(warningButton).toHaveCount(0);
  expect((await readRrServerState()).penaltyCounts.warnings.red).toBe(0);
  await page.context().setOffline(false);
  await expect(warningButton).toBeEnabled();

  // The clock is over but no result exists yet: both sides' sanctions remain editable.
  await rr.adjustSanction("red", "warning", "add");
  await rr.adjustSanction("red", "minus_point", "add");
  await rr.adjustSanction("red", "minus_point", "remove");
  await rr.adjustSanction("blue", "warning", "add");
  await rr.adjustSanction("blue", "minus_point", "add");
  await rr.adjustSanction("blue", "warning", "remove");
  await expect
    .poll(async () => (await readRrServerState()).penaltyCounts)
    .toEqual({
      warnings: { red: 1, blue: 0 },
      fouls: { red: 0, blue: 1 },
    });
  expect(await readFightResult(initial.config.id, first.id)).toBeNull();

  for (const [index, vote] of (["red", "blue", "red", "blue"] as const).entries()) {
    await fightPage.voteJudge(index + 1, vote);
  }
  await page.getByRole("button", { name: "Confirmar — Empate en banderas" }).click();
  await expect
    .poll(async () => (await readFightResult(initial.config.id, first.id))?.status)
    .toBe("pending_confirmation");
  expect(await readFightResult(initial.config.id, first.id)).toMatchObject({
    winner: "draw",
    warningsRed: 1,
    warningsBlue: 0,
    foulsRed: 0,
    foulsBlue: 1,
  });

  const overlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(overlay).toBeVisible();
  await overlay.getByRole("button", { name: "Confirmar resultado →" }).click();
  const dialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(dialog.getByTestId("sanction-review-pending")).toBeVisible();
  await rr.adjustSanction("red", "warning", "add", true);
  await rr.adjustSanction("blue", "minus_point", "remove", true);
  await rr.adjustSanction("blue", "warning", "add", true);
  await expect
    .poll(async () => await readFightResult(initial.config.id, first.id))
    .toMatchObject({
      status: "pending_confirmation",
      winner: "draw",
      warningsRed: 2,
      warningsBlue: 1,
      foulsRed: 0,
      foulsBlue: 0,
    });

  // Reload must not silently confirm or lose the corrected pending metrics.
  await page.reload();
  await expect
    .poll(async () => (await readRrServerState()).penaltyCounts)
    .toEqual({
      warnings: { red: 2, blue: 1 },
      fouls: { red: 0, blue: 0 },
    });
  expect(await readFightResult(initial.config.id, first.id)).toMatchObject({
    status: "pending_confirmation",
    warningsRed: 2,
    warningsBlue: 1,
  });
  await page.getByRole("button", { name: "Siguiente pelea →" }).click();
  await expect(dialog.getByTestId("sanction-red-warning-count")).toContainText("2");
  await expect(dialog.getByTestId("sanction-blue-warning-count")).toContainText("1");
  await dialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect
    .poll(async () => (await readFightResult(initial.config.id, first.id))?.status)
    .toBe("confirmed");
  expect((await rr.progress()).fights.find((fight) => fight.id === first.id)).toMatchObject({
    completed: true,
    winner: "draw",
    warningsRed: 2,
    warningsBlue: 1,
    foulsRed: 0,
    foulsBlue: 0,
  });

  const socket = await connectExtraSocket(3397);
  try {
    expect(
      await extraAck<{ ok: boolean; code?: string; status?: number }>(
        socket,
        "mesa:setSanctionCount",
        {
          categoryId: initial.config.id,
          matchId: first.id,
          competitor: "red",
          kind: "warning",
          expectedCount: 2,
          count: 3,
        }
      )
    ).toMatchObject({ ok: false, code: "result_confirmed", status: 409 });
  } finally {
    socket.disconnect();
  }
  expect(await readFightResult(initial.config.id, first.id)).toMatchObject({
    status: "confirmed",
    warningsRed: 2,
  });

  for (let index = 1; index < 3; index++) {
    await rr.finishTimed(["red", "blue", "red", "blue"]);
  }
  await expect(page.getByText("Campeón", { exact: true })).toBeVisible();
  await expect(
    page
      .getByText("Campeón", { exact: true })
      .locator("..")
      .getByText(unaffected?.name ?? "", { exact: true })
  ).toBeVisible();
});

test("separate server process restart restores unfinished RR penalty and warning events", async () => {
  const port = await freeTcpPort();
  const dataDir = mkdtempSync(join(tmpdir(), "tkd-rr-restart-e2e-"));
  const context = { categoryId: "rr-restart-category", matchId: "rr-restart-fight" };
  let child: ChildProcess | null = null;
  try {
    child = await launchExtraServer(port, dataDir);
    const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"], timeout: 3_000 });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    const loaded = await new Promise<{ ok: boolean }>((resolve) =>
      socket.emit(
        "match:load",
        {
          categoryId: context.categoryId,
          tournamentName: "Isolated restart RR",
          rules: { ...baselineRules, judgesCount: 4, judgingMode: "flags" },
          match: {
            id: context.matchId,
            ringId: "ring-1",
            matchMode: "sparring",
            requireIndividualFlags: true,
            red: { id: "restart-red", name: "Rojo" },
            blue: { id: "restart-blue", name: "Azul" },
          },
        },
        resolve
      )
    );
    expect(loaded.ok).toBe(true);
    socket.emit("match:start", context);
    await expect.poll(async () => (await extraServerState(port)).matchState?.phase).toBe("round");
    socket.emit("match:event", {
      ...context,
      judgeId: "arbiter",
      competitor: "red",
      type: "minus_point",
    });
    socket.emit("match:event", {
      ...context,
      judgeId: "arbiter",
      competitor: "blue",
      type: "warning_minor",
    });
    const expected = [
      { competitor: "red", type: "minus_point" },
      { competitor: "blue", type: "warning_minor" },
    ];
    await expect
      .poll(async () => (await extraServerState(port)).matchState?.rounds[0]?.events)
      .toMatchObject(expected);
    socket.disconnect();
    await stopExtraServer(child);
    child = await launchExtraServer(port, dataDir);
    const restored = await extraServerState(port);
    expect(restored.match?.id).toBe(context.matchId);
    expect(restored.matchState?.rounds[0]?.events).toMatchObject(expected);
  } finally {
    if (child) await stopExtraServer(child);
    removeExtraDataDir(dataDir);
  }
});

test("post-clock chief sanctions and pending result survive two server restarts", async () => {
  const port = await freeTcpPort();
  const dataDir = mkdtempSync(join(tmpdir(), "tkd-rr-restart-e2e-"));
  const identity = { categoryId: "rr-sanction-restart", matchId: "rr-sanction-fight" };
  let child: ChildProcess | null = null;
  let socket: Socket | null = null;
  try {
    child = await launchExtraServer(port, dataDir);
    socket = await connectExtraSocket(port);
    const loaded = await extraAck<{ ok: boolean }>(socket, "match:load", {
      categoryId: identity.categoryId,
      tournamentName: "Isolated sanction restart",
      rules: { ...baselineRules, judgesCount: 4, judgingMode: "flags" },
      match: {
        id: identity.matchId,
        ringId: "ring-1",
        matchMode: "sparring",
        requireIndividualFlags: true,
        red: { id: "sanction-red", name: "Rojo" },
        blue: { id: "sanction-blue", name: "Azul" },
      },
    });
    expect(loaded.ok).toBe(true);
    socket.emit("match:start", identity);
    await expect.poll(async () => (await extraServerState(port)).matchState?.phase).toBe("round");
    socket.emit("match:finishRound", identity);
    await expect.poll(async () => (await extraServerState(port)).matchState?.phase).toBe("rest");
    for (const change of [
      { competitor: "red", kind: "warning" },
      { competitor: "blue", kind: "minus_point" },
    ] as const) {
      expect(
        await extraAck<{ ok: boolean }>(socket, "mesa:setSanctionCount", {
          ...identity,
          ...change,
          expectedCount: 0,
          count: 1,
        })
      ).toMatchObject({ ok: true });
    }
    expect((await extraServerState(port)).penaltyCounts).toEqual({
      warnings: { red: 1, blue: 0 },
      fouls: { red: 0, blue: 1 },
    });
    socket.disconnect();
    socket = null;
    await stopExtraServer(child);
    child = await launchExtraServer(port, dataDir);
    expect((await extraServerState(port)).matchState?.phase).toBe("rest");
    expect((await extraServerState(port)).penaltyCounts).toEqual({
      warnings: { red: 1, blue: 0 },
      fouls: { red: 0, blue: 1 },
    });

    socket = await connectExtraSocket(port);
    for (const judgeId of ["J1", "J2", "J3", "J4"]) {
      socket.emit("mesa:flagVote", { ...identity, judgeId, vote: "red" });
    }
    socket.emit("mesa:confirmRound", identity);
    await expect
      .poll(async () => {
        const response = await extraAck<{ result: { status: string } | null }>(
          socket as Socket,
          "match:result:get",
          identity
        );
        return response.result?.status;
      })
      .toBe("pending_confirmation");
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:setSanctionCount", {
        ...identity,
        competitor: "red",
        kind: "warning",
        expectedCount: 1,
        count: 0,
      })
    ).toMatchObject({ ok: true });
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:setSanctionCount", {
        ...identity,
        competitor: "blue",
        kind: "minus_point",
        expectedCount: 1,
        count: 2,
      })
    ).toMatchObject({ ok: true });
    const pending = await extraAck<{
      result: {
        status: string;
        warningsRed: number;
        foulsBlue: number;
      } | null;
    }>(socket, "match:result:get", identity);
    expect(pending.result).toMatchObject({
      status: "pending_confirmation",
      warningsRed: 0,
      foulsBlue: 2,
    });
    expect(
      await extraAck<{ ok: boolean; code?: string; status?: number }>(
        socket,
        "mesa:setSanctionCount",
        {
          ...identity,
          competitor: "blue",
          kind: "minus_point",
          expectedCount: 1,
          count: 3,
        }
      )
    ).toMatchObject({ ok: false, code: "stale_count", status: 409 });
    socket.disconnect();
    socket = null;
    await stopExtraServer(child);
    child = await launchExtraServer(port, dataDir);
    expect((await extraServerState(port)).penaltyCounts).toEqual({
      warnings: { red: 0, blue: 0 },
      fouls: { red: 0, blue: 2 },
    });
    socket = await connectExtraSocket(port);
    const restoredPending = await extraAck<{
      result: {
        status: string;
        warningsRed: number;
        foulsBlue: number;
      } | null;
    }>(socket, "match:result:get", identity);
    expect(restoredPending.result).toMatchObject({
      status: "pending_confirmation",
      warningsRed: 0,
      foulsBlue: 2,
    });
    const confirmed = await extraAck<{ ok: boolean; result?: { status: string } }>(
      socket,
      "match:saveFallo",
      { ...identity, expectedRevision: 0 }
    );
    expect(confirmed).toMatchObject({ ok: true, result: { status: "confirmed" } });
    expect(
      await extraAck<{ ok: boolean; code?: string; status?: number }>(
        socket,
        "mesa:setSanctionCount",
        {
          ...identity,
          competitor: "blue",
          kind: "minus_point",
          expectedCount: 2,
          count: 3,
        }
      )
    ).toMatchObject({ ok: false, code: "result_confirmed", status: 409 });
  } finally {
    socket?.disconnect();
    if (child) await stopExtraServer(child);
    removeExtraDataDir(dataDir);
  }
});

test("non-Round-Robin pending sanction corrections survive server restart", async () => {
  const port = await freeTcpPort();
  const dataDir = mkdtempSync(join(tmpdir(), "tkd-rr-restart-e2e-"));
  const identity = { categoryId: "elimination-sanction-restart", matchId: "elimination-fight" };
  let child: ChildProcess | null = null;
  let socket: Socket | null = null;
  try {
    child = await launchExtraServer(port, dataDir);
    socket = await connectExtraSocket(port);
    const loaded = await extraAck<{ ok: boolean }>(socket, "match:load", {
      categoryId: identity.categoryId,
      tournamentName: "Isolated elimination restart",
      rules: { ...baselineRules, judgesCount: 4, judgingMode: "flags" },
      match: {
        id: identity.matchId,
        ringId: "ring-1",
        matchMode: "sparring",
        red: { id: "elimination-red", name: "Rojo" },
        blue: { id: "elimination-blue", name: "Azul" },
      },
    });
    expect(loaded.ok).toBe(true);
    socket.emit("match:start", identity);
    await expect.poll(async () => (await extraServerState(port)).matchState?.phase).toBe("round");
    socket.emit("match:finishRound", identity);
    await expect.poll(async () => (await extraServerState(port)).matchState?.phase).toBe("rest");
    for (const judgeId of ["J1", "J2", "J3", "J4"]) {
      socket.emit("mesa:flagVote", { ...identity, judgeId, vote: "red" });
    }
    socket.emit("mesa:confirmRound", identity);
    await expect
      .poll(async () => {
        const response = await extraAck<{ result: { status: string } | null }>(
          socket as Socket,
          "match:result:get",
          identity
        );
        return response.result?.status;
      })
      .toBe("pending_confirmation");
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:setSanctionCount", {
        ...identity,
        competitor: "blue",
        kind: "warning",
        expectedCount: 0,
        count: 1,
      })
    ).toMatchObject({ ok: true });
    socket.disconnect();
    socket = null;
    await stopExtraServer(child);
    child = await launchExtraServer(port, dataDir);
    expect((await extraServerState(port)).penaltyCounts.warnings.blue).toBe(1);
    socket = await connectExtraSocket(port);
    const pending = await extraAck<{ result: { status: string; warningsBlue: number } | null }>(
      socket,
      "match:result:get",
      identity
    );
    expect(pending.result).toMatchObject({ status: "pending_confirmation", warningsBlue: 1 });
    expect(
      await extraAck<{ ok: boolean; result?: { status: string } }>(socket, "match:saveFallo", {
        ...identity,
        expectedRevision: 0,
      })
    ).toMatchObject({ ok: true, result: { status: "confirmed" } });
  } finally {
    socket?.disconnect();
    if (child) await stopExtraServer(child);
    removeExtraDataDir(dataDir);
  }
});

test("separate server restart preserves provisional Golden Point votes for chief review", async () => {
  const port = await freeTcpPort();
  const dataDir = mkdtempSync(join(tmpdir(), "tkd-rr-restart-e2e-"));
  const identity = { categoryId: "rr-gp-review-restart", matchId: "rr-gp-review-fight" };
  let child: ChildProcess | null = null;
  let socket: Socket | null = null;
  try {
    child = await launchExtraServer(port, dataDir);
    socket = await connectExtraSocket(port);
    const load = await extraAck<{ ok: boolean }>(socket, "match:load", {
      categoryId: identity.categoryId,
      tournamentName: "Isolated GP review restart",
      rules: { ...baselineRules, judgesCount: 4, judgingMode: "flags" },
      match: {
        id: identity.matchId,
        ringId: "ring-1",
        matchMode: "sparring",
        goldenPoint: true,
        red: { id: "gp-restart-red", name: "Rojo" },
        blue: { id: "gp-restart-blue", name: "Azul" },
      },
    });
    expect(load.ok).toBe(true);
    for (const judgeId of ["J1", "J2", "J3"]) {
      expect(
        await extraAck<{ ok: boolean }>(socket, "mesa:goldenVote", {
          ...identity,
          judgeId,
          competitor: "red",
          attempt: 1,
        })
      ).toMatchObject({ ok: true });
    }
    expect((await extraServerState(port)).matchState).toMatchObject({
      phase: "golden_point",
      goldenPoint: { attempt: 1, votes: { J1: "red", J2: "red", J3: "red" } },
    });
    socket.disconnect();
    socket = null;
    await stopExtraServer(child);
    child = await launchExtraServer(port, dataDir);
    const restored = await extraServerState(port);
    expect(restored.match?.id).toBe(identity.matchId);
    expect(restored.matchState).toMatchObject({
      phase: "golden_point",
      goldenPoint: { attempt: 1, votes: { J1: "red", J2: "red", J3: "red" } },
    });
    socket = await connectExtraSocket(port);
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:goldenVote", {
        ...identity,
        judgeId: "J3",
        competitor: "blue",
        attempt: 1,
      })
    ).toMatchObject({ ok: true });
    expect((await extraServerState(port)).matchState?.goldenPoint?.votes).toEqual({
      J1: "red",
      J2: "red",
      J3: "blue",
    });
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:goldenVote", {
        ...identity,
        judgeId: "J4",
        competitor: "blue",
        attempt: 1,
      })
    ).toMatchObject({ ok: true });
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:confirmGoldenOutcome", {
        ...identity,
        attempt: 1,
      })
    ).toMatchObject({ ok: true });
    expect((await extraServerState(port)).matchState?.goldenPoint).toEqual({
      attempt: 2,
      votes: {},
    });
    expect(
      await extraAck<{ ok: boolean; alreadyApplied?: boolean }>(
        socket,
        "mesa:confirmGoldenOutcome",
        {
          ...identity,
          attempt: 1,
        }
      )
    ).toMatchObject({ ok: true, alreadyApplied: true });
    expect((await extraServerState(port)).matchState?.goldenPoint).toEqual({
      attempt: 2,
      votes: {},
    });
    for (const judgeId of ["J1", "J2", "J3"]) {
      expect(
        await extraAck<{ ok: boolean }>(socket, "mesa:goldenVote", {
          ...identity,
          judgeId,
          competitor: "blue",
          attempt: 2,
        })
      ).toMatchObject({ ok: true });
    }
    expect((await extraServerState(port)).matchState?.phase).toBe("golden_point");
    expect(
      await extraAck<{ ok: boolean }>(socket, "mesa:confirmGoldenOutcome", {
        ...identity,
        attempt: 2,
      })
    ).toMatchObject({ ok: true });
    expect((await extraServerState(port)).matchState).toMatchObject({
      phase: "finished",
      result: { winner: "blue", reason: "golden_point" },
    });
    const pending = await extraAck<{
      ok: boolean;
      result: { status: string; flagsBlue: number } | null;
    }>(socket, "match:result:get", identity);
    expect(pending).toMatchObject({
      ok: true,
      result: { status: "pending_confirmation", flagsBlue: 3 },
    });
    expect(
      await extraAck<{ ok: boolean; alreadyApplied?: boolean }>(
        socket,
        "mesa:confirmGoldenOutcome",
        {
          ...identity,
          attempt: 2,
        }
      )
    ).toMatchObject({ ok: true, alreadyApplied: true });
    expect((await extraServerState(port)).matchState?.result).toMatchObject({ winner: "blue" });
  } finally {
    socket?.disconnect();
    if (child) await stopExtraServer(child);
    removeExtraDataDir(dataDir);
  }
});


test("Tul correction rejects draw and durably confirms corrected blue winner", async ({ page }) => {
  const categories = new CategoriesPage(page);
  const setup = new SetupPage(page);
  await setup.goto();
  for (const option of ["ADULTOS (18-35)", "GUPS", "Blancos y Puntas Amarillas", "Liviano A", "Masculino", "Tul / Formas"]) {
    await setup.selectCategoryOption(option);
  }
  await setup.addCompetitors(["Tul Uno", "Tul Dos"]);
  await setup.startCategory();
  await page.getByRole("button", { name: "Iniciar ronda actual", exact: true }).click();
  const categoryId = await categories.activeId();
  const original = (await categories.progress()).fights[0];
  await page.getByRole("button", { name: "Iniciar competencia", exact: true }).click();
  await page.getByRole("button", { name: "Iniciar votación", exact: true }).click();
  const fightPage = new FightPage(page);
  for (let judge = 1; judge <= 4; judge++) await fightPage.voteJudge(judge, "red");
  await page.getByRole("button", { name: "Confirmar resultado", exact: true }).click();
  const overlay = page.getByRole("dialog", { name: "Resultado del combate" });
  await expect(overlay).toBeVisible();
  await expect.poll(() => readFightResult(categoryId, original.id)).toMatchObject({ winner: "red", status: "pending_confirmation" });
  await overlay.getByRole("button", { name: /Corregir banderines/ }).click();
  await expect(overlay).not.toBeVisible();
  expect(await readFightResult(categoryId, original.id)).toBeNull();
  await fightPage.voteJudge(1, "blue");
  await fightPage.voteJudge(2, "blue");
  await expect(page.getByRole("button", { name: /Confirmar.*Empate en banderas/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Confirmar resultado", exact: true })).toBeDisabled();
  await fightPage.voteJudge(3, "blue");
  await page.getByRole("button", { name: /Confirmar.*Azul gana el round/ }).click();
  await expect(overlay).toBeVisible();
  await expect.poll(() => readFightResult(categoryId, original.id)).toMatchObject({ winner: "blue", flagsRed: 1, flagsBlue: 3, status: "pending_confirmation" });
  await overlay.getByRole("button", { name: /Confirmar resultado/ }).click();
  const dialog = page.getByRole("dialog", { name: "Registrar resultado del combate" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Confirmar y continuar" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await readConfirmedFight(categoryId, original.id)).toMatchObject({ winner: "blue", flagsRed: 1, flagsBlue: 3, status: "confirmed" });
  expect((await categories.progress()).fights[0]).toMatchObject({ completed: true, winner: "blue" });
});

test("three-athlete elimination advances a BYE and loads only a real contest", async ({ page }) => {
  const setup = new SetupPage(page);
  await setup.goto();
  for (const option of ["ADULTOS (18-35)", "GUPS", "Blancos y Puntas Amarillas", "Liviano A", "Masculino", "Eliminación"]) {
    await setup.selectCategoryOption(option);
  }
  await setup.addCompetitors(["Bye Uno", "Bye Dos", "Bye Tres"]);
  await setup.startCategory();
  await expect(page).toHaveURL(/\/bracket$/);
  const bracket = await page.evaluate(() => {
    const raw = localStorage.getItem("tkd-tournament");
    if (!raw) throw new Error("Missing tournament");
    return JSON.parse(raw).state.bracketMatches as Array<{ round: number; red: { competitor: unknown | null }; blue: { competitor: unknown | null }; completed: boolean; winnerId?: string | null }>;
  });
  expect(bracket.some((match) => match.round === 0 && (!match.red.competitor || !match.blue.competitor) && match.completed && !!match.winnerId)).toBe(true);
  await page.getByRole("button", { name: "Iniciar ronda actual", exact: true }).click();
  const fightPage = new FightPage(page);
  await expect(fightPage.loadFightButton.or(fightPage.startFightButton).first()).toBeVisible();
  if (await fightPage.loadFightButton.isVisible()) await fightPage.loadFight();
  const active = await readRrServerState();
  expect(active.match?.id).toBeTruthy();
  await fightPage.startFight();
  await expect(fightPage.endRoundButton).toBeVisible();
});
