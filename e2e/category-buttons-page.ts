import { expect, type Page, type Locator } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { CategoriesPage, type CategoryProgress } from "./categories-page";
export class CategoryButtonsPage {
  readonly setup: SetupPage;
  readonly categories: CategoriesPage;
  constructor(readonly page: Page) { this.setup = new SetupPage(page); this.categories = new CategoriesPage(page); }
  async configure(): Promise<void> {
    for (const label of ["ADULTOS (18-35)", "GUPS", "Blancos y Puntas Amarillas", "Liviano A", "Masculino", "Round Robin"])
      await expect(async () => {
        const option = this.page.getByRole("button", { name: label, exact: true });
        if (!(await option.isVisible())) await this.page.getByRole("button", { name: /Configurar categor/ }).click({ timeout: 1000 });
        await option.click({ timeout: 1000 });
      }).toPass({ timeout: 5000 });
  }
  async create(prefix = "A", add = false): Promise<CategoryProgress> {
    if (add) await this.page.getByRole("button", { name: /Agregar categor/ }).click();
    else await this.setup.goto();
    await this.configure();
    await this.setup.addCompetitors([`${prefix} Uno`, `${prefix} Dos`, `${prefix} Tres`]);
    await this.page.getByTestId("category-primary-action").click();
    await expect(this.page).toHaveURL(/\/standings$/);
    return this.categories.progress();
  }
  async competitors(): Promise<void> { await this.page.getByRole("link", { name: "Competidores", exact: true }).click(); }
  async restart(): Promise<Locator> {
    await this.competitors(); await this.page.getByTestId("restart-category").click();
    const dialog = this.page.getByRole("dialog", { name: /^Reiniciar / });
    await expect(dialog).toBeVisible(); return dialog;
  }
  async deletion(): Promise<Locator> {
    await this.competitors();
    await this.page.getByRole("button", { name: /^Eliminar categor/ }).click();
    const dialog = this.page.getByRole("dialog", { name: /^Eliminar .* definitivamente$/ });
    await expect(dialog).toBeVisible(); return dialog;
  }
  async lock(): Promise<unknown> {
    const response = await this.page.request.get("/api/ring/status");
    expect(response.ok()).toBe(true);
    const value: { activeMatchLock?: unknown } = await response.json();
    return value.activeMatchLock ?? null;
  }
  async loadAndStart(): Promise<void> {
    await this.page.getByRole("button", { name: "Ir a Combate", exact: true }).click();
    await this.page.getByRole("button", { name: "Cargar combate", exact: true }).click();
    await this.page.getByRole("button", { name: "Iniciar combate", exact: true }).click();
    await expect(this.page.getByRole("button", { name: "Pausar", exact: true })).toBeVisible();
  }
}
