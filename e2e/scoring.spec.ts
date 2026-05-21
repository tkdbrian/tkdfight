/**
 * E2E — Scoring: fases, puntaje y votos de jueces en FightPage.
 */
import { test, expect } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { FightPage } from "./fight-page";

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

test.describe("Scoring — Puntaje y fases del combate", () => {
  test("La fase pasa de 'Listo' a 'Ronda' al iniciar combate", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    const fightPage = new FightPage(page);
    await fightPage.loadFight();

    // Fase inicial: "Listo"
    await expect(page.getByText("Listo").first()).toBeVisible();

    // Iniciar: fase cambia a "Ronda" (badge puede decir "Ronda · R1")
    await fightPage.startFight();
    await expect(page.getByText(/Ronda/).first()).toBeVisible();
  });

  test("Los marcadores empiezan en 0 y se actualizan tras los votos de jueces", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    const fightPage = new FightPage(page);
    await fightPage.loadFight();
    await fightPage.startFight();

    // Marcadores iniciales: ambos en 0
    await expect(fightPage.redScore).toHaveText("0");
    await expect(fightPage.blueScore).toHaveText("0");

    // 3 jueces votan rojo, 1 azul
    await fightPage.voteJudge(1, "red");
    await fightPage.voteJudge(2, "red");
    await fightPage.voteJudge(3, "red");
    await fightPage.voteJudge(4, "blue");

    // Playwright reintenta automáticamente hasta que Socket.IO actualiza el DOM
    await expect(fightPage.redScore).not.toHaveText("0");
    await expect(fightPage.blueScore).not.toHaveText("0");
  });

  test("Finalizar combate oculta el botón 'Finalizar combate'", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    const fightPage = new FightPage(page);
    await fightPage.loadFight();
    await fightPage.startFight();

    // Botón visible mientras corre el round
    await expect(fightPage.endRoundButton).toBeVisible();

    // Finalizar — transiciona a Descanso, R2 o Terminado según configuración
    await fightPage.endRound();

    await expect(fightPage.endRoundButton).not.toBeVisible({ timeout: 6_000 });
  });

  test("Los 4 jueces (judgesCount=4) tienen los 3 botones de voto visibles", async ({ page }) => {
    test.setTimeout(30_000);
    await seedTournament(page);

    const fightPage = new FightPage(page);
    await fightPage.loadFight();
    await fightPage.startFight();

    // Cambiar a tab "Por juez" para que los paneles FlagVoteRow estén en el DOM
    await fightPage.switchToPorJuez();

    // Con judgesCount=4 (default), los 4 paneles Jn deben ser visibles
    for (const j of [1, 2, 3, 4]) {
      await expect(
        page
          .locator("[class*='bg-secondary']")
          .filter({ has: page.getByText(`J${j}`, { exact: true }) }),
      ).toBeVisible();
    }

    // J1 tiene exactamente los 3 botones de voto
    await expect(fightPage.getJudgeVoteButton(1, "red")).toBeVisible();
    await expect(fightPage.getJudgeVoteButton(1, "blue")).toBeVisible();
    await expect(fightPage.getJudgeVoteButton(1, "draw")).toBeVisible();
  });
});
