import { test, expect, type Page } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { CategoriesPage } from "./categories-page";

async function configureRoundRobin(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Adultos (18-35)" }).click();
  await page.getByRole("button", { name: "Liviano A", exact: true }).click();
  await page.getByRole("button", { name: "Masculino", exact: true }).click();
  await page.getByRole("button", { name: "Round Robin" }).click();
}

// Run before the existing lock/recovery scenario, which intentionally leaves a pending fight.
test("confirms and advances one category, then preserves A/B results and IDs", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("tkd-tournament");
    localStorage.removeItem("tkd-tournament-categories");
  });
  await page.reload();
  const categories = new CategoriesPage(page);

  const categoryAId = await categories.createTulRoundRobin(["A Uno", "A Dos", "A Tres"]);
  await expect(page.getByRole("tab")).toHaveCount(1);
  const initialA = await categories.progress();
  expect(initialA.config).toMatchObject({ id: categoryAId, matchType: "tul", mode: "round-robin" });
  expect(initialA.fights).toHaveLength(3);
  await expect.poll(async () => (await categories.queue(categoryAId)).length).toBe(3);
  const queueA = await categories.queue(categoryAId);
  expect(queueA.map(({ fight }) => fight.id)).toEqual(initialA.fights.map((fight) => fight.id));
  const tournamentAId = queueA[0].fight.red.tournament_id;
  expect(tournamentAId).toBeGreaterThan(0);
  expect(queueA.every(({ fight }) => fight.categoryId === categoryAId
    && fight.red.tournament_id === tournamentAId && fight.blue.tournament_id === tournamentAId))
    .toBe(true);

  await categories.confirmCurrentTul("red");
  await expect.poll(() => categories.progress()).toMatchObject({
    currentFightIndex: 1,
    fights: [{ id: initialA.fights[0].id, completed: true, winner: "red", flagsRed: 4, flagsBlue: 0 },
      { id: initialA.fights[1].id, completed: false }, { id: initialA.fights[2].id, completed: false }],
  });
  const confirmedA = await categories.progress();
  await expect.poll(async () => (await categories.queue(categoryAId)).map(({ fight }) => fight.id))
    .toEqual(initialA.fights.slice(1).map((fight) => fight.id));

  const categoryBId = await categories.createTulRoundRobin(["B Uno", "B Dos", "B Tres"], true);
  expect(categoryBId).not.toBe(categoryAId);
  await expect(page.getByRole("tab")).toHaveCount(2);
  const initialB = await categories.progress();
  await expect.poll(async () => (await categories.queue(categoryBId)).length).toBe(3);
  const queueB = await categories.queue(categoryBId);
  const tournamentBId = queueB[0].fight.red.tournament_id;
  expect(tournamentBId).toBeGreaterThan(0);
  expect(tournamentBId).not.toBe(tournamentAId);
  expect(queueB.map(({ fight }) => fight.id)).toEqual(initialB.fights.map((fight) => fight.id));
  expect(queueB.every(({ fight }) => fight.categoryId === categoryBId
    && fight.red.tournament_id === tournamentBId && fight.blue.tournament_id === tournamentBId))
    .toBe(true);
  expect(initialB.fights.every((fight) => !initialA.fights.some((a) => a.id === fight.id))).toBe(true);
  await categories.confirmCurrentTul("blue");
  await expect.poll(() => categories.progress()).toMatchObject({
    currentFightIndex: 1,
    fights: [{ id: initialB.fights[0].id, completed: true, winner: "blue", flagsRed: 0, flagsBlue: 4 },
      { id: initialB.fights[1].id, completed: false }, { id: initialB.fights[2].id, completed: false }],
  });
  const confirmedB = await categories.progress();

  await categories.select(categoryAId);
  await expect.poll(() => categories.progress()).toEqual(confirmedA);
  await expect(page.locator("span.tabular-nums").filter({ hasText: /^2\/3$/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Iniciar competencia", exact: true })).toBeVisible();
  await page.reload();
  await expect(categories.activeCategory).toHaveAttribute("data-active-category", categoryAId);
  await expect.poll(() => categories.progress()).toEqual(confirmedA);

  await categories.select(categoryBId);
  await expect.poll(() => categories.progress()).toEqual(confirmedB);
  await categories.hide(categoryAId);
  await expect(page.getByRole("tab")).toHaveCount(1);
  await categories.reopen(confirmedA.config.categoryName, categoryAId);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await categories.select(categoryAId);
  await categories.select(categoryAId);
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(categories.tab(categoryAId)).toHaveCount(1);
  await expect.poll(() => categories.progress()).toEqual(confirmedA);

  const history = await categories.history();
  const historyA = history.find((tournament) => tournament.id === tournamentAId);
  const historyB = history.find((tournament) => tournament.id === tournamentBId);
  expect(historyA).toBeDefined();
  expect(historyB).toBeDefined();
  expect(historyA?.fights.map((fight) => fight.id).sort())
    .toEqual(initialA.fights.map((fight) => fight.id).sort());
  expect(historyB?.fights.map((fight) => fight.id).sort())
    .toEqual(initialB.fights.map((fight) => fight.id).sort());
  expect(historyA?.fights.filter((fight) => fight.completed))
    .toEqual([expect.objectContaining({ id: initialA.fights[0].id, completed: true, winner: "red" })]);
  expect(historyB?.fights.filter((fight) => fight.completed))
    .toEqual([expect.objectContaining({ id: initialB.fights[0].id, completed: true, winner: "blue" })]);
  expect(historyA?.competitors.map((competitor) => competitor.id).sort())
    .toEqual([...new Set(initialA.fights.flatMap((fight) => [fight.red.id, fight.blue.id]))].sort());
  expect(historyB?.competitors.map((competitor) => competitor.id).sort())
    .toEqual([...new Set(initialB.fights.flatMap((fight) => [fight.red.id, fight.blue.id]))].sort());
  expect(historyA?.fights.some((fight) => initialB.fights.some((b) => b.id === fight.id))).toBe(false);
  expect(historyB?.fights.some((fight) => initialA.fights.some((a) => a.id === fight.id))).toBe(false);
});

test("preserves independent categories across switching, reload, hide and reopen", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("tkd-tournament");
    localStorage.removeItem("tkd-tournament-categories");
  });
  await page.reload();

  const setup = new SetupPage(page);
  await setup.goto();
  await configureRoundRobin(page);
  await setup.addCompetitors(["A Uno", "A Dos", "A Tres"]);
  await setup.startCategory();

  const activeCategory = page.locator("[data-active-category]");
  const categoryAId = await activeCategory.getAttribute("data-active-category");
  expect(categoryAId).toBeTruthy();

  await page.getByRole("button", { name: "Agregar categoría" }).click();
  await expect(page.getByRole("tab", { name: "Nueva categoría" })).toBeVisible();
  await configureRoundRobin(page);
  await setup.addCompetitors(["B Uno", "B Dos", "B Tres"]);
  await setup.startCategory();

  const categoryBId = await activeCategory.getAttribute("data-active-category");
  expect(categoryBId).toBeTruthy();
  expect(categoryBId).not.toBe(categoryAId);
  await expect(page.getByRole("tab").nth(0)).toContainText("Liviano A · Masculino · 18-35 años (1)");
  await expect(page.getByRole("tab").nth(1)).toContainText("Liviano A · Masculino · 18-35 años (2)");

  await page.reload();
  await expect(activeCategory).toHaveAttribute("data-active-category", categoryBId!);

  await page.getByRole("button", { name: "Ocultar Liviano A · Masculino · 18-35 años" }).first().click();
  await page.getByText("Ocultas", { exact: true }).click();
  await page.getByRole("button", { name: "Liviano A · Masculino · 18-35 años", exact: true }).click();
  await page.getByRole("tab").first().click();
  await page.getByRole("link", { name: "Competidores" }).click();
  await expect(page.getByText("A Uno", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("B Uno", { exact: true })).toHaveCount(0);

  await page.getByRole("tab").nth(1).click();
  await expect(activeCategory).toHaveAttribute("data-active-category", categoryBId!);
  await page.getByRole("link", { name: "Competidores" }).click();
  await expect(page.getByText("B Uno", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("A Uno", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Combate" }).click();
  await page.getByRole("button", { name: "Cargar combate" }).click();
  await expect(page.getByRole("status").getByText(/Combate en/)).toBeVisible();
  await page.reload();
  await expect(activeCategory).toHaveAttribute("data-active-category", categoryBId!);
  await page.getByRole("tab").first().click();
  await expect(activeCategory).toHaveAttribute("data-active-category", categoryAId!);
  await expect(page).toHaveURL(/\/standings$/);
  await expect(page.getByRole("button", { name: "Volver al combate" })).toBeVisible();
  await page.getByRole("button", { name: "Volver al combate" }).click();
  await expect(activeCategory).toHaveAttribute("data-active-category", categoryBId!);
  await expect(page).toHaveURL(/\/fight$/);
});

test("prepares B while A is running without replacing the active server fight", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("tkd-tournament");
    localStorage.removeItem("tkd-tournament-categories");
  });
  await page.reload();
  const setup = new SetupPage(page);
  await setup.goto();
  await configureRoundRobin(page);
  await setup.addCompetitors(["A Uno", "A Dos", "A Tres"]);
  await setup.startCategory();
  const categories = new CategoriesPage(page);
  const aId = await categories.activeId();
  const aProgress = await categories.progress();
  await page.getByRole("button", { name: "Cargar combate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Iniciar combate", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Iniciar combate", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible();

  let activationCalls = 0;
  await page.route("**/api/ring/activate-category", (route) => {
    activationCalls++;
    return route.continue();
  });
  await page.getByRole("button", { name: "Agregar categoría", exact: true }).click();
  await configureRoundRobin(page);
  await setup.addCompetitors(["B Uno", "B Dos", "B Tres"]);
  await setup.startCategory();
  const bId = await categories.activeId();
  expect(bId).not.toBe(aId);
  await expect(page).toHaveURL(/\/standings$/);
  await expect(page.getByRole("button", { name: "Volver al combate" })).toBeVisible();
  const rejectedSync = await page.request.post("/api/ring/sync-fights", { data: {
    categoryId: bId, categoryName: "B", tournamentName: "Prueba", competitors: [], fights: [],
  } });
  expect(rejectedSync.status()).toBe(409);
  expect((await page.request.get(`/api/ring/queue?categoryId=${bId}`)).status()).toBe(404);
  const firstBIds = (await categories.progress()).fights.map((fight) => fight.id);
  await page.getByRole("link", { name: "Competidores" }).click();
  await setup.startCategoryButton.click();
  await expect(page.getByText("Hay una categoría activa")).toBeVisible();
  await page.getByRole("button", { name: "Continuar igual" }).click();
  await page.getByRole("button", { name: "Sí, borrar y empezar" }).click();
  await expect(page).toHaveURL(/\/standings$/);
  expect((await categories.progress()).fights.map((fight) => fight.id)).not.toEqual(firstBIds);
  expect((await page.request.get(`/api/ring/queue?categoryId=${bId}`)).status()).toBe(404);
  await page.goto("/fight");
  await expect(page.getByText("Combate no disponible en esta categoría")).toBeVisible();
  await page.getByRole("button", { name: "Volver al combate" }).click();
  await expect(categories.activeCategory).toHaveAttribute("data-active-category", aId);
  await expect(page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible();
  expect((await categories.progress()).fights.map((fight) => fight.id))
    .toEqual(aProgress.fights.map((fight) => fight.id));
  expect(activationCalls).toBe(0);

  await categories.select(bId);
  await page.evaluate((categoryId) => {
    const raw = localStorage.getItem("tkd-tournament-categories");
    if (!raw) throw new Error("Missing category registry");
    const registry = JSON.parse(raw);
    registry.categories[categoryId].fights = [];
    localStorage.setItem("tkd-tournament-categories", JSON.stringify(registry));
  }, aId);
  await page.reload();
  await expect(page.getByText("Recuperación pendiente.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Clasificación" })).toBeVisible();
});

test("an elimination bracket cannot be regenerated without the explicit restart warning", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("tkd-tournament");
    localStorage.removeItem("tkd-tournament-categories");
  });
  await page.reload();
  const setup = new SetupPage(page);
  await setup.goto();
  await configureRoundRobin(page);
  await page.getByRole("button", { name: "Eliminación", exact: true }).click();
  await setup.addCompetitors(["Rojo", "Azul"]);
  await setup.startCategory();
  const categories = new CategoriesPage(page);
  const original = await categories.progress();
  expect(original.fights).toHaveLength(0);
  expect(original.bracketMatches.length).toBeGreaterThan(0);
  await page.getByRole("link", { name: "Competidores" }).click();
  await setup.startCategoryButton.click();
  await expect(page.getByText("Hay una categoría activa")).toBeVisible();
  await page.getByRole("button", { name: "Cancelar" }).click();
  expect((await categories.progress()).bracketMatches).toEqual(original.bracketMatches);
});

test("a 409 during initial sync keeps the category in setup with its competitors", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("tkd-tournament");
    localStorage.removeItem("tkd-tournament-categories");
  });
  await page.reload();
  const setup = new SetupPage(page);
  await setup.goto();
  await configureRoundRobin(page);
  await setup.addCompetitors(["Uno", "Dos", "Tres"]);
  await page.route("**/api/ring/sync-fights", (route) => route.fulfill({
    status: 409, contentType: "application/json", body: JSON.stringify({ error: "active_match" }),
  }));
  await setup.startCategoryButton.click();
  await expect(page.getByText("active_match", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/:\d+\/$/);
  const progress = await new CategoriesPage(page).progress();
  expect(progress.phase).toBe("setup");
  expect(progress.fights).toHaveLength(0);
  expect(progress.competitors).toHaveLength(3);
});

test("missing server status permits edits but does not start a category", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("tkd-tournament");
    localStorage.removeItem("tkd-tournament-categories");
  });
  await page.reload();
  const setup = new SetupPage(page);
  await setup.goto();
  await configureRoundRobin(page);
  await setup.addCompetitors(["Uno", "Dos", "Tres"]);
  await page.route("**/api/ring/status", (route) => route.abort());
  await setup.startCategoryButton.click();
  await expect(page.getByText(/Sin respuesta del servidor/)).toBeVisible();
  const progress = await new CategoriesPage(page).progress();
  expect(progress.phase).toBe("setup");
  expect(progress.competitors).toHaveLength(3);
  expect(progress.fights).toHaveLength(0);
});
