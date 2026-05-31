import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";

/**
 * Seeds a Round Robin tournament with 4 competitors and navigates to /fight.
 * Clears localStorage first to avoid state leakage between tests.
 */
async function seedTournament(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
): Promise<void> {
  // Navegar al inicio antes de limpiar — localStorage no es accesible en about:blank
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  const setup = new SetupPage(page);
  await setup.goto();
  await setup.configureCategory({
    weight: "Liviano A",
    rank: "Blanco-P.Amarilla",
    gender: "M",
    mode: "Round Robin",
  });
  for (const name of ["Juan Martínez", "Carlos López", "Miguel Rodríguez", "Pedro González"]) {
    await setup.addCompetitor(name);
  }
  await setup.startCategory();
}

test.describe("TKD Tournament - Flujo Completo", () => {
  test("Fight: cargar combate muestra controles y fase 'Listo'", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    const fightPage = new FightPage(page);

    // Verificar que estamos en /fight con un combate disponible
    await expect(fightPage.fightInfo).toBeVisible();
    await expect(fightPage.loadFightButton).toBeVisible();

    // Cargar el combate
    await fightPage.loadFight();

    // Verificar controles de inicio y fase inicial
    await expect(fightPage.startFightButton).toBeVisible();
    await expect(page.getByText("Listo").first()).toBeVisible();
  });

  test("Fight: iniciar combate activa timer y votación de jueces", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    const fightPage = new FightPage(page);
    await fightPage.loadFight();
    await fightPage.startFight();

    // Timer debe mostrar tiempo en formato mm:ss
    const timerText = await fightPage.timer.textContent();
    expect(timerText).toMatch(/\d+:\d+/);

    // Jueces 1-4 pueden votar (default judgesCount = 4)
    await fightPage.voteJudge(1, "red");
    await fightPage.voteJudge(2, "blue");
    await fightPage.voteJudge(3, "red");
    await fightPage.voteJudge(4, "red");

    // El timer sigue corriendo tras los votos
    await expect(fightPage.timer).toBeVisible();
  });

  test("Standings: tabla de clasificación muestra los 4 competidores", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    await page.goto("/standings", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Clasificación" })).toBeVisible();
    await expect(page.locator("table").first()).toBeVisible();

    const rows = page.locator("table tbody tr");
    expect(await rows.count()).toBeGreaterThanOrEqual(4);
  });

  test("TV: pantalla pública muestra título y timer", async ({ page }) => {
    // La TV no requiere torneo activo — verifica que la página carga correctamente
    await page.goto("/tv", { waitUntil: "domcontentloaded" });

    // El texto en el DOM es "TKD Tournament" (el CSS uppercase lo muestra en mayúsculas visualmente)
    await expect(page.getByText("TKD Tournament", { exact: true })).toBeVisible();

    // Timer central usando la clase real del componente
    await expect(
      page.locator(".font-mono.font-black").filter({ hasText: /\d+:\d+/ }).first(),
    ).toBeVisible();

    // Separador "vs" entre los competidores
    await expect(page.getByText("vs", { exact: true })).toBeVisible();
  });

  test("Settings: opciones de jueces y duración son correctas", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Configuración" })).toBeVisible();
    await expect(page.getByText("Jueces", { exact: true })).toBeVisible();

    // exact: true evita strict mode violation ("1" no debe coincidir con "1 min", "1 round", etc.)
    for (const count of ["1", "3", "4", "5"]) {
      await expect(page.getByRole("button", { name: count, exact: true }).first()).toBeVisible();
    }

    // "1:30" es el label real del botón de duración
    await expect(page.getByRole("button", { name: "1:30", exact: true })).toBeVisible();
  });
});
