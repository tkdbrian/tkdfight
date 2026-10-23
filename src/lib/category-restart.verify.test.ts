import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateGroupsTournament } from "@/lib/bracket";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import {
  restartCategoryRequestSchema,
  type RestartCategoryRequest,
  type RestartCategorySuccess,
} from "@/lib/category-restart-contract";
import type { TournamentCategorySnapshot } from "@/store/tournament";

const PENDING_KEY = "tkd-pending-category-restart-v1";
const MAIN_KEY = "tkd-tournament";
const REGISTRY_KEY = "tkd-tournament-categories";
const freeTatami = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};

function CurrentRoute(): React.ReactElement {
  return createElement("output", { "data-testid": "independent-route" }, useLocation().pathname);
}

function previousExecution(categoryId: string): TournamentCategorySnapshot {
  const competitors = ["Ana", "Bruno", "Carla"].map((name) => ({
    id: crypto.randomUUID(),
    name,
    team: "Club de prueba",
  }));
  return {
    phase: "fighting",
    config: {
      id: categoryId,
      eventId: "independent-verification-event",
      tournamentName: "Prueba aislada",
      categoryName: "Adultos",
      tableChief: "Mesa",
      ruleSet: null,
      judgesCount: 3,
      mode: "round-robin",
      matchType: "tul",
    },
    competitors,
    ...generateGroupsTournament(competitors),
    currentFightIndex: 0,
    bracketMatches: [],
    bracketSeeds: [],
    setupStarted: true,
  };
}

function canonicalReceipt(request: RestartCategoryRequest): RestartCategorySuccess {
  const replacementCategoryId = request.replacementSnapshot.config.id;
  return {
    ok: true,
    requestId: request.requestId,
    categoryId: request.categoryId,
    replacementCategoryId,
    replacementSnapshot: request.replacementSnapshot,
    archive: {
      categoryId: request.categoryId,
      requestId: request.requestId,
      replacementCategoryId,
      archivedAt: "2026-10-22T00:00:00.000Z",
      sourceTournamentId: 101,
      replacementTournamentId: 102,
      provenance: "as-recorded",
      warnings: ["Prueba independiente"],
    },
  };
}

async function application(): Promise<{
  controller: typeof import("@/lib/category-restart-controller");
  tournament: typeof import("@/store/tournament");
  interaction: typeof import("@/store/category-restart-state");
}> {
  const tournament = await import("@/store/tournament");
  const interaction = await import("@/store/category-restart-state");
  const controller = await import("@/lib/category-restart-controller");
  return { controller, tournament, interaction };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("@/hooks/useSocket");
  localStorage.clear();
  vi.resetModules();
});

describe("independent restart recovery verification", () => {
  it("continues a stored elimination bracket using navigation only while another category owns the tatami", async () => {
    const operativeLock = {
      categoryId: "other-operative-category",
      fightId: "other-fight",
      resultStatus: "pending_confirmation",
    };
    vi.doMock("@/hooks/useSocket", () => ({
      useSocket: () => ({
        connected: true,
        stateReady: true,
        state: { match: null, activeMatchLock: operativeLock },
      }),
    }));
    const app = await application();
    const sourceId = app.tournament.useTournamentStore.getState().config.id;
    const previous = previousExecution(sourceId);
    previous.config.mode = "elimination";
    const stored = createRestartReplacement(previous);
    stored.config.id = sourceId;
    app.tournament.useTournamentStore.setState(stored);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
      requests.push(`${options?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify([]));
    });
    const { SetupPage } = await import("@/pages/SetupPage");
    await act(async () => {
      render(
        createElement(MemoryRouter, null, createElement(SetupPage), createElement(CurrentRoute))
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar llave" }));

    expect(screen.getByTestId("independent-route")).toHaveTextContent("/bracket");
    expect(app.tournament.useTournamentStore.getState().bracketMatches).toEqual(
      stored.bracketMatches
    );
    expect(app.tournament.useTournamentStore.getState().bracketSeeds).toEqual(stored.bracketSeeds);
    expect(app.tournament.useTournamentStore.getState().currentFightIndex).toBe(
      stored.currentFightIndex
    );
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(0);
    expect(operativeLock).toEqual({
      categoryId: "other-operative-category",
      fightId: "other-fight",
      resultStatus: "pending_confirmation",
    });
  });

  it("prepares a new category locally while a different loaded category retains the server", async () => {
    const operativeLock = {
      categoryId: "running-category-a",
      fightId: "loaded-a",
      resultStatus: null,
    };
    vi.doMock("@/hooks/useSocket", () => ({
      useSocket: () => ({
        connected: true,
        stateReady: true,
        state: { match: null, activeMatchLock: operativeLock },
      }),
    }));
    const app = await application();
    const previous = previousExecution(app.tournament.useTournamentStore.getState().config.id);
    previous.fights = [];
    previous.groups = [];
    previous.phase = "setup";
    previous.config.matchType = "sparring";
    app.tournament.useTournamentStore.setState(previous);
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
      requests.push(`${options?.method ?? "GET"} ${url}`);
      return new Response(
        JSON.stringify(url === "/api/ring/status" ? { activeMatchLock: operativeLock } : [])
      );
    });
    const { SetupPage } = await import("@/pages/SetupPage");
    await act(async () => {
      render(
        createElement(MemoryRouter, null, createElement(SetupPage), createElement(CurrentRoute))
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar categoría" }));

    await waitFor(() =>
      expect(screen.getByTestId("independent-route")).toHaveTextContent("/standings")
    );
    expect(app.tournament.useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(app.tournament.useTournamentStore.getState().competitors).toEqual(previous.competitors);
    expect(app.tournament.useTournamentStore.getState().fights).toHaveLength(3);
    expect(requests).toContain("GET /api/ring/status");
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(0);
    expect(operativeLock.categoryId).toBe("running-category-a");
    expect(operativeLock.fightId).toBe("loaded-a");
  });

  it("cannot erase stored elimination results through Generate when a legacy bracket is missing", async () => {
    vi.doMock("@/hooks/useSocket", () => ({
      useSocket: () => ({
        connected: true,
        stateReady: true,
        state: { match: null, activeMatchLock: null },
      }),
    }));
    const app = await application();
    const previous = previousExecution(app.tournament.useTournamentStore.getState().config.id);
    previous.config.mode = "elimination";
    previous.groups = [];
    previous.fights = [
      {
        ...previous.fights[0],
        completed: true,
        winner: "blue",
        flagsRed: 0,
        flagsBlue: 3,
        winReason: "flags",
      },
    ];
    app.tournament.useTournamentStore.setState(previous);
    const { BracketPage } = await import("@/pages/BracketPage");
    render(createElement(MemoryRouter, null, createElement(BracketPage)));

    const generate = screen.queryByRole("button", { name: "Generar llave" });
    if (generate) fireEvent.click(generate);

    expect(app.tournament.useTournamentStore.getState().fights).toEqual(previous.fights);
    expect(app.tournament.useTournamentStore.getState().bracketMatches).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Reiniciar categoría…" })).toBeVisible();
  });

  it.each([
    500, 502, 503,
  ])("recovers a committed execution after an indeterminate HTTP %i without a second POST", async (status) => {
    const app = await application();
    const previous = previousExecution(app.tournament.useTournamentStore.getState().config.id);
    app.tournament.useTournamentStore.setState(previous);
    let committed: RestartCategorySuccess | undefined;
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, options?: RequestInit) => {
      methods.push(options?.method ?? "GET");
      if (options?.method === "POST") {
        const request = restartCategoryRequestSchema.parse(JSON.parse(String(options.body)));
        committed = canonicalReceipt(request);
        return new Response(JSON.stringify({ message: "ACK perdido después del commit" }), {
          status,
        });
      }
      return new Response(JSON.stringify(committed));
    });

    expect(await app.controller.beginCategoryRestart(previous, freeTatami)).toBe(true);
    expect(app.tournament.useTournamentStore.getState().config.id).toBe(
      committed?.replacementCategoryId
    );
    expect(app.tournament.useTournamentStore.getState().config.eventId).toBe(
      previous.config.eventId
    );
    expect(methods).toEqual(["POST", "GET"]);
    expect(app.interaction.useCategoryRestartState.getState()).toMatchObject({
      pending: false,
      recoveryRequired: false,
    });
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("recovers after only the main authority was written, including a real module reload", async () => {
    const app = await application();
    const previous = previousExecution(app.tournament.useTournamentStore.getState().config.id);
    app.tournament.useTournamentStore.setState(previous);
    const originalRegistry = localStorage.getItem(REGISTRY_KEY);
    const nativeSetItem = Storage.prototype.setItem;
    let committed: RestartCategorySuccess | undefined;
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, options?: RequestInit) => {
      methods.push(options?.method ?? "GET");
      if (options?.method === "POST") {
        committed = canonicalReceipt(
          restartCategoryRequestSchema.parse(JSON.parse(String(options.body)))
        );
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
          this: Storage,
          key: string,
          value: string
        ) {
          if (key === REGISTRY_KEY) throw new Error("quota on registry authority");
          nativeSetItem.call(this, key, value);
        });
      }
      return new Response(JSON.stringify(committed));
    });

    expect(await app.controller.beginCategoryRestart(previous, freeTatami)).toBe(false);
    expect(app.tournament.useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(localStorage.getItem(REGISTRY_KEY)).toBe(originalRegistry);
    expect(JSON.parse(localStorage.getItem(MAIN_KEY) ?? "null").state.config.id).toBe(
      committed?.replacementCategoryId
    );
    expect(app.interaction.useCategoryRestartState.getState().recoveryRequired).toBe(true);
    expect(localStorage.getItem(PENDING_KEY)).toContain(previous.config.id);

    vi.restoreAllMocks();
    vi.resetModules();
    const reloaded = await application();
    expect(reloaded.interaction.useCategoryRestartState.getState().recoveryRequired).toBe(true);
    expect(reloaded.tournament.useTournamentStore.getState().createCategory()).toBeNull();
    expect(await reloaded.controller.recoverCategoryRestart()).toBe(true);
    expect({
      selected: reloaded.tournament.useTournamentStore.getState().config.id,
      source: previous.config.id,
      replacement: committed?.replacementCategoryId,
    }).toEqual({
      selected: committed?.replacementCategoryId,
      source: previous.config.id,
      replacement: committed?.replacementCategoryId,
    });
    expect(reloaded.tournament.useTournamentStore.getState().fights).toEqual(
      committed?.replacementSnapshot.fights
    );
    expect(methods).toEqual(["POST", "GET"]);
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("retains a progressed replacement and a different selected category on stale lookup", async () => {
    const app = await application();
    const previous = previousExecution(app.tournament.useTournamentStore.getState().config.id);
    app.tournament.useTournamentStore.setState(previous);
    const request: RestartCategoryRequest = {
      requestId: crypto.randomUUID(),
      categoryId: previous.config.id,
      previousSnapshot: previous,
      replacementSnapshot: createRestartReplacement(previous),
    };
    const committed = canonicalReceipt(request);
    expect(app.tournament.useTournamentStore.getState().applyCategoryRestart(committed)).toBe(true);
    const fight = app.tournament.useTournamentStore.getState().fights[0];
    app.tournament.useTournamentStore.getState().completeFight(fight.id, "blue", "flags", {
      flagsRed: 0,
      flagsBlue: 3,
      warningsRed: 1,
      warningsBlue: 0,
      foulsRed: 0,
      foulsBlue: 0,
    });
    const siblingId = app.tournament.useTournamentStore.getState().createCategory();
    expect(typeof siblingId).toBe("string");
    localStorage.setItem(PENDING_KEY, JSON.stringify(request));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(committed)));

    vi.resetModules();
    const reloaded = await application();
    expect(await reloaded.controller.recoverCategoryRestart()).toBe(true);
    expect(reloaded.tournament.useTournamentStore.getState().config.id).toBe(siblingId);
    expect(
      reloaded.tournament.useTournamentStore
        .getState()
        .selectCategory(committed.replacementCategoryId)
    ).toBe(true);
    expect(reloaded.tournament.useTournamentStore.getState().fights[0]).toMatchObject({
      id: fight.id,
      completed: true,
      winner: "blue",
      flagsBlue: 3,
      warningsRed: 1,
    });
    expect(
      reloaded.tournament.useTournamentStore.getState().selectCategory(previous.config.id)
    ).toBe(false);
  });
});
