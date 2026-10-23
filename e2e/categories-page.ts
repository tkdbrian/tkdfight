import { expect, type Locator, type Page } from "@playwright/test";
import { SetupPage } from "./setup-page";

export interface CategoryProgress {
  phase: string;
  config: { id: string; categoryName: string; matchType: string; mode: string };
  competitors: Array<{ id: string; name: string }>;
  groups: unknown[];
  currentFightIndex: number;
  bracketMatches: unknown[];
  bracketSeeds: Array<string | null>;
  setupStarted: boolean;
  fights: Array<{
    id: string;
    completed: boolean;
    winner?: "red" | "blue" | "draw";
    flagsRed?: number;
    flagsBlue?: number;
    red: { id: string; name: string };
    blue: { id: string; name: string };
  }>;
}

export interface CategoryQueueEntry {
  fight: {
    id: string;
    categoryId: string;
    red: { id: string; tournament_id: number };
    blue: { id: string; tournament_id: number };
  };
}

export interface CategoryHistory {
  id: number;
  fights: Array<{ id: string; completed: boolean; winner: string | null }>;
  competitors: Array<{ id: string; name: string }>;
}

/** Category operations and the current Tul controls; no production state is injected. */
export class CategoriesPage {
  constructor(readonly page: Page) {}

  get activeCategory(): Locator {
    return this.page.locator("[data-active-category]");
  }

  tab(categoryId: string): Locator {
    return this.page.locator(`[id="category-tab-${categoryId}"]`);
  }

  async activeId(): Promise<string> {
    await expect(this.activeCategory).toHaveAttribute("data-active-category", /.+/);
    const id = await this.activeCategory.getAttribute("data-active-category");
    if (!id) throw new Error("The active category has no stable ID");
    return id;
  }

  async createTulRoundRobin(names: string[], addCategory = false): Promise<string> {
    if (addCategory) {
      await this.page.getByRole("button", { name: "Agregar categoría", exact: true }).click();
      await expect(this.page.getByRole("tab", { name: "Nueva categoría" })).toBeVisible();
    } else {
      await new SetupPage(this.page).goto();
    }
    const setup = new SetupPage(this.page);
    for (const option of ["ADULTOS (18-35)", "GUPS", "Blancos y Puntas Amarillas", "Liviano A", "M", "Tul / Formas", "Round Robin"]) {
      await setup.selectCategoryOption(option);
    }
    await setup.addCompetitors(names);
    await setup.startCategory();
    if (new URL(this.page.url()).pathname.endsWith("/standings")) await this.page.getByRole("button", { name: "Ir a Combate", exact: true }).click();
    await expect(this.page.getByRole("button", { name: "Iniciar competencia", exact: true }))
      .toBeVisible();
    return this.activeId();
  }

  async confirmCurrentTul(winner: "red" | "blue"): Promise<void> {
    await this.page.getByRole("button", { name: "Iniciar competencia", exact: true }).click();
    const startVoting = this.page.getByRole("button", { name: "Iniciar votación", exact: true });
    await expect(startVoting).toBeVisible();
    await startVoting.click();
    await this.page.getByRole("button", { name: "Por juez", exact: true }).click();
    for (let judge = 1; judge <= 4; judge++) {
      const row = this.page.locator("[class*='bg-secondary']")
        .filter({ has: this.page.getByText(`J${judge}`, { exact: true }) });
      await row.getByRole("button", { name: winner === "red" ? "🔴 Rojo" : "🔵 Azul" })
        .first().click();
    }
    await expect(this.page.locator("#tour-timer")
      .getByText("4 / 4 jueces votaron", { exact: true })).toBeVisible();
    await this.page.getByRole("button", { name: "Confirmar resultado", exact: true }).click();
    const overlayConfirm = this.page.getByRole("button", { name: "Confirmar resultado →", exact: true });
    await expect(overlayConfirm).toBeVisible();
    await overlayConfirm.click();
    const dialog = this.page.getByRole("dialog", { name: "Registrar resultado del combate" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Confirmar y continuar", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    if (new URL(this.page.url()).pathname.endsWith("/standings")) await this.page.getByRole("button", { name: "Ir a Combate", exact: true }).click();
    await expect(this.page.getByRole("button", { name: "Iniciar competencia", exact: true }))
      .toBeVisible();
    await expect(this.page.locator("span.tabular-nums").filter({ hasText: /^2\/3$/ }).first())
      .toBeVisible();
  }

  async select(categoryId: string): Promise<void> {
    await this.tab(categoryId).click();
    await expect(this.activeCategory).toHaveAttribute("data-active-category", categoryId);
    await expect(this.tab(categoryId)).toHaveAttribute("aria-selected", "true");
  }

  async hide(categoryId: string): Promise<void> {
    await this.tab(categoryId).locator("..").getByRole("button", { name: /^Ocultar / }).click();
    await expect(this.tab(categoryId)).toHaveCount(0);
  }

  async reopen(name: string, categoryId: string): Promise<void> {
    await this.page.getByText("Ocultas", { exact: true }).click();
    await this.page.getByRole("button", { name, exact: true }).click();
    await expect(this.tab(categoryId)).toBeVisible();
  }

  async progress(): Promise<CategoryProgress> {
    return this.page.evaluate(() => {
      const raw = localStorage.getItem("tkd-tournament");
      if (!raw) throw new Error("The persisted tournament is missing");
      const persisted = JSON.parse(raw) as { state: CategoryProgress };
      const state = persisted.state;
      // Compare the entire category snapshot, not transient UI coordination/revision fields.
      return {
        phase: state.phase,
        config: state.config,
        competitors: state.competitors,
        fights: state.fights,
        groups: state.groups,
        currentFightIndex: state.currentFightIndex,
        bracketMatches: state.bracketMatches,
        bracketSeeds: state.bracketSeeds,
        setupStarted: state.setupStarted,
      };
    });
  }

  async queue(categoryId: string): Promise<CategoryQueueEntry[]> {
    const response = await this.page.request.get(`/api/ring/queue?categoryId=${categoryId}`);
    expect(response.ok()).toBe(true);
    return response.json() as Promise<CategoryQueueEntry[]>;
  }

  async history(): Promise<CategoryHistory[]> {
    const response = await this.page.request.get("/api/history");
    expect(response.ok()).toBe(true);
    return response.json() as Promise<CategoryHistory[]>;
  }
}
