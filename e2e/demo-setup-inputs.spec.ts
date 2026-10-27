import { expect, test } from "@playwright/test";

test("rapid category/chief typing, paste and clear-to-120 survive an IndexedDB reload", async ({ page }) => {
  await page.goto("/demo/");
  await page.getByRole("button", { name: "Crear categoría" }).click();
  await page.getByRole("button", { name: "No especificar", exact: true }).click(); // edad
  await page.getByRole("button", { name: "No especificar", exact: true }).click(); // grado
  await page.getByRole("button", { name: "No especificar", exact: true }).click(); // género
  await page.getByRole("button", { name: "Lucha" }).click();
  await page.getByRole("button", { name: "No especificar", exact: true }).click(); // peso
  await page.getByRole("button", { name: "Eliminación" }).click();
  const title = page.getByRole("textbox", { name: "Nombre de la categoría" });
  await title.fill("");
  await title.pressSequentially("Categoría extensa y completa", { delay: 1 });
  await expect(title).toHaveValue("Categoría extensa y completa");
  await title.fill("Importada · TUL 35 KG"); // paste-like single input event
  await expect(title).toHaveValue("Importada · TUL 35 KG");
  await page.getByText("Mesa (opcional)").click();
  const chief = page.getByRole("textbox", { name: "Jefe de mesa" });
  await chief.fill("");
  await chief.pressSequentially("Brian Lipnjak", { delay: 1 });
  await expect(chief).toHaveValue("Brian Lipnjak");
  await page.getByText("Ajustes avanzados: tiempos y perfil").click();
  const duration = page.getByRole("spinbutton", { name: "Segundos por round" });
  await expect(duration).toHaveValue("60");
  await duration.fill("");
  await duration.pressSequentially("120", { delay: 1 });
  await expect(duration).toHaveValue("120");
  await duration.blur();
  await expect.poll(async () => page.getByRole("textbox", { name: "Nombre de la categoría" }).inputValue())
    .toBe("Importada · TUL 35 KG");
  await page.waitForTimeout(500); // allow the debounced IDB writes to settle before closing the page

  await page.reload();
  await page.getByRole("button", { name: "Editar categoría" }).click();
  await expect(page.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Importada · TUL 35 KG");
  await page.getByText("Mesa (opcional)").click();
  await expect(page.getByRole("textbox", { name: "Jefe de mesa" })).toHaveValue("Brian Lipnjak");
  await page.getByText("Ajustes avanzados: tiempos y perfil").click();
  await expect(page.getByRole("spinbutton", { name: "Segundos por round" })).toHaveValue("120");

  // Do not blur or wait: an input event must begin persistence before navigation.
  await page.getByRole("textbox", { name: "Nombre de la categoría" }).fill("Nombre inmediato sin blur");
  await page.reload();
  await page.getByRole("button", { name: "Editar categoría" }).click();
  await expect(page.getByRole("textbox", { name: "Nombre de la categoría" })).toHaveValue("Nombre inmediato sin blur");
  await page.getByText("Mesa (opcional)").click();
  await page.getByRole("textbox", { name: "Jefe de mesa" }).fill("Mesa inmediata sin blur");
  await page.reload();
  await page.getByRole("button", { name: "Editar categoría" }).click();
  await page.getByText("Mesa (opcional)").click();
  await expect(page.getByRole("textbox", { name: "Jefe de mesa" })).toHaveValue("Mesa inmediata sin blur");
  await page.getByText("Ajustes avanzados: tiempos y perfil").click();
  await page.getByRole("spinbutton", { name: "Segundos por round" }).fill("121");
  await page.reload();
  await page.getByRole("button", { name: "Editar categoría" }).click();
  await page.getByText("Ajustes avanzados: tiempos y perfil").click();
  await expect(page.getByRole("spinbutton", { name: "Segundos por round" })).toHaveValue("121");
});
