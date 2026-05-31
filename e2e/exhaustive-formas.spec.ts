import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";

async function seedTulCategory(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  mode: "Round Robin" | "Eliminación",
  competitorsCount: number,
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
    discipline: "Tul / Formas",
    mode,
  });

  const names = Array.from({ length: competitorsCount }, (_, i) => `Tul ${mode} ${i + 1}`);
  await setup.addCompetitors(names);
  await setup.startCategory();
}

test.describe("Exhaustivo — Formas / Tul", () => {
  for (const scenario of [
    { mode: "Round Robin" as const, competitorsCount: 4 },
    { mode: "Eliminación" as const, competitorsCount: 6 },
  ]) {
    test(`modo Tul ${scenario.mode} con ${scenario.competitorsCount} competidores`, async ({ page }) => {
      test.setTimeout(60_000);
      await seedTulCategory(page, scenario.mode, scenario.competitorsCount);

      if (scenario.mode === "Eliminación") {
        await page.goto("/bracket", { waitUntil: "domcontentloaded" });
        const generateBtn = page.getByRole("button", { name: /Generar bracket|Generar Grilla A \+ B/i });
        const startRoundBtn = page.getByRole("button", { name: "Iniciar ronda actual", exact: true });
        // Wait for page to render: either button proves React + Zustand have hydrated
        await generateBtn.or(startRoundBtn).first().waitFor({ state: "visible", timeout: 10_000 });
        // If bracket wasn't auto-generated, generate it now
        if (await generateBtn.isVisible()) {
          await generateBtn.click();
          await startRoundBtn.waitFor({ state: "visible", timeout: 5_000 });
        }
        await startRoundBtn.click();
        await page.goto("/fight", { waitUntil: "domcontentloaded" });
      }

      const fightPage = new FightPage(page);
      await expect(
        fightPage.fightInfo
          .or(page.getByRole("button", { name: "Cargar combate", exact: true }))
          .or(page.getByRole("button", { name: "Iniciar votación", exact: true }))
          .first(),
      ).toBeVisible();
      await fightPage.loadFight();

      await expect(page.getByRole("button", { name: "Iniciar votación", exact: true })).toBeVisible();
      await fightPage.startTulVoting();

      await expect(page.getByRole("button", { name: "Mesa decide", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Por juez", exact: true })).toBeVisible();

      await fightPage.switchToPorJuez();
      await fightPage.voteJudge(1, "blue");
      await fightPage.voteJudge(2, "blue");
      await fightPage.voteJudge(3, "red");
      await fightPage.voteJudge(4, "blue");
      await page.getByRole("button", { name: "Confirmar resultado", exact: true }).click();
      // Handle winner overlay shown after tul:finish
      const overlayBtn = page.getByRole("button", { name: "Confirmar resultado →", exact: true });
      await overlayBtn.waitFor({ state: "visible", timeout: 6_000 });
      await overlayBtn.click();
      // Handle result dialog
      await page.getByRole("button", { name: "Confirmar y continuar", exact: true }).click();

      await expect(
        page.getByRole("button", { name: "Siguiente pelea →", exact: true })
          .or(page.getByRole("button", { name: "Cargar combate", exact: true }))
          .or(page.getByRole("button", { name: "Iniciar votación", exact: true }))
          .first(),
      ).toBeVisible({ timeout: 8_000 });

      if (scenario.mode === "Eliminación") {
        await page.goto("/bracket", { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("heading", { name: "Bracket de Eliminación" })).toBeVisible();
      }
    });
  }
});
