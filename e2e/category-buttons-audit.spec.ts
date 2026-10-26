import { expect } from "@playwright/test";
import { test } from "./category-buttons-test";
import { CategoryButtonsPage } from "./category-buttons-page";
import { CompactCategoryPage } from "./compact-category-page";

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
    if (mode === "elimination") {
      await page.getByRole("button", { name: /^Editar Formato:/ }).click();
      await page.locator("#category-editor").getByRole("button", { name: "Eliminaci\u00f3n" }).click();
      await expect(page.getByTestId("guided-review")).toBeVisible();
    }
    await ui.setup.addCompetitors(["Old Uno", "Old Dos", "Old Tres"]);
    await expect(page.getByTestId("category-primary-action")).toBeEnabled();
    await ui.setup.startCategory();
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

test("guided category editor reveals one decision at a time across desktop mobile and remounts", async ({ page }, testInfo) => {
  const compact = new CompactCategoryPage(page);
  const categories = new CategoryButtonsPage(page).categories;
  await page.setViewportSize({ width: 1280, height: 800 });
  await compact.openFreshTournament();
  await expect(compact.activeStep).toContainText("Edad");
  await expect(compact.editor.getByRole("group", { name: "G\u00e9nero" })).toHaveCount(0);
  await compact.assertViewportAndTargets(["KIDS (3-5)"], testInfo, "guided-category-age-desktop");

  const kids = compact.choice("KIDS (3-5)");
  await kids.focus();
  await expect(kids).toBeFocused();
  await page.keyboard.press("Space");
  await expect(compact.activeStep).toContainText("Sistema de grado");
  await expect(compact.activeStep).toBeFocused();
  await expect(compact.editor.getByRole("button", { name: /^Editar Edad:/ })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(compact.choice("GUPS")).toBeFocused();
  await page.keyboard.press("Enter");
  await compact.select("Rango GUP", "Blancos y Puntas Amarillas");
  await compact.select("G\u00e9nero", "Masculino");
  await compact.select("Disciplina", "Sparring");
  await compact.select("Peso", "Liviano A");
  await compact.select("Formato", "Round Robin");
  await expect(compact.review).toBeVisible();
  await expect(compact.editor.getByText("Tiempo y perfil activos")).toBeVisible();
  await compact.capture(testInfo, "guided-category-review-desktop");
  const categoryA = await categories.activeId();

  await page.setViewportSize({ width: 390, height: 844 });
  await compact.assertViewportAndTargets([], testInfo, "guided-category-review-mobile");
  await compact.edit("Disciplina");
  await compact.assertViewportAndTargets(["Tul / Formas"], testInfo, "guided-category-discipline-mobile");
  await compact.choice("Tul / Formas").click();
  await expect(compact.review).toBeVisible();
  await expect(compact.editor.getByRole("group", { name: "Peso" })).toHaveCount(0);
  await compact.continueToCompetitors();

  await page.getByRole("button", { name: /Agregar categor/ }).click();
  await expect(compact.editor).toBeVisible();
  const categoryB = await categories.activeId();
  expect(categoryB).not.toBe(categoryA);
  await compact.select("Edad", "KIDS (3-5)");
  await compact.select("Sistema de grado", "GUPS");
  await compact.select("Rango GUP", "Blancos y Puntas Amarillas");
  await compact.skip("G\u00e9nero");
  await compact.select("Disciplina", "Sparring");
  await compact.select("Peso", "Mediano B");
  await compact.select("Formato", "Round Robin");
  await compact.continueToCompetitors();

  await categories.select(categoryA);
  await page.getByRole("button", { name: /Configurar categor/ }).click();
  await expect(compact.editor).toBeVisible();
  await compact.edit("Disciplina");
  await compact.choice("Sparring").click();
  await compact.edit("Peso");
  await expect(compact.choice("Liviano A")).toHaveAttribute("aria-pressed", "true");

  await categories.select(categoryB);
  await page.getByRole("button", { name: /Configurar categor/ }).click();
  await expect(compact.editor).toBeVisible();
  await compact.edit("Peso");
  await expect(compact.choice("Mediano B")).toHaveAttribute("aria-pressed", "true");
});

test("guided optional skips and custom ranges preserve start rules", async ({ page }) => {
  const compact = new CompactCategoryPage(page);
  await compact.openFreshTournament();
  await compact.skip("Edad");
  await compact.skip("Sistema de grado");
  await compact.skip("G\u00e9nero");
  await compact.select("Disciplina", "Sparring");
  await compact.skip("Peso");
  await compact.select("Formato", "Round Robin");
  await expect(compact.review).toBeVisible();
  await expect(compact.editor.getByRole("button", { name: /^Editar Edad: No especificar$/ })).toBeVisible();
  await expect(compact.editor.getByRole("button", { name: /^Editar Peso: No especificar$/ })).toBeVisible();

  await compact.edit("Edad");
  await compact.choice("Personalizada").click();
  await compact.editor.getByRole("spinbutton", { name: "Edad desde" }).fill("12");
  await compact.editor.getByRole("spinbutton", { name: "Edad hasta" }).fill("8");
  await compact.choice("Aplicar edad").click();
  await expect(compact.editor.getByRole("alert")).toBeVisible();
  await expect(compact.activeStep).toContainText("Edad");
  await compact.editor.getByRole("spinbutton", { name: "Edad hasta" }).fill("14");
  await compact.choice("Aplicar edad").click();
  await expect(compact.review).toBeVisible();

  await compact.edit("Sistema de grado");
  await compact.select("Sistema de grado", "DANES");
  await compact.editor.getByRole("spinbutton", { name: "Grado Dan desde" }).fill("3");
  await compact.editor.getByRole("spinbutton", { name: "Grado Dan hasta" }).fill("1");
  await compact.choice("Aplicar rango Dan").click();
  await expect(compact.editor.getByRole("alert")).toBeVisible();
  await expect(compact.activeStep).toContainText("Grado (Dan)");
  await compact.editor.getByRole("spinbutton", { name: "Grado Dan desde" }).fill("1");
  await compact.editor.getByRole("spinbutton", { name: "Grado Dan hasta" }).fill("3");
  await compact.choice("Aplicar rango Dan").click();
  await expect(compact.review).toBeVisible();
  await compact.continueToCompetitors();
  await expect(page.getByTestId("category-primary-action")).toBeDisabled();
});
test("Round Robin order appears after sixth entrant even when guided format was completed", async ({ page }, testInfo) => {
  const ui = new CategoryButtonsPage(page);
  await ui.setup.goto();
  await ui.configure();
  const compact = new CompactCategoryPage(page);
  await expect(compact.review).toBeVisible();
  await expect(compact.editor.getByRole("group", { name: "Orden de combates" })).toHaveCount(0);
  await compact.continueToCompetitors();
  await ui.setup.addCompetitors(["A", "B", "C", "D", "E", "F"]);
  await page.getByRole("button", { name: /Configurar categor/ }).click();
  const order = compact.editor.getByRole("group", { name: "Orden de combates" });
  await expect(order).toBeVisible();
  await expect(order.getByRole("button", { name: "Optimizar descanso (un tatami)" }))
    .toHaveAttribute("aria-pressed", "true");
  await compact.capture(testInfo, "guided-category-rr-order-six");
  await order.getByRole("button", { name: "Por llave (varios tatamis)" }).click();
  await expect(order.getByRole("button", { name: "Por llave (varios tatamis)" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(compact.review).toBeVisible();
});

test("completed category answers form readable responsive cards", async ({ page }, testInfo) => {
  const compact = new CompactCategoryPage(page);
  await compact.openFreshTournament();
  const ui = new CategoryButtonsPage(page);
  await ui.configure();
  const grid = page.getByTestId("category-answer-grid");
  await expect(grid).toBeVisible();

  const positions = async (): Promise<Array<{ x: number; y: number; width: number }>> => {
    const cards = ["Edad", "Sistema de grado", "Rango GUP"].map((step) =>
      grid.getByRole("button", { name: new RegExp(`^Editar ${step}:`) }),
    );
    const boxes = await Promise.all(cards.map((card) => card.boundingBox()));
    return boxes.map((box, index) => {
      expect(box, `card ${index + 1} has a layout box`).not.toBeNull();
      if (!box) throw new Error(`Missing card ${index + 1}`);
      return { x: box.x, y: box.y, width: box.width };
    });
  };

  await page.setViewportSize({ width: 390, height: 844 });
  let cards = await positions();
  expect(cards[0].y).toBeLessThan(cards[1].y);
  expect(cards[1].y).toBeLessThan(cards[2].y);

  await page.setViewportSize({ width: 1366, height: 768 });
  cards = await positions();
  expect(Math.abs(cards[0].y - cards[1].y)).toBeLessThan(3);
  expect(cards[2].y).toBeGreaterThan(cards[0].y);
  await compact.captureRegion(testInfo, "setup-review-cards-laptop", compact.editor);

  await page.setViewportSize({ width: 1920, height: 900 });
  cards = await positions();
  expect(Math.abs(cards[0].y - cards[1].y)).toBeLessThan(3);
  expect(Math.abs(cards[1].y - cards[2].y)).toBeLessThan(3);
  expect(cards.every((card) => card.width > 200)).toBe(true);
});

test("three-person elimination preview shows semifinal and pending final with legible names", async ({ page }, testInfo) => {
  const ui = new CategoryButtonsPage(page);
  await ui.setup.goto();
  await ui.configure();
  const compact = new CompactCategoryPage(page);
  await compact.edit("Formato");
  await compact.choice("Eliminación").click();
  await expect(compact.review).toBeVisible();

  const names = [
    "Juan Pedro Fernández del Club Central",
    "Sebastián Martín González del Club Norte",
    "Pedro Nicolás Rodríguez del Club Sur",
  ];
  await page.setViewportSize({ width: 1366, height: 768 });
  await ui.setup.addCompetitors(names);
  const preview = page.getByTestId("setup-fixture-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Semifinal", { exact: true })).toBeVisible();
  await expect(preview.getByText("Final", { exact: true })).toBeVisible();
  await expect(preview.getByText("Por definir", { exact: true })).toBeVisible();
  await expect(preview.getByText("2 combates", { exact: true })).toBeVisible();

  const input = compact.competitorName;
  const listName = page.locator("#tour-competitor-card").getByText(names[0], { exact: true });
  const previewName = preview.getByText(names[0], { exact: true }).first();
  for (const locator of [input, listName, previewName]) {
    await expect(locator).toBeVisible();
    const fontSize = await locator.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(16);
  }
  const inputHeight = await input.evaluate((element) => element.getBoundingClientRect().height);
  expect(inputHeight).toBeGreaterThanOrEqual(48);
  for (const name of [listName, previewName]) {
    const style = await name.evaluate((element) => ({
      whiteSpace: getComputedStyle(element).whiteSpace,
      overflow: getComputedStyle(element).textOverflow,
    }));
    expect(style.whiteSpace).not.toBe("nowrap");
    expect(style.overflow).not.toBe("ellipsis");
  }
  await compact.captureRegion(
    testInfo,
    "setup-elimination-preview-readable-laptop",
    page.locator("#tour-competitor-card").locator(".."),
  );

  await page.setViewportSize({ width: 1093, height: 614 }); // ~1366 px at 125% zoom
  await expect(previewName).toBeVisible();
  const horizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(horizontalOverflow).toBeLessThanOrEqual(1);

  await page.getByTestId("category-primary-action").click();
  await expect(page).toHaveURL(/\/bracket$/);
  await page.getByRole("link", { name: "Competidores", exact: true }).click();
  const savedPreview = page.getByTestId("setup-fixture-preview");
  await expect(savedPreview.getByText("Semifinal", { exact: true })).toBeVisible();
  await expect(savedPreview.getByText("Final", { exact: true })).toBeVisible();
  await expect(savedPreview.getByText("Por definir", { exact: true })).toBeVisible();
  await expect(savedPreview.getByText("0 de 2 combates completados")).toBeVisible();
});
