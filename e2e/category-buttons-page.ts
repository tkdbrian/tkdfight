import { expect, type Page, type Locator } from "@playwright/test";
import { SetupPage } from "./setup-page";
import { CategoriesPage, type CategoryProgress } from "./categories-page";
export class CategoryButtonsPage {
  readonly setup: SetupPage;
  readonly categories: CategoriesPage;
  constructor(readonly page: Page) { this.setup = new SetupPage(page); this.categories = new CategoriesPage(page); }
  async configure(): Promise<void> {
    const editor = this.page.locator("#category-editor");
    await expect(editor).toBeVisible();
    const choices: [string, string][] = [
      ["Edad", "ADULTOS (18-35)"],
      ["Sistema de grado", "GUPS"],
      ["Rango GUP", "Blancos y Puntas Amarillas"],
      ["Género", "Masculino"],
      ["Disciplina", "Sparring"],
      ["Peso", "Liviano A"],
      ["Formato", "Round Robin"],
    ];
    for (const [step, label] of choices) {
      await expect(this.page.getByTestId("guided-active-step")).toContainText(step);
      await editor.getByRole("button", { name: label, exact: true }).click();
    }
    await expect(this.page.getByTestId("guided-review")).toBeVisible();
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
