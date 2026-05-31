import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";

function makeNames(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

async function clearState(page: Parameters<Parameters<typeof test>[1]>[0]["page"]): Promise<void> {
  await page.request.post("/api/ring/full-reset");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
}

test.describe("Exhaustivo — Round Robin", () => {
  for (const discipline of ["Sparring", "Tul / Formas"] as const) {
    for (const competitorsCount of [3, 4, 5, 6]) {
      test(`${discipline} con ${competitorsCount} competidores genera fixture correcto`, async ({ page }) => {
        test.setTimeout(45_000);
        await clearState(page);

        const setup = new SetupPage(page);
        await setup.goto();
        await setup.configureCategory({
          weight: "Liviano A",
          rank: "Blanco-P.Amarilla",
          gender: "M",
          discipline,
          mode: "Round Robin",
        });

        const names = makeNames(competitorsCount, `${discipline} RR`);
        await setup.addCompetitors(names);

        const previewText = (await page.getByText(/\d+ combates/i).first().textContent()) ?? "";
        const previewMatch = /(\d+)\s+combates/i.exec(previewText);
        const expectedFromPreview = Number(previewMatch?.[1] ?? "0");
        expect(expectedFromPreview).toBeGreaterThan(0);

        await setup.startCategory();

        const queueRes = await page.request.get("/api/ring/queue");
        expect(queueRes.ok()).toBe(true);
        const queue = (await queueRes.json()) as unknown[];
        expect(queue.length).toBe(expectedFromPreview);

        const fightPage = new FightPage(page);
        await expect(
          fightPage.loadFightButton
            .or(page.getByRole("button", { name: "Iniciar combate", exact: true }))
            .or(page.getByRole("button", { name: "Iniciar votación", exact: true })),
        ).toBeVisible();

        await fightPage.loadFight();

        if (discipline === "Sparring") {
          await fightPage.startFight();
          await fightPage.voteJudge(1, "red");
          await fightPage.voteJudge(2, "blue");
          await fightPage.voteJudge(3, "red");
          await fightPage.voteJudge(4, "red");
          await fightPage.endRound();
        } else {
          await fightPage.startTulVoting();
          await fightPage.switchToPorJuez();
          await fightPage.voteJudge(1, "red");
          await fightPage.voteJudge(2, "red");
          await fightPage.voteJudge(3, "blue");
          await fightPage.voteJudge(4, "red");
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
        }
      });
    }
  }
});
