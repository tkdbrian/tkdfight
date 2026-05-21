import type { Page, Locator } from "@playwright/test";

export class SetupPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/");
    await this.page.waitForLoadState("networkidle");
    // When localStorage is cleared the app shows a welcome screen.
    // Click "Nuevo torneo" to proceed to the main setup view.
    const newTournamentBtn = this.page.getByRole("button", { name: "Nuevo torneo" });
    if (await newTournamentBtn.isVisible()) {
      await newTournamentBtn.click();
      // Wait until the welcome screen is dismissed (button disappears) — async fetch may run first
      await newTournamentBtn.waitFor({ state: "hidden", timeout: 8000 });
    }
  }

  /** Main setup heading (shows category name or "Sin categoría") */
  get heading(): Locator {
    return this.page.locator("h1").first();
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
    // Wait for the sidebar phase indicator to show "fighting".
    // This confirms setPhase("fighting") was called after the API fetch completed
    // and that Zustand persist saved the full tournament state to localStorage.
    await this.page
      .locator("span.capitalize")
      .filter({ hasText: "fighting" })
      .waitFor({ state: "visible", timeout: 10000 });
    // React Router's navigate("/fight") does not change the browser URL in Playwright
    // for this nested-Routes SPA. Navigate directly so the page rehydrates from localStorage.
    await this.page.goto("/fight", { waitUntil: "domcontentloaded" });
    // Wait for "Cargar combate" to confirm Zustand has hydrated fight data from localStorage.
    // (Zustand persist with localStorage may apply state asynchronously on first render.)
    await this.page
      .getByRole("button", { name: "Cargar combate", exact: true })
      .waitFor({ state: "visible", timeout: 10000 });
  }
}
