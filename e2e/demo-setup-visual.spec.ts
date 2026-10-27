import { expect, test } from "@playwright/test";

for (const width of [320, 390, 1280]) {
  test(`setup retains large controls, readable names and no overflow at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const noOverflow = async () => expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.goto("/demo/");
    await page.getByRole("button", { name: "Crear categoría" }).click();
    const age = page.getByRole("button", { name: /KIDS/ });
    await expect(age).toHaveCSS("min-height", "56px");
    if (width === 320) { await age.focus(); await page.keyboard.press("Enter"); }
    else await age.click();
    await expect(page.getByRole("heading", { name: /Sistema de grado/ })).toBeVisible();
    await noOverflow();
    await page.getByRole("button", { name: "No especificar", exact: true }).click();
    await page.getByRole("button", { name: "No especificar", exact: true }).click();
    await page.getByRole("button", { name: "Lucha" }).click();
    await page.getByRole("button", { name: "No especificar", exact: true }).click();
    await page.getByRole("button", { name: "Eliminación" }).click();
    await page.getByRole("button", { name: /Continuar con competidores/ }).click();
    const name = page.getByRole("textbox", { name: "Nombre del competidor" });
    await name.fill("Competidora Nombre y Apellido Extraordinariamente Largo");
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await expect(name).toHaveValue("");
    await name.fill("Segundo Competidor Nombre Extendido");
    await page.getByRole("button", { name: "Agregar", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Llave.*1 combates/ })).toBeVisible();
    await noOverflow();
    await context.close();
  });
}
