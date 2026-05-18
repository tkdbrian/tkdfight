import type { Page, Locator } from "@playwright/test";

export class SetupPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/");
    await this.page.waitForLoadState("networkidle");
  }

  /** Heading "Competidores" */
  get heading(): Locator {
    return this.page.getByRole("heading", { name: "Competidores" });
  }

  /** Click a category button by the exact visible text */
  async selectCategoryOption(label: string): Promise<void> {
    const button = this.page.getByRole("button", { name: label, exact: true });
    await button.click();
    await this.page.waitForTimeout(200); // Small delay for UI update
  }

  /** Input field for competitor name */
  get competitorNameInput(): Locator {
    return this.page.getByPlaceholder("Nombre del competidor");
  }

  /** Button "Iniciar Categoría" */
  get startCategoryButton(): Locator {
    return this.page.getByRole("button", { name: "Iniciar Categoría" });
  }

  /** Count label showing number of competitors - find text node with number */
  async getCompetitorCount(): Promise<string> {
    const countText = await this.page.locator("text=/^\\d+$/").first().textContent();
    return countText || "0";
  }

  /** Add a competitor */
  async addCompetitor(name: string): Promise<void> {
    await this.competitorNameInput.fill(name);
    await this.competitorNameInput.press("Enter");
    // Wait for the competitor to appear
    await this.page.getByText(name).first().waitFor({ state: "visible", timeout: 5000 });
  }

  /** Configure category - simpler approach without strict mode issues */
  async configureCategory(options: {
    weight: string;
    rank: string;
    gender: "M" | "F";
    mode: "Round Robin" | "Eliminación";
  }): Promise<void> {
    // Select weight
    await this.selectCategoryOption(options.weight);
    // Select rank
    await this.selectCategoryOption(options.rank);
    // Select gender
    await this.selectCategoryOption(options.gender);
    // Select mode
    await this.selectCategoryOption(options.mode);
  }

  /** Start the category with competitors */
  async startCategory(): Promise<void> {
    await this.startCategoryButton.click();
    // Wait for navigation to fight page
    await this.page.waitForURL("/fight", { timeout: 10000 });
  }
}
