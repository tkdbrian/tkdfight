import { expect, test } from "@playwright/test";

for (const width of [320, 390, 1280]) {
  test(`setup retains large controls, readable names and no overflow at ${width}px`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const noOverflow = async () => expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.goto("/demo/");
    await page.getByRole("button", { name: "Crear categoría" }).click();
    const age = page.getByRole("button", { name: /KIDS/ });
    await expect(age).toHaveCSS("min-height", "44px");
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

test("starts a Tul category and opens a fresh setup without changing the first fixture", async ({ page }) => {
  await page.goto("/demo/");
  await page.getByRole("button", { name: "Crear categoría" }).click();
  await page.getByRole("button", { name: "No especificar", exact: true }).click();
  await page.getByRole("button", { name: "No especificar", exact: true }).click();
  await page.getByRole("button", { name: "No especificar", exact: true }).click();
  await page.getByRole("button", { name: "Tul / Formas" }).click();
  await page.getByRole("button", { name: "Eliminación" }).click();
  await page.getByRole("button", { name: /Continuar con competidores/ }).click();
  await page.getByRole("button", { name: /Configurar categoría/ }).click();
  await page.getByRole("textbox", { name: "Nombre de la categoría" }).fill("Formas de prueba");
  const name = page.getByRole("textbox", { name: "Nombre del competidor" });
  await name.fill("Ana");
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(name).toHaveValue("");
  await name.fill("Beto");
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Llave.*1 combates/ })).toBeVisible();
  await page.getByRole("button", { name: "Iniciar categoría" }).click();
  await page.getByRole("button", { name: "Competidores", exact: true }).click();
  await page.getByRole("button", { name: "Agregar categoría" }).click();
  await expect(page.getByRole("heading", { name: /Paso 1 de 6: Edad/ })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Categorías" }).getByRole("tab")).toHaveCount(2);
  await page.getByRole("tablist", { name: "Categorías" }).getByRole("tab").first().click();
  await expect(page.getByRole("heading", { name: /Llave.*1 combates/ })).toBeVisible();
  await expect(page.getByText("Ana", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Beto", { exact: true }).first()).toBeVisible();
});

test("category tabs never carry an add or edit competitor draft into another category", async ({ page }) => {
  await page.goto("/demo/");
  await page.getByRole("button", { name: "Crear categoría" }).click();
  const name = page.getByRole("textbox", { name: "Nombre del competidor" });
  await name.fill("Ana");
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(name).toHaveValue("");
  await name.fill("Borrador sólo de A");
  await page.getByRole("button", { name: "Agregar categoría" }).click();
  await expect(page.getByRole("tablist", { name: "Categorías" }).getByRole("tab")).toHaveCount(2);
  await expect(name).toHaveValue("");
  await expect(page.getByRole("button", { name: "Agregar", exact: true })).toBeDisabled();
  await name.fill("Beto");
  await page.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(name).toHaveValue("");
  const tabs = page.getByRole("tablist", { name: "Categorías" }).getByRole("tab");
  await tabs.first().click();
  await expect(name).toHaveValue("");
  await page.getByRole("button", { name: "Editar a Ana" }).click();
  await expect(name).toHaveValue("Ana");
  await tabs.last().click();
  await expect(name).toHaveValue("");
  await expect(page.getByRole("button", { name: "Agregar", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancelar edición" })).toHaveCount(0);
  await expect(page.getByText("Beto", { exact: true }).first()).toBeVisible();
});
