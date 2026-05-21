import type { Page, Locator } from "@playwright/test";

export class FightPage {
  constructor(readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto("/fight");
    await this.page.waitForLoadState("domcontentloaded");
  }

  /**
   * The fight counter span "N/total" (e.g. "1/6") in the top navigation bar.
   * Only present when fights are loaded from the store.
   */
  get fightInfo(): Locator {
    return this.page.locator("span.tabular-nums").filter({ hasText: /^\d+\/\d+$/ }).first();
  }

  /** Button "Cargar combate" — shown when fight is not yet loaded */
  get loadFightButton(): Locator {
    return this.page.getByRole("button", { name: "Cargar combate", exact: true });
  }

  /** Button "Iniciar combate" — shown after loading, when phase is idle */
  get startFightButton(): Locator {
    return this.page.getByRole("button", { name: "Iniciar combate", exact: true });
  }

  /** Button "Finalizar combate" — shown while round is running */
  get endRoundButton(): Locator {
    return this.page.getByRole("button", { name: "Finalizar combate", exact: true });
  }

  /**
   * Timer element — the .font-mono.font-black div in the center column.
   * Renders `formatTime(timeLeft)` which always matches `\d+:\d+`.
   */
  get timer(): Locator {
    return this.page.locator(".font-mono.font-black").filter({ hasText: /\d+:\d+/ }).first();
  }

  /**
   * The red (left) score box — uses the unique `.ring-card-red` CSS class
   * applied to the score div in FightPage.
   */
  get redScore(): Locator {
    return this.page.locator(".ring-card-red");
  }

  /**
   * The blue (right) score box — uses the unique `.ring-card-blue` CSS class.
   */
  get blueScore(): Locator {
    return this.page.locator(".ring-card-blue");
  }

  /**
   * Returns the vote button for a specific judge and color.
   * Scopes to the FlagVoteRow container that has the exact judge ID text,
   * then finds the button by label within that container.
   */
  getJudgeVoteButton(judgeNumber: number, color: "red" | "blue" | "draw"): Locator {
    const labelMap: Record<typeof color, string> = {
      red: "🔴 Rojo",
      blue: "🔵 Azul",
      draw: "⚖️ Empate",
    };
    const label = labelMap[color];
    const judgeId = `J${judgeNumber}`;
    // Each FlagVoteRow is a flex-col div with bg-secondary/20 that contains the judgeId span
    return this.page
      .locator("[class*='bg-secondary']").filter({ has: this.page.getByText(judgeId, { exact: true }) })
      .getByRole("button", { name: label })
      .first();
  }

  /** Load a fight and wait for the fight controls to appear */
  async loadFight(): Promise<void> {
    await this.loadFightButton.click();
    await this.startFightButton.waitFor({ state: "visible", timeout: 10_000 });
  }

  /** Start the fight and wait for the round to begin */
  async startFight(): Promise<void> {
    await this.startFightButton.click();
    await this.endRoundButton.waitFor({ state: "visible", timeout: 5_000 });
  }

  /** Switch the bottom panel to the "Por juez" tab so FlagVoteRow elements are in DOM */
  async switchToPorJuez(): Promise<void> {
    await this.page.getByRole("button", { name: "Por juez", exact: true }).click();
  }

  /** Vote for a judge in the "Por juez" flag panel */
  async voteJudge(judgeNumber: number, color: "red" | "blue" | "draw"): Promise<void> {
    // FlagVoteRow elements only exist in the "Por juez" tab (default is "Mesa decide")
    await this.switchToPorJuez();
    await this.getJudgeVoteButton(judgeNumber, color).click();
    await this.page.waitForTimeout(200);
  }

  /** Pause the fight (no-op if not running) */
  async pauseFight(): Promise<void> {
    const pauseButton = this.page.getByRole("button", { name: "Pausar", exact: true });
    if (await pauseButton.isVisible()) {
      await pauseButton.click();
    }
  }

  /** End the current round */
  async endRound(): Promise<void> {
    await this.endRoundButton.click();
    await this.page.waitForTimeout(300);
  }
}
