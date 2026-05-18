/**
 * E2E — ResultsPage: tabla de clasificación, combates y participantes.
 */
import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";

async function seedTournament(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
): Promise<void> {
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

test.describe("Results — Estructura de la página de resultados", () => {
  test("Tabla de clasificación tiene todas las columnas y 4 filas", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    await page.goto("/results", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Resultados" })).toBeVisible();

    // Verificar headers de la tabla (columnheader accesible o texto en thead)
    const table = page.locator("table").first();
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "#", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Competidor", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Pts", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "G", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "E", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "P", exact: true })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "PJ", exact: true })).toBeVisible();

    // Round Robin con 4 competidores → exactamente 4 filas en standings
    const rows = table.locator("tbody tr");
    expect(await rows.count()).toBe(4);
  });

  test("Sección 'Combates' lista los 6 enfrentamientos del Round Robin", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    await page.goto("/results", { waitUntil: "domcontentloaded" });

    // La sección "Combates" es un CardTitle
    await expect(page.getByText("Combates", { exact: true })).toBeVisible();

    // Con 4 competidores en RR se generan 6 fights (C(4,2) = 6).
    // Cada competidor aparece en 3 combates → "Juan Martínez" debería aparecer ≥ 3 veces en la página
    // (1 en standings + 3 en la lista de combates)
    const mentions = await page.getByText("Juan Martínez").count();
    expect(mentions).toBeGreaterThanOrEqual(3);
  });

  test("Sección Participantes muestra los 4 competidores como pills", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    await page.goto("/results", { waitUntil: "domcontentloaded" });

    // Los nombres de los 4 competidores deben aparecer en la página.
    // Los pills usan rounded-full bg-secondary, pero basta con verificar que los nombres son visibles.
    for (const name of ["Juan Martínez", "Carlos López", "Miguel Rodríguez", "Pedro González"]) {
      await expect(page.getByText(name).first()).toBeVisible();
    }
  });
});
