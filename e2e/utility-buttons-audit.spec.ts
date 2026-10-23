import { expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { test } from "./isolated-test";
import { CategoryButtonsPage } from "./category-buttons-page";
import { FightPage } from "./fight-page";

class UtilityButtonsPage {
  constructor(readonly page: Page) {}
  async finishRed(): Promise<void> {
    const fight = new FightPage(this.page);
    await fight.loadFight(); await fight.startFight(); await fight.endRound();
    const penalties = this.page.getByRole("button", { name: "Confirmar penalizaciones", exact: true });
    if (await penalties.isVisible()) await penalties.click();
    for (const judge of [1, 2, 3, 4]) await fight.voteJudge(judge, "red");
    await this.page.getByRole("button", { name: /Confirmar.*Rojo gana el round/ }).click();
    const overlay = this.page.getByRole("dialog", { name: "Resultado del combate", exact: true });
    await expect(overlay).toBeVisible();
    await overlay.getByRole("button", { name: "Confirmar resultado →", exact: true }).click();
    const dialog = this.page.getByRole("dialog", { name: "Registrar resultado del combate", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Confirmar y continuar", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  async download(label: string): Promise<{ name: string; content: string }> {
    const event = this.page.waitForEvent("download");
    await this.page.getByRole("button", { name: label, exact: true }).click();
    const download = await event; const path = await download.path();
    if (!path) throw new Error(`Missing downloaded file for ${label}`);
    return { name: download.suggestedFilename(), content: await readFile(path, "utf8") };
  }
}

test("utility buttons: actual CSV HTML downloads and confirmed print preview detail/back", async ({ page }, info) => {
  const setup = new CategoryButtonsPage(page); const utilities = new UtilityButtonsPage(page);
  await setup.create('Utilidad "Sur",');
  await page.getByRole("button", { name: "Ir a Combate", exact: true }).click();
  for (let index = 0; index < 3; index++) await utilities.finishRed();
  await page.getByRole("link", { name: "Clasificación", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exportar CSV", exact: true })).toBeEnabled();
  const csv = await utilities.download("Exportar CSV");
  expect(csv.name).toMatch(/\.csv$/); expect(csv.content).toContain("Llave,Pos,Nombre,Equipo");
  expect(csv.content).toContain('"Utilidad ""Sur"", Uno"');
  await info.attach("actual-csv-download", { body: csv.content, contentType: "text/csv" });
  await page.getByRole("link", { name: "Resultados", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exportar HTML", exact: true })).toBeEnabled();
  const html = await utilities.download("Exportar HTML");
  expect(html.name).toMatch(/\.html$/); expect(html.content).toContain("Utilidad");
  await info.attach("actual-html-download", { body: html.content, contentType: "text/html" });
  const before = await page.evaluate(() => localStorage.getItem("tkd-tournament"));
  await page.getByRole("button", { name: "Imprimir categoría", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "Vista previa de impresión", exact: true });
  await expect(preview).toBeVisible();
  const detail = preview.getByRole("checkbox", { name: "Incluir detalle de combates", exact: true });
  await expect(detail).not.toBeChecked(); await detail.check(); await expect(detail).toBeChecked();
  await detail.uncheck(); await expect(detail).not.toBeChecked();
  await preview.getByRole("button", { name: "Volver", exact: true }).click();
  await expect(preview).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("tkd-tournament"))).toBe(before);
  await setup.competitors();
  await expect(page.getByRole("button", { name: /^Eliminar categor/ })).toBeVisible();
  await expect(page.getByText(/M.s acciones de categor/)).toHaveCount(0);
  const deletion = await setup.deletion();
  await deletion.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(deletion).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("tkd-tournament"))).toBe(before);
});
