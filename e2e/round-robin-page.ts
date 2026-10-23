import { expect, type Page } from "@playwright/test";
import { io } from "socket.io-client";
import { FightPage } from "./fight-page";

export interface RrFight {
  id: string;
  red: { id: string; name: string };
  blue: { id: string; name: string };
  groupId: string;
  completed: boolean;
  winner?: "red" | "blue" | "draw";
  flagsRed?: number;
  flagsBlue?: number;
  isFinalFight?: boolean;
  isTiebreakExtra?: boolean;
  isGoldenPointFight?: boolean;
  playoffKind?: "direct" | "mini";
}

export interface RrProgress {
  phase: string;
  currentFightIndex: number;
  config: { id: string; mode: string; finalSeconds?: number; profileId?: string };
  groups: Array<{ id: string; competitors: Array<{ id: string; name: string }> }>;
  fights: RrFight[];
}

export interface RrServerState {
  categoryId?: string;
  match?: { id: string; requireIndividualFlags?: boolean; goldenPoint?: boolean } | null;
  rules?: { rounds: { duration_seconds: number; golden_point?: boolean } } | null;
  penaltyCounts?: {
    warnings: { red: number; blue: number };
    fouls: { red: number; blue: number };
  };
  matchState?: {
    phase: string;
    timeLeft: number;
    result?: { winner: "red" | "blue" | "draw"; reason: string };
    goldenPoint?: { attempt: number; votes: Record<string, "red" | "blue"> };
  } | null;
}

const apiUrl = "http://127.0.0.1:3397";

/** Independent read-only socket observer against the isolated E2E server. */
export async function readRrServerState(): Promise<RrServerState> {
  return new Promise((resolve, reject) => {
    const socket = io(apiUrl, { autoConnect: false, transports: ["websocket"], timeout: 3_000 });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("state:update timeout"));
    }, 5_000);
    socket.once("state:update", (state: RrServerState) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(state);
    });
    socket.once("connect_error", (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
    socket.connect();
  });
}

export async function readFightResult(
  categoryId: string,
  fightId: string
): Promise<{
  status: string;
  winner: string;
  flagsRed: number;
  flagsBlue: number;
  warningsRed: number;
  warningsBlue: number;
  foulsRed: number;
  foulsBlue: number;
} | null> {
  return new Promise((resolve, reject) => {
    const socket = io(apiUrl, { autoConnect: false, transports: ["websocket"], timeout: 3_000 });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("match:result:get timeout"));
    }, 5_000);
    socket.once("connect", () => {
      socket.emit(
        "match:result:get",
        { categoryId, matchId: fightId },
        (response: {
          ok: boolean;
          result: {
            status: string;
            winner: string;
            flagsRed: number;
            flagsBlue: number;
            warningsRed: number;
            warningsBlue: number;
            foulsRed: number;
            foulsBlue: number;
          } | null;
        }) => {
          clearTimeout(timer);
          socket.disconnect();
          if (!response?.ok) reject(new Error(`Could not query result for ${fightId}`));
          else resolve(response.result);
        }
      );
    });
    socket.once("connect_error", (error: Error) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
    socket.connect();
  });
}

export async function readConfirmedFight(
  categoryId: string,
  fightId: string
): Promise<NonNullable<Awaited<ReturnType<typeof readFightResult>>>> {
  const result = await readFightResult(categoryId, fightId);
  if (!result) throw new Error(`No durable result for ${fightId}`);
  return result;
}

export class RoundRobinPage {
  private readonly fightPage: FightPage;

  constructor(readonly page: Page) {
    this.fightPage = new FightPage(page);
  }

  async progress(): Promise<RrProgress> {
    return this.page.evaluate(() => {
      const raw = localStorage.getItem("tkd-tournament");
      if (!raw) throw new Error("Missing isolated tournament snapshot");
      return JSON.parse(raw).state as RrProgress;
    });
  }

  async currentFight(): Promise<RrFight> {
    const progress = await this.progress();
    const current = progress.fights[progress.currentFightIndex];
    if (!current) throw new Error(`No current fight at ${progress.currentFightIndex}`);
    return current;
  }

  async voteGoldenJudge(judge: number, competitor: "red" | "blue"): Promise<void> {
    await this.page.getByTestId(`gp-vote-J${judge}-${competitor}`).click();
  }

  async confirmGoldenOutcome(): Promise<void> {
    await this.page.getByTestId("gp-confirm-outcome").click();
  }

  async reviewGoldenResult(): Promise<void> {
    const overlay = this.page.getByRole("dialog", { name: "Resultado del combate" });
    await expect(overlay).toBeVisible();
    await overlay.getByRole("button", { name: /Revisar y confirmar resultado/ }).click();
  }

  async adjustSanction(
    side: "red" | "blue",
    kind: "warning" | "minus_point",
    action: "add" | "remove",
    inResultDialog = false
  ): Promise<void> {
    const testId = inResultDialog
      ? `sanction-${side}-${kind}-${action}`
      : `score-sanction-${side}-${kind}-${action}-desktop`;
    const root = inResultDialog
      ? this.page.getByRole("dialog", { name: "Registrar resultado del combate" })
      : this.page.getByTestId(`score-sanctions-${side}-desktop`);
    await root.getByTestId(testId).click();
  }

  async loadCurrent(): Promise<RrServerState> {
    const current = await this.currentFight();
    const load = this.fightPage.loadFightButton;
    await expect(load.or(this.fightPage.startFightButton).first()).toBeVisible();
    if (await load.isVisible()) {
      try {
        await load.click({ timeout: 3_000 });
      } catch (error) {
        // Stage continuation may auto-load while Playwright is clicking the old button.
        if (!(await this.fightPage.startFightButton.isVisible())) throw error;
      }
    }
    await expect(this.fightPage.startFightButton).toBeVisible();
    const server = await readRrServerState();
    expect(server.match?.id).toBe(current.id);
    return server;
  }

  async finishTimed(votes: readonly ("red" | "blue" | "draw")[]): Promise<{
    fight: RrFight;
    serverBefore: RrServerState;
    progress: RrProgress;
  }> {
    expect(votes).toHaveLength(4);
    const fight = await this.currentFight();
    const serverBefore = await this.loadCurrent();
    await this.fightPage.startFight();
    await this.fightPage.endRound();
    const penalties = this.page.getByRole("button", {
      name: "Confirmar penalizaciones",
      exact: true,
    });
    if (await penalties.isVisible()) await penalties.click();
    for (const [index, vote] of votes.entries()) {
      await this.fightPage.voteJudge(index + 1, vote);
    }
    const red = votes.filter((vote) => vote === "red").length;
    const blue = votes.filter((vote) => vote === "blue").length;
    const winner = red === blue ? "draw" : red > blue ? "red" : "blue";
    const confirm =
      winner === "draw"
        ? "Confirmar — Empate en banderas"
        : winner === "red"
          ? "🔴 Confirmar — Rojo gana el round"
          : "🔵 Confirmar — Azul gana el round";
    await this.page.getByRole("button", { name: confirm, exact: true }).click();
    const winnerOverlay = this.page.getByRole("dialog", { name: "Resultado del combate" });
    const nextFight = this.page.getByRole("button", { name: "Siguiente pelea →", exact: true });
    await expect(winnerOverlay.or(nextFight).first()).toBeVisible();
    if (await winnerOverlay.isVisible()) {
      await winnerOverlay.getByRole("button", { name: "Confirmar resultado →" }).click();
    } else {
      await nextFight.click();
    }
    const dialog = this.page.getByRole("dialog", { name: "Registrar resultado del combate" });
    await expect(dialog).toBeVisible();
    const directDraw =
      winner === "draw" &&
      (fight.isFinalFight || (fight.isTiebreakExtra && fight.playoffKind === "direct"));
    await dialog
      .getByRole("button", {
        name: directDraw ? /Iniciar desempate|Iniciar Punto de Oro/ : "Confirmar y continuar",
      })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(async () => (await this.progress()).fights.find((entry) => entry.id === fight.id))
      .toMatchObject({ completed: true, winner, flagsRed: red, flagsBlue: blue });
    const progress = await this.progress();
    const confirmed = await readConfirmedFight(progress.config.id, fight.id);
    expect(confirmed).toMatchObject({
      status: "confirmed",
      winner,
      flagsRed: red,
      flagsBlue: blue,
    });
    return { fight, serverBefore, progress };
  }
}
