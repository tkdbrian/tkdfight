import { expect } from "@playwright/test";
import { test } from "./category-buttons-test";
import { CategoryButtonsPage } from "./category-buttons-page";

test("setup validation add edit remove and clear-list cancellation preserve intended roster", async ({ page }) => {
  const ui = new CategoryButtonsPage(page); await ui.setup.goto();
  await expect(page.getByTestId("category-primary-action")).toBeDisabled();
  await ui.configure();
  await ui.setup.addCompetitor("Alpha");
  await expect(page.getByTestId("category-primary-action")).toBeDisabled();
  await page.getByPlaceholder("Nombre del competidor").fill("Beta");
  await page.getByTitle("Agregar (Enter)").click();
  await ui.setup.addCompetitor("Gamma");
  await expect(page.getByTestId("category-primary-action")).toBeEnabled();
  const row = page.locator("#tour-competitor-card").getByText("Beta", { exact: true }).locator("../..");
  await row.hover(); await row.getByRole("button").first().click();
  const edit = page.getByRole("dialog", { name: "Editar competidor" });
  await edit.getByLabel("Nombre *", { exact: true }).fill("Beta Editado");
  await edit.getByRole("button", { name: /Guardar/ }).click();
  await expect(edit).not.toBeVisible();
  expect((await ui.categories.progress()).competitors.map((entry) => entry.name)).toEqual(["Alpha", "Beta Editado", "Gamma"]);
  const gamma = page.locator("#tour-competitor-card").getByText("Gamma", { exact: true }).locator("../..");
  await gamma.hover(); await gamma.getByRole("button").last().click();
  await expect(page.getByTestId("category-primary-action")).toBeDisabled();
  await page.getByRole("button", { name: "Vaciar lista", exact: true }).click();
  const clear = page.getByRole("dialog"); await clear.getByRole("button", { name: "Cancelar", exact: true }).click();
  expect((await ui.categories.progress()).competitors).toHaveLength(2);
  await page.getByRole("button", { name: "Vaciar lista", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Vaciar lista", exact: true }).click();
  expect((await ui.categories.progress()).competitors).toHaveLength(0);
});

test("sidebar continue and category navigation never load a fight or change stored identities", async ({ page }) => {
  const ui = new CategoryButtonsPage(page); const initial = await ui.create();
  const commands: string[] = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => commands.push(String(payload))));
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && /\/api\/(ring|categories)/.test(request.url())) writes.push(request.url()); });
  for (const name of ["Competidores", "Reglas", "Resultados", "Historial", "Competidores"]) {
    await page.getByRole("link", { name, exact: true }).click();
    expect((await ui.categories.progress()).config.id).toBe(initial.config.id);
  }
  await page.getByTestId("category-primary-action").click();
  await expect(page).toHaveURL(/\/fight$/);
  await expect(page.getByRole("button", { name: "Cargar combate", exact: true })).toBeVisible();
  expect(await ui.lock()).toBeNull();
  expect((await ui.categories.progress()).fights.map((fight) => fight.id)).toEqual(initial.fights.map((fight) => fight.id));
  expect(writes).toEqual([]);
  expect(commands.filter((frame) => /"match:(?:load|start|reset|saveFallo)"/.test(frame))).toEqual([]);
});

test("tabs add hide reopen and return to active fight preserve category IDs and running lock", async ({ page }) => {
  const ui = new CategoryButtonsPage(page); const a = await ui.create("A");
  const b = await ui.create("B", true);
  expect(b.config.id).not.toBe(a.config.id);
  await ui.categories.select(a.config.id);
  await ui.categories.hide(b.config.id);
  await expect(ui.categories.tab(b.config.id)).toHaveCount(0);
  await ui.categories.reopen(b.config.categoryName, b.config.id);
  await ui.categories.select(a.config.id);
  await ui.loadAndStart(); const lock = await ui.lock(); expect(lock).not.toBeNull();
  await ui.categories.select(b.config.id);
  await expect(page.getByRole("button", { name: "Volver al combate", exact: true })).toBeVisible();
  expect(await ui.lock()).toEqual(lock);
  await page.getByRole("button", { name: "Volver al combate", exact: true }).click();
  await expect(page).toHaveURL(/\/fight$/);
  expect((await ui.categories.progress()).config.id).toBe(a.config.id);
  expect(await ui.lock()).toEqual(lock);
  await ui.competitors();
  await expect(page.getByTestId("restart-category")).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Eliminar categor/ })).toBeDisabled();
});

test("archive restart cancel and delete-restart after roster edit use new identities without stale fights", async ({ page }) => {
  const ui = new CategoryButtonsPage(page); const original = await ui.create();
  let dialog = await ui.restart(); await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  expect((await ui.categories.progress()).fights).toEqual(original.fights);
  dialog = await ui.restart(); await dialog.getByRole("button", { name: "Archivar y reiniciar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await ui.categories.progress()).config.id).not.toBe(original.config.id);
  const archived = await ui.categories.progress();
  expect(archived.fights).toHaveLength(3);
  expect(archived.fights.every((fight) => !original.fights.some((old) => old.id === fight.id))).toBe(true);
  const historyBefore = await ui.categories.history(); expect(historyBefore.length).toBeGreaterThanOrEqual(2);
  await ui.competitors(); await ui.setup.addCompetitor("Nuevo Cuatro");
  dialog = await ui.restart(); await dialog.getByLabel("Eliminar y reiniciar", { exact: true }).check();
  const typed = dialog.getByLabel(/Escrib. ELIMINAR/);
  await expect(dialog.getByText(/4 competidores/)).toBeVisible();
  if (await typed.isVisible()) await typed.fill("ELIMINAR");
  await dialog.getByRole("button", { name: "Eliminar y reiniciar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await ui.categories.progress()).config.id).not.toBe(archived.config.id);
  const restarted = await ui.categories.progress();
  expect(restarted.competitors).toHaveLength(4); expect(restarted.fights).toHaveLength(6);
  expect(restarted.fights.every((fight) => !archived.fights.some((old) => old.id === fight.id))).toBe(true);
  await expect.poll(async () => (await ui.categories.queue(restarted.config.id)).length).toBe(6);
});

test("delete category cancel and typed confirmation preserve other category", async ({ page }) => {
  const ui = new CategoryButtonsPage(page); const a = await ui.create("A"); const b = await ui.create("B", true);
  await ui.categories.select(a.config.id);
  let dialog = await ui.deletion();
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  expect((await ui.categories.progress()).config.id).toBe(a.config.id);
  expect((await ui.categories.queue(a.config.id))).toHaveLength(3);
  dialog = await ui.deletion();
  const confirm = dialog.getByRole("button", { name: "Eliminar definitivamente", exact: true });
  const text = dialog.getByLabel(/Escrib. ELIMINAR/);
  await expect(text).toBeVisible(); await expect(confirm).toBeDisabled();
  await text.fill("eliminar"); await expect(confirm).toBeDisabled();
  await text.fill("ELIMINAR"); await expect(confirm).toBeEnabled(); await confirm.click();
  await expect(dialog).not.toBeVisible(); await expect(ui.categories.tab(a.config.id)).toHaveCount(0);
  await ui.categories.select(b.config.id);
  expect((await ui.categories.progress()).fights).toEqual(b.fights);
  expect((await ui.categories.queue(b.config.id))).toHaveLength(3);
  expect(await ui.categories.queue(a.config.id)).toEqual([]);
});

test("offline guard blocks lifecycle mutations and reconnect preserves category", async ({ page, context }) => {
  const ui = new CategoryButtonsPage(page); const initial = await ui.create(); await ui.competitors();
  await context.setOffline(true);
  await expect(page.getByTestId("restart-category")).toBeDisabled({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Eliminar categor/ })).toBeDisabled();
  expect((await ui.categories.progress()).fights).toEqual(initial.fights);
  await context.setOffline(false);
  await expect(page.getByTestId("restart-category")).toBeEnabled({ timeout: 15_000 });
  expect((await ui.categories.queue(initial.config.id))).toHaveLength(3);
});



for (const [mode, rosterCount] of [["elimination", 0], ["elimination", 1], ["round-robin", 0], ["round-robin", 1], ["round-robin", 2]] as const) {
  for (const destructive of [false, true]) test(`draft restart ${mode} roster ${rosterCount} delete ${destructive} then explicit start`, async ({ page }) => {
    const ui = new CategoryButtonsPage(page); await ui.setup.goto(); await ui.configure();
    if (mode === "elimination") await ui.setup.selectCategoryOption("Eliminaci\u00f3n");
    await ui.setup.addCompetitors(["Old Uno", "Old Dos", "Old Tres"]); await ui.setup.startCategory();
    await ui.competitors(); await page.getByRole("button", { name: "Vaciar lista", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Vaciar lista", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect.poll(async () => (await ui.categories.progress()).competitors.length).toBe(0);
    for (let index = 0; index < rosterCount; index++) await ui.setup.addCompetitor(`Current ${index}`);
    const before = await ui.categories.progress();
    const dialog = await ui.restart();
    if (destructive) {
      await dialog.getByLabel("Eliminar y reiniciar", { exact: true }).check();
      const typed = dialog.getByLabel(/Escrib. ELIMINAR/);
      await expect(typed).toBeVisible(); await typed.fill("ELIMINAR");
    }
    await dialog.getByRole("button", { name: destructive ? "Eliminar y reiniciar" : "Archivar y reiniciar", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect.poll(async () => (await ui.categories.progress()).config.id).not.toBe(before.config.id);
    const draft = await ui.categories.progress();
    expect(draft).toMatchObject({ phase: "setup", setupStarted: false, fights: [], groups: [], bracketMatches: [], bracketSeeds: [], currentFightIndex: 0 });
    expect(draft.competitors.map(({ id: _id, ...entrant }) => entrant)).toEqual(before.competitors.map(({ id: _id, ...entrant }) => entrant));
    expect(draft.competitors.every((entry) => !before.competitors.some((old) => old.id === entry.id))).toBe(true);
    await expect(page.getByTestId("category-primary-action")).toHaveText(/Iniciar categor/);
    await expect(page.getByTestId("category-primary-action")).toBeDisabled();
    expect(await ui.categories.queue(draft.config.id)).toEqual([]);
    const minimum = mode === "elimination" ? 2 : 3;
    for (let index = rosterCount; index < minimum; index++) await ui.setup.addCompetitor(`Added ${index}`);
    await expect(page.getByTestId("category-primary-action")).toBeEnabled();
    expect((await ui.categories.progress()).fights).toEqual([]);
    await page.getByTestId("category-primary-action").click();
    await expect.poll(async () => (await ui.categories.progress()).phase).toBe("fighting");
    const started = await ui.categories.progress();
    expect(started.config.id).toBe(draft.config.id);
    if (mode === "elimination") expect(started.bracketMatches).toHaveLength(1);
    else expect(started.fights).toHaveLength(3);
  });
}
