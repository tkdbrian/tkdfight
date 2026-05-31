import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";

const HISTORY_CACHE_KEY = "tkd-historial-cache";

async function seedSparringRoundRobin(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
): Promise<void> {
  await page.request.post("/api/ring/full-reset");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());

  const setup = new SetupPage(page);
  await setup.goto();
  await setup.configureCategory({
    weight: "Liviano A",
    rank: "Blanco-P.Amarilla",
    gender: "M",
    discipline: "Sparring",
    mode: "Round Robin",
  });

  await setup.addCompetitors(["Recovery A", "Recovery B", "Recovery C", "Recovery D"]);
  await setup.startCategory();
}

test.describe("Exhaustivo — Recovery y resiliencia", () => {
  test("reload durante combate no rompe pantalla", async ({ page }) => {
    test.setTimeout(50_000);
    await seedSparringRoundRobin(page);

    const fightPage = new FightPage(page);
    await fightPage.loadFight();
    await fightPage.startFight();

    await expect(fightPage.endRoundButton).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(page.locator("body")).toBeVisible();
    await expect(page.getByRole("button", { name: /Cargar combate|Iniciar combate|Finalizar combate/i })).toBeVisible();
  });

  test("Historial usa caché offline si cae /api/history", async ({ page }) => {
    const cachedPayload = [
      {
        id: 9999,
        name: "Torneo Cache",
        category: "Cache Categoria",
        createdAt: new Date().toISOString(),
        isActive: false,
        fightsTotal: 1,
        fightsCompleted: 1,
        competitors: [
          { id: "c1", name: "Cache Rojo", team: null },
          { id: "c2", name: "Cache Azul", team: null },
        ],
        fights: [
          {
            id: "f1",
            completed: true,
            winner: "red",
            flagsRed: 3,
            flagsBlue: 1,
            groupId: null,
            redName: "Cache Rojo",
            redTeam: null,
            blueName: "Cache Azul",
            blueTeam: null,
          },
        ],
      },
    ];

    await page.addInitScript(([key, data]) => {
      localStorage.setItem(key, JSON.stringify(data));
    }, [HISTORY_CACHE_KEY, cachedPayload] as const);

    await page.route("**/api/history", (route) => route.abort());

    await page.goto("/history", { waitUntil: "domcontentloaded" });

    await expect(page.getByText(/Servidor no disponible/i)).toBeVisible();
    await expect(page.getByText("Cache Categoria")).toBeVisible();

    // Abrir detalle de la categoría cacheada para verificar que renderiza combates
    await page.getByText("Cache Categoria").first().click();
    await expect(page.getByText(/Combates \(1\)/i)).toBeVisible();
  });
});
