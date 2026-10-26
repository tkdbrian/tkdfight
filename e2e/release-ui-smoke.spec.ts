import { expect, type Page } from "@playwright/test";
import { io } from "socket.io-client";
import type { ServerState } from "../src/lib/socket-types";
import { test } from "./isolated-test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";
import { RoundRobinPage, readConfirmedFight } from "./round-robin-page";

const apiUrl = "http://127.0.0.1:3397";

async function ringState(): Promise<ServerState> {
  return new Promise((resolve, reject) => {
    const socket = io(apiUrl, { autoConnect: false, transports: ["websocket"], timeout: 3_000 });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Isolated ring state timed out"));
    }, 5_000);
    socket.once("state:update", (state: ServerState) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(state);
    });
    socket.once("connect_error", (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
    socket.connect();
  });
}

async function createSparringCategory(page: Page, names: string[]): Promise<RoundRobinPage> {
  const setup = new SetupPage(page);
  await setup.goto();
  const editor = page.locator("#category-editor");
  for (const label of [
    "ADULTOS (18-35)", "GUPS", "Blancos y Puntas Amarillas", "Masculino",
    "Sparring", "Liviano A", "Round Robin",
  ]) {
    await editor.getByRole("button", { name: label, exact: true }).click();
  }
  await expect(page.getByTestId("guided-review")).toBeVisible();
  await setup.addCompetitors(names);
  const roster = page.locator("#tour-competitor-card");
  const start = roster.getByTestId("category-primary-action");
  await expect(start).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(start).toHaveAttribute("id", "tour-start-btn");
  expect((await start.boundingBox())?.height).toBeGreaterThanOrEqual(56);
  // Start is beside roster entry, before the list, rather than lost in the header.
  expect(await roster.evaluate((node) => {
    const button = node.querySelector('[data-testid="category-primary-action"]');
    const list = node.querySelector('[data-testid="setup-competitor-list"]');
    return !!button && !!list && !!(button.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await start.click();
  await expect(page).toHaveURL(/\/standings$/);
  await page.getByRole("button", { name: "Ir a Combate", exact: true }).click();
  await expect(page).toHaveURL(/\/fight$/);
  return new RoundRobinPage(page);
}

test("swapping a loaded sparring bout keeps red left, blue right and awards the swapped red athlete", async ({ page, context }) => {
  const rr = await createSparringCategory(page, ["Ana Roja", "Beto Azul", "Ceci Test"]);
  const fight = new FightPage(page);
  const original = await rr.currentFight();
  await fight.loadFight();
  const before = await ringState();
  expect(before.match).toMatchObject({
    id: original.id,
    red: { id: original.red.id, name: original.red.name },
    blue: { id: original.blue.id, name: original.blue.name },
  });
  const token = before.ringToken;
  expect(token).toBeTruthy();
  const judge = await context.newPage();
  await judge.goto(`${apiUrl}/judge?id=1&token=${encodeURIComponent(token!)}`);
  await expect(judge.locator("#status")).toContainText("J1 listo");
  await expect(judge.locator("#hdr-red")).toHaveText(original.red.name);
  await expect(judge.locator("#hdr-blue")).toHaveText(original.blue.name);

  await page.getByRole("button", { name: "Intercambiar competidores", exact: true }).click();
  await expect(fight.startFightButton).toBeEnabled();
  await expect(page.getByTestId("red-station-desktop")).toContainText(original.blue.name);
  await expect(page.getByTestId("blue-station-desktop")).toContainText(original.red.name);
  await expect(judge.locator("#hdr-red")).toHaveText(original.blue.name);
  await expect(judge.locator("#hdr-blue")).toHaveText(original.red.name);
  const redBox = await page.getByTestId("red-station-desktop").boundingBox();
  const blueBox = await page.getByTestId("blue-station-desktop").boundingBox();
  expect(redBox && blueBox && redBox.x < blueBox.x).toBe(true);
  const judgeRedBox = await judge.locator("#hdr-red").boundingBox();
  const judgeBlueBox = await judge.locator("#hdr-blue").boundingBox();
  expect(judgeRedBox && judgeBlueBox && judgeRedBox.x < judgeBlueBox.x).toBe(true);
  const swapped = await ringState();
  expect(swapped.match).toMatchObject({
    id: original.id,
    red: { id: original.blue.id },
    blue: { id: original.red.id },
  });
  expect(swapped.match?.preFight?.revision).toBeGreaterThan(before.match?.preFight?.revision ?? -1);
  await judge.close();

  await page.reload();
  await expect(page.getByTestId("red-station-desktop")).toContainText(original.blue.name);
  await expect(page.getByTestId("blue-station-desktop")).toContainText(original.red.name);
  await expect(fight.startFightButton).toBeEnabled();
  const completed = await rr.finishTimed(["red", "red", "red", "red"]);
  expect(completed.fight.id).toBe(original.id);
  const durable = await readConfirmedFight(completed.progress.config.id, original.id);
  expect(durable).toMatchObject({ status: "confirmed", winner: "red", flagsRed: 4, flagsBlue: 0 });
  const saved = completed.progress.fights.find((entry) => entry.id === original.id);
  expect(saved).toMatchObject({ red: { id: original.blue.id }, blue: { id: original.red.id }, winner: "red" });
});

test("five-person postponement suggests the rested fight without reordering the saved queue", async ({ page }) => {
  const rr = await createSparringCategory(page, ["RR A", "RR B", "RR C", "RR D", "RR E"]);
  const fight = new FightPage(page);
  const initial = await rr.progress();
  expect(initial.fights).toHaveLength(10);
  const [ab, cd, ae] = initial.fights;
  expect(new Set([ab.red.id, ab.blue.id, cd.red.id, cd.blue.id]).size).toBe(4);
  for (let index = 1; index < initial.fights.length; index++) {
    const previous = initial.fights[index - 1];
    const next = initial.fights[index];
    expect(new Set([previous.red.id, previous.blue.id, next.red.id, next.blue.id]).size).toBe(4);
  }
  expect([ae.red.id, ae.blue.id].some((id) => id === ab.red.id || id === ab.blue.id)).toBe(true);
  await rr.finishTimed(["red", "red", "red", "red"]);
  expect((await rr.currentFight()).id).toBe(cd.id);
  await rr.loadCurrent();
  await page.getByRole("button", { name: "Postergar", exact: true }).click();
  await expect.poll(async () => (await rr.currentFight()).id).toBe(ae.id);
  const postponed = await rr.progress();
  const savedOrder = postponed.fights.map((entry) => entry.id);
  await page.reload();
  await expect.poll(async () => (await rr.progress()).fights.map((entry) => entry.id)).toEqual(savedOrder);
  // Explicitly choose AE after reload; localStorage may be hydrated before the
  // visible fight selection has settled, so do not infer the UI from storage alone.
  const position = savedOrder.indexOf(ae.id) + 1;
  expect(position).toBeGreaterThan(0);
  await page.getByRole("button", { name: String(position), exact: true }).click();
  await expect(page.locator("#tour-fight-header")).toContainText(ae.red.name);
  await expect(page.locator("#tour-fight-header")).toContainText(ae.blue.name);
  await expect.poll(async () => (await rr.currentFight()).id).toBe(ae.id);
  await expect(fight.loadFightButton).toBeVisible();
  await fight.loadFightButton.click();
  const rest = page.getByRole("dialog", { name: "Descanso entre combates" });
  await expect(rest).toBeVisible();
  await expect(rest).toContainText(`${cd.red.name} vs ${cd.blue.name}`);
  await expect(rest.getByRole("button", { name: "Usar sugerida" })).toBeVisible();
  await rest.getByRole("button", { name: "Usar sugerida" }).click();
  await expect(rest).not.toBeVisible();
  await expect.poll(async () => (await rr.currentFight()).id).toBe(cd.id);
  expect((await rr.progress()).fights.map((entry) => entry.id)).toEqual(savedOrder);
  await fight.loadFight();
  expect((await ringState()).match?.id).toBe(cd.id);
});
