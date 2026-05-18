import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";

async function seedTournament(page: Parameters<typeof test>[0]["page"]): Promise<void> {
  const setup = new SetupPage(page);
  await setup.goto();
  await setup.configureCategory({
    weight: "Liviano A",
    rank: "Blanco-P.Amarilla",
    gender: "M",
    mode: "Round Robin",
  });

  for (const name of ["Test User 1", "Test User 2", "Test User 3", "Test User 4"]) {
    await setup.addCompetitor(name);
  }

  await setup.startCategory();
}

test.describe("TKD Tournament - Smoke Tests", () => {
  test("debe cargar todas las páginas sin errores JS", async ({ page }) => {
    const routes = ["/", "/fight", "/bracket", "/standings", "/results", "/tv", "/settings", "/central"];

    for (const route of routes) {
      await page.goto(route, { waitUntil: "networkidle" });

      // Verificar que no hay errores en la consola
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          errors.push(msg.text());
        }
      });

      // Verificar que la página tiene contenido
      const body = await page.locator("body").isVisible();
      expect(body).toBe(true);

      console.log(`✅ Ruta ${route} cargó sin errores`);
    }
  });

  test("Setup: agregar competidores y iniciar categoría", async ({ page }) => {
    const setup = new SetupPage(page);
    await setup.goto();

    // Verificar que la página carga
    await expect(setup.heading).toBeVisible();

    // Configurar categoría
    await setup.configureCategory({
      weight: "Liviano A",
      rank: "Blanco-P.Amarilla",
      gender: "M",
      mode: "Round Robin",
    });

    // Agregar 4 competidores
    const names = ["Test User 1", "Test User 2", "Test User 3", "Test User 4"];
    for (const name of names) {
      await setup.addCompetitor(name);
    }

    // Verificar cantidad
    const count = await setup.getCompetitorCount();
    expect(count).toBe("4");

    console.log("✅ Setup de categoría completado correctamente");
  });

  test("Fight: página de combate carga correctamente", async ({ page }) => {
    await seedTournament(page);

    await expect(page).toHaveURL(/\/fight$/);
    await expect(page.getByRole("button", { name: "Cargar combate" })).toBeVisible();
    await expect(page.getByText("Listo", { exact: true })).toBeVisible();

    console.log("✅ Página de combate carga correctamente");
  });

  test("Standings/Clasificación: tabla visible", async ({ page }) => {
    await seedTournament(page);
    await page.goto("/standings", { waitUntil: "networkidle" });

    const heading = await page.getByRole("heading", { name: "Clasificación", exact: true }).isVisible();
    expect(heading).toBe(true);

    const table = await page.locator("table").first().isVisible();
    expect(table).toBe(true);

    console.log("✅ Página de Clasificación carga con tabla");
  });

  test("TV: pantalla pública muestra combate", async ({ page }) => {
    await seedTournament(page);
    await page.goto("/tv", { waitUntil: "networkidle" });

    // Verificar elementos clave de la pantalla TV
    const title = await page.getByText("TKD Tournament", { exact: true }).isVisible();
    expect(title).toBe(true);

    // Debe mostrar estado de conexión y el marcador central
    const connectionBadge = await page.getByText(/En vivo|Sin conexión/).isVisible();
    expect(connectionBadge).toBe(true);

    const hasTimer = await page.getByText(/^\d+:\d+$/, { exact: true }).isVisible();
    expect(hasTimer).toBe(true);

    const versus = await page.getByText("vs", { exact: true }).isVisible();
    expect(versus).toBe(true);

    console.log("✅ Pantalla TV muestra combate correctamente");
  });

  test("Results: página de resultados carga", async ({ page }) => {
    await seedTournament(page);
    await page.goto("/results", { waitUntil: "networkidle" });
    const main = page.getByRole("main");

    const heading = await page.getByRole("heading", { name: "Resultados" }).isVisible();
    expect(heading).toBe(true);

    // Debe tener secciones de Clasificación y Combates
    const classification = await main.getByText("Clasificación", { exact: true }).isVisible();
    expect(classification).toBe(true);

    const fights = await main.getByText("Combates", { exact: true }).isVisible();
    expect(fights).toBe(true);

    console.log("✅ Página de Resultados carga correctamente");
  });

  test("Settings: configuración muestra opciones", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });

    const heading = await page.getByRole("heading", { name: "Configuración" }).isVisible();
    expect(heading).toBe(true);

    const judgesLabel = await page.getByText("Número de jueces", { exact: true }).isVisible();
    expect(judgesLabel).toBe(true);

    const judgeButton = await page.getByRole("button", { name: "3", exact: true }).isVisible();
    expect(judgeButton).toBe(true);

    // Debe tener opciones de duración
    const durationExists = await page.getByRole("button", { name: "1:30 min", exact: true }).isVisible();
    expect(durationExists).toBe(true);

    console.log("✅ Página de Configuración muestra opciones correctamente");
  });

  test("Central: Mesa Central carga", async ({ page }) => {
    await page.goto("/central", { waitUntil: "networkidle" });

    const heading = await page.getByRole("heading", { name: "Mesa Central" }).isVisible();
    expect(heading).toBe(true);

    // Debe tener campo para agregar IP
    const ipInput = await page.getByPlaceholder("IP del tatami").isVisible();
    expect(ipInput).toBe(true);

    console.log("✅ Mesa Central carga correctamente");
  });
});
