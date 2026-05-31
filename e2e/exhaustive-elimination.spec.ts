import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";

function makeNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Elim Competidor ${i + 1}`);
}

async function seedElimination(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  competitorsCount: number,
): Promise<{ names: string[]; expectedFromPreview: number }> {
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
    mode: "Eliminación",
  });

  const names = makeNames(competitorsCount);
  await setup.addCompetitors(names);

  const previewText = (await page.getByText(/\d+ combates/i).first().textContent()) ?? "";
  const expectedFromPreview = Number((previewText.match(/(\d+)\s+combates/i) ?? ["", "0"])[1]);

  await setup.startCategory();
  return { names, expectedFromPreview };
}

test.describe("Exhaustivo — Eliminación", () => {
  for (const competitorsCount of [4, 5, 6, 7, 8]) {
    test(`eliminación con ${competitorsCount} competidores no rompe flujo y arma peleas`, async ({ page }) => {
      test.setTimeout(60_000);
      const { names, expectedFromPreview } = await seedElimination(page, competitorsCount);

      await page.goto("/bracket", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Bracket de Eliminación" })).toBeVisible();

      const generateBtn = page.getByRole("button", { name: /Generar bracket|Generar Grilla A \+ B/i });
      if (await generateBtn.isVisible()) {
        await generateBtn.click();
      }

      await expect(page.getByText(/combates completados|competidores activos|grilla a/i).first()).toBeVisible();
      await expect(page.getByText(names[0]).first()).toBeVisible();

      // En eliminación, el queue puede estar vacío hasta iniciar la ronda desde Bracket.
      const startRoundBtn = page.getByRole("button", { name: "Iniciar ronda actual", exact: true });
      if (await startRoundBtn.isVisible()) {
        await startRoundBtn.click();
      }

      await page.goto("/fight", { waitUntil: "domcontentloaded" });
      const fightPage = new FightPage(page);
      await expect(
        fightPage.loadFightButton
          .or(page.getByRole("button", { name: "Iniciar combate", exact: true }))
          .or(page.getByRole("button", { name: "Iniciar votación", exact: true })),
      ).toBeVisible();

      // Verificación final del queue después de iniciar ronda
      const queueRes = await page.request.get("/api/ring/queue");
      expect(queueRes.ok()).toBe(true);
      const queue = (await queueRes.json()) as unknown[];
      expect(queue.length).toBeGreaterThanOrEqual(1);
      if (expectedFromPreview > 0) {
        expect(queue.length).toBeLessThanOrEqual(expectedFromPreview);
      }
    });
  }
});
