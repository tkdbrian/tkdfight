import type { Page, Locator } from "@playwright/test";

export class CentralPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/central");
    await this.page.waitForLoadState("networkidle");
  }

  /** Header h1 "Mesa Central" */
  get heading(): Locator {
    return this.page.getByRole("heading", { name: "Mesa Central" });
  }

  /** Input "IP del tatami" */
  get ipInput(): Locator {
    return this.page.getByPlaceholder("IP del tatami");
  }

  /** Input "Puerto" */
  get portInput(): Locator {
    return this.page.getByPlaceholder("Puerto");
  }

  /** Button with aria-label "Agregar tatami" (the "+" icon button) */
  get addButton(): Locator {
    return this.page.getByRole("button", { name: "Agregar tatami" });
  }

  /**
   * Add a tatami target by filling IP:port and clicking the + button.
   */
  async addTatami(ip: string, port: number): Promise<void> {
    await this.ipInput.fill(ip);
    await this.portInput.fill(String(port));
    await this.addButton.click();
  }

  /**
   * Returns the locator for a tatami card section that contains the given IP:port badge.
   * Cards render `{target.ip}:{target.port}` as a visible span.
   */
  getTatamiCard(ip: string, port: number): Locator {
    return this.page.locator(`text="${ip}:${port}"`).locator("..").locator("..");
  }

  /**
   * Returns the "Sin peleas pendientes" text locator inside the page.
   */
  get noPendingFightsText(): Locator {
    return this.page.getByText("Sin peleas pendientes");
  }

  /**
   * Waits for the queue endpoint to respond instead of using a fixed timeout.
   * This is triggered by: (a) initial load, (b) every 5s poll, (c) ring connect.
   */
  async waitForQueuePoll(): Promise<void> {
    await this.page.waitForResponse(
      (resp) => resp.url().includes("/api/ring/queue") && resp.status() === 200,
      { timeout: 15_000 },
    );
  }
}
