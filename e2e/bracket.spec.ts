/**
 * E2E — Bracket de Eliminación: generación y estructura de la grilla.
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

/** Configures elimination mode with 4 competitors but does NOT click "Iniciar Categoría".
 * This leaves bracketMatches=[] so BracketPage renders the "Generar bracket" button. */
async function configureElimination(
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
    mode: "Eliminación",
  });
  for (const name of ["Juan Martínez", "Carlos López", "Miguel Rodríguez", "Pedro González"]) {
    await setup.addCompetitor(name);
  }
  // Do NOT call startCategory(). bracketMatches stays empty →
  // BracketPage will show "Generar bracket" instead of "Regenerar".
}

test.describe("Bracket — Generación y estructura", () => {
  test("Sin modo eliminación, BracketPage muestra aviso informativo", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    await page.goto("/bracket", { waitUntil: "domcontentloaded" });

    // BracketPage renderiza un aviso cuando el modo no es eliminación
    await expect(page.getByText(/solo está disponible en modo/)).toBeVisible();
  });

  test("Con modo eliminación, BracketPage muestra heading y botón 'Generar bracket'", async ({ page }) => {
    test.setTimeout(30_000);
    await configureElimination(page);

    await page.goto("/bracket", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Bracket de Eliminación" })).toBeVisible();
    // bracketMatches === 0 → button "Generar bracket" is rendered
    await expect(
      page.getByRole("button", { name: "Generar bracket", exact: true }),
    ).toBeVisible();
  });

  test("Generar bracket crea los slots y muestra nombres de competidores", async ({ page }) => {
    test.setTimeout(30_000);
    await configureElimination(page);

    await page.goto("/bracket", { waitUntil: "domcontentloaded" });

    // Generar el bracket — handleGenerateBracket() is synchronous
    await page.getByRole("button", { name: "Generar bracket", exact: true }).click();

    // Stats strip cambia a "competidores activos" tras la generación
    await expect(page.getByText(/competidores activos/)).toBeVisible();

    // Al menos un nombre de competidor aparece en los slots de la grilla
    await expect(page.getByText("Juan Martínez").first()).toBeVisible();
  });
});
