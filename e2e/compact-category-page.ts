import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Browser-level compact editor checks; the test fixture owns an isolated API and DB. */
export class CompactCategoryPage {
  constructor(readonly page: Page) {}

  get editor(): Locator { return this.page.locator("#category-editor"); }
  get competitorName(): Locator { return this.page.getByPlaceholder("Nombre del competidor"); }
  get continueButton(): Locator { return this.page.getByRole("button", { name: "Continuar con competidores" }); }
  get activeStep(): Locator { return this.page.getByTestId("guided-active-step"); }
  get review(): Locator { return this.page.getByTestId("guided-review"); }

  choice(label: string): Locator {
    return this.editor.getByRole("button", { name: label, exact: true });
  }

  async select(step: string, label: string): Promise<void> {
    await expect(this.activeStep).toContainText(step);
    await this.choice(label).click();
  }

  async skip(step: string): Promise<void> {
    await expect(this.activeStep).toContainText(step);
    await this.editor.getByRole("button", { name: `No especificar ${step}` }).click();
  }

  async edit(step: string): Promise<void> {
    await this.editor.getByRole("button", { name: new RegExp(`^Editar ${step}:`) }).click();
    await expect(this.activeStep).toContainText(step);
  }

  async openFreshTournament(): Promise<void> {
    await this.page.goto("/");
    const start = this.page.getByRole("button", { name: "Nuevo torneo" });
    await expect(start).toBeVisible();
    await start.click();
    await expect(this.editor).toBeVisible();
  }

  async assertViewportAndTargets(labels: string[], testInfo: TestInfo, shotName: string): Promise<void> {
    await expect(this.editor).toBeVisible();
    const dimensions = await this.page.evaluate(() => {
      const editor = document.getElementById("category-editor");
      if (!editor) throw new Error("Category editor is missing");
      const bounds = editor.getBoundingClientRect();
      return {
        viewport: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        editorLeft: bounds.left,
        editorRight: bounds.right,
      };
    });
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.editorLeft).toBeGreaterThanOrEqual(-1);
    expect(dimensions.editorRight).toBeLessThanOrEqual(dimensions.viewport + 1);
    for (const label of labels) {
      const target = this.choice(label);
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      expect(box, `${label} has a layout box`).not.toBeNull();
      if (!box) continue;
      expect(box.height, `${label} touch height`).toBeGreaterThanOrEqual(44);
      expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${label} right edge`).toBeLessThanOrEqual(dimensions.viewport + 1);
    }
    await this.capture(testInfo, shotName);
  }

  async capture(testInfo: TestInfo, shotName: string): Promise<void> {
    const screenshotDir = join(tmpdir(), "tkd-compact-category-smoke");
    mkdirSync(screenshotDir, { recursive: true });
    const screenshot = await this.page.screenshot({
      fullPage: true,
      path: join(screenshotDir, `${shotName}.png`),
    });
    await testInfo.attach(shotName, {
      body: screenshot,
      contentType: "image/png",
    });
  }

  async captureRegion(testInfo: TestInfo, shotName: string, region: Locator): Promise<void> {
    const screenshotDir = join(tmpdir(), "tkd-compact-category-smoke");
    mkdirSync(screenshotDir, { recursive: true });
    const screenshot = await region.screenshot({
      path: join(screenshotDir, `${shotName}.png`),
    });
    await testInfo.attach(shotName, {
      body: screenshot,
      contentType: "image/png",
    });
  }

  async continueToCompetitors(): Promise<void> {
    await expect(this.continueButton).toBeVisible();
    await this.continueButton.click();
    await expect(this.editor).toHaveCount(0);
    await expect(this.competitorName).toBeFocused();
  }
}
