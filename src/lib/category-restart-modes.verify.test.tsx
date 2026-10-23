import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSocket } from "@/hooks/useSocket";
import type { CategoryDeletionPreview } from "@/lib/category-deletion-contract";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import { categoryRestartSnapshotSchema } from "@/lib/category-restart-contract";
import { beginCategoryRestart, recoverCategoryRestart } from "@/lib/category-restart-controller";
import {
  type CategoryDeleteAndRestartRequest,
  type CategoryDeleteAndRestartSuccess,
  categoryDeleteAndRestartRequestSchema,
} from "@/lib/category-restart-modes-contract";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import {
  PENDING_CATEGORY_RESTART_KEY,
  useCategoryRestartState,
} from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (value: unknown) => void>(),
  emit: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({
    ...transport,
    on: (name: string, handler: (value: unknown) => void) => transport.handlers.set(name, handler),
  }),
}));

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
const counts = {
  competitors: 3,
  fights: 3,
  completedFights: 0,
  confirmedResults: 0,
  localOnlyFights: 3,
};
const ledgerKey = "tkd-category-deletions-v1";

function prepared(): {
  request: CategoryDeleteAndRestartRequest;
  preview: CategoryDeletionPreview;
} {
  const snapshot = recordedCategory();
  const previousSnapshot = categoryRestartSnapshotSchema.parse({
    ...snapshot,
    config: { ...snapshot.config, ruleSet: baseline },
  });
  return {
    request: {
      requestId: crypto.randomUUID(),
      expectedRevision: "a".repeat(64),
      previousSnapshot,
      replacementSnapshot: createRestartReplacement(previousSnapshot),
    },
    preview: {
      ok: true,
      categoryId: previousSnapshot.config.id,
      revision: "a".repeat(64),
      counts,
      warnings: [],
      requiresConfirmationText: true,
    },
  };
}

function receipt(request: CategoryDeleteAndRestartRequest): CategoryDeleteAndRestartSuccess {
  return {
    ok: true,
    requestId: request.requestId,
    categoryId: request.previousSnapshot.config.id,
    replacementCategoryId: request.replacementSnapshot.config.id,
    replacementSnapshot: request.replacementSnapshot,
    deletion: {
      ok: true,
      requestId: request.requestId,
      categoryId: request.previousSnapshot.config.id,
      tournamentId: 7,
      deletedAt: "2026-10-22T18:00:00.000Z",
      counts,
    },
  };
}

function committedReceipt(
  value: CategoryDeleteAndRestartSuccess | null
): CategoryDeleteAndRestartSuccess {
  if (!value) throw new Error("Expected a committed server receipt");
  return value;
}

function selectOther(): ReturnType<typeof useTournamentStore.getState> {
  const source = useTournamentStore.getState();
  const categoryId = source.createCategory();
  if (!categoryId) throw new Error("Expected unrelated category");
  const other = createRestartReplacement(source);
  other.config.id = categoryId;
  other.config.categoryName = "Otra con progreso";
  other.fights[0] = { ...other.fights[0], completed: true, winner: "blue", flagsBlue: 3 };
  other.currentFightIndex = 1;
  useTournamentStore.setState(other);
  expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(true);
  return useTournamentStore.getState();
}

beforeEach(() => {
  localStorage.clear();
  useCategoryRestartState.setState(
    {
      ...useCategoryRestartState.getInitialState(),
      pending: false,
      recoveryRequired: false,
      message: null,
    },
    true
  );
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  transport.handlers.clear();
  transport.emit.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  useCategoryRestartState.setState(
    {
      ...useCategoryRestartState.getInitialState(),
      pending: false,
      recoveryRequired: false,
      message: null,
    },
    true
  );
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  transport.handlers.clear();
  localStorage.clear();
});

describe("independent combined delete-and-restart recovery", () => {
  it("rejects a late canonical ACK after another request's terminal recovery retires its actual replacement", async () => {
    const { request: actual } = prepared();
    const canonical = receipt(actual);
    useTournamentStore.setState(actual.previousSnapshot);
    const other = selectOther();
    const losing = {
      ...actual,
      requestId: crypto.randomUUID(),
      replacementSnapshot: createRestartReplacement(actual.previousSnapshot),
    };
    localStorage.setItem(
      PENDING_CATEGORY_RESTART_KEY,
      JSON.stringify({
        mode: "delete-and-restart",
        categoryId: canonical.categoryId,
        request: losing,
      })
    );
    useCategoryRestartState.setState({ recoveryRequired: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "replacement_deleted",
              categoryId: canonical.categoryId,
              requestId: actual.requestId,
              deletion: canonical.deletion,
              replacementCategoryId: canonical.replacementCategoryId,
              replacementDeletion: {
                ...canonical.deletion,
                categoryId: "deleted-descendant-E",
                requestId: crypto.randomUUID(),
              },
              message: "Reemplazo eliminado",
            }),
            { status: 410 }
          )
      )
    );
    expect(await recoverCategoryRestart()).toBe(true);
    expect(useTournamentStore.getState().config).toEqual(other.config);
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(canonical)).toBe(false);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === canonical.replacementCategoryId)
    ).toBe(false);
    expect(localStorage.getItem("tkd-retired-category-sources-v1")).not.toContain(
      losing.replacementSnapshot.config.id
    );
    expect(useTournamentStore.getState().fights).toEqual(other.fights);
  });
  it("durably observes category:deleted before ACK without publishing an empty fallback or activating a server category", async () => {
    const { request, preview } = prepared();
    const source = request.previousSnapshot;
    useTournamentStore.setState(source);
    renderHook(() => useSocket());
    const states: { id: string; entrants: number }[] = [];
    const unsubscribe = useTournamentStore.subscribe((state) =>
      states.push({ id: state.config.id, entrants: state.competitors.length })
    );
    let posted: CategoryDeleteAndRestartRequest | null = null;
    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options?: RequestInit) => {
        posted = categoryDeleteAndRestartRequestSchema.parse(JSON.parse(String(options?.body)));
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      })
    );
    const operation = beginCategoryRestart(source, free, {
      mode: "delete-and-restart",
      preview,
      confirmationText: "ELIMINAR",
    });
    if (!posted) throw new Error("Expected combined POST");
    const canonical = receipt(posted);
    try {
      const handler = transport.handlers.get("category:deleted");
      if (!handler) throw new Error("Missing real deletion subscription");
      act(() => handler(canonical.deletion));
      expect(localStorage.getItem(ledgerKey)).toContain(source.config.id);
      expect(useTournamentStore.getState().config.id).toBe(source.config.id);
      expect(useTournamentStore.getState().fights).toEqual(source.fights);
      expect(useCategoryRestartState.getState().pending).toBe(true);
      expect(
        JSON.parse(localStorage.getItem(PENDING_CATEGORY_RESTART_KEY) ?? "null")
      ).toMatchObject({ mode: "delete-and-restart", categoryId: source.config.id });
    } finally {
      release(new Response(JSON.stringify(canonical)));
    }
    expect(await operation).toBe(true);
    unsubscribe();
    expect(useTournamentStore.getState().config.id).toBe(canonical.replacementCategoryId);
    expect(states.length).toBeGreaterThan(0);
    expect(
      states.every(
        (state) =>
          [source.config.id, canonical.replacementCategoryId].includes(state.id) &&
          state.entrants === source.competitors.length
      )
    ).toBe(true);
    expect(transport.emit).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_CATEGORY_RESTART_KEY)).toBeNull();
  });

  it.each([
    ledgerKey,
    "tkd-tournament",
    TOURNAMENT_CATEGORY_STORAGE_KEY,
  ])("keeps canonical recovery readonly when %s storage fails after commit, then applies via GET without another POST", async (failingKey) => {
    const { request, preview } = prepared();
    const source = request.previousSnapshot;
    useTournamentStore.setState(source);
    const original = Storage.prototype.setItem;
    let restoreStorage: () => void = () => {};
    let canonical: CategoryDeleteAndRestartSuccess | null = null;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        canonical = receipt(
          categoryDeleteAndRestartRequestSchema.parse(JSON.parse(String(options.body)))
        );
        const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
          this: Storage,
          key,
          value
        ) {
          if (key === failingKey) throw new Error("quota");
          original.call(this, key, value);
        });
        restoreStorage = () => {
          storage.mockRestore();
        };
      }
      return new Response(JSON.stringify(canonical));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(
      await beginCategoryRestart(source, free, {
        mode: "delete-and-restart",
        preview,
        confirmationText: "ELIMINAR",
      })
    ).toBe(false);
    expect(useTournamentStore.getState().config.id).toBe(source.config.id);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(true);
    expect(localStorage.getItem(PENDING_CATEGORY_RESTART_KEY)).not.toBeNull();
    expect(useTournamentStore.getState().createCategory()).toBeNull();
    restoreStorage();
    expect(await recoverCategoryRestart()).toBe(true);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(useTournamentStore.getState().config.id).toBe(
      committedReceipt(canonical).replacementCategoryId
    );
    expect(useTournamentStore.getState().config.ruleSet).toEqual(baseline);
    expect(localStorage.getItem(PENDING_CATEGORY_RESTART_KEY)).toBeNull();
  });

  it("never replaces a progressed local replacement with the receipt's initial graph on replay", () => {
    const { request } = prepared();
    const canonical = receipt(request);
    useTournamentStore.setState(request.previousSnapshot);
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(canonical)).toBe(true);
    const progressed = { ...structuredClone(canonical.replacementSnapshot), currentFightIndex: 1 };
    progressed.fights[0] = {
      ...progressed.fights[0],
      completed: true,
      winner: "blue",
      flagsBlue: 3,
    };
    useTournamentStore.setState(progressed);
    expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(true);
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(canonical)).toBe(true);
    expect(useTournamentStore.getState().fights).toEqual(progressed.fights);
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(useTournamentStore.getState().config.id).toBe(canonical.replacementCategoryId);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === canonical.categoryId)
    ).toBe(false);
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(registry.archives?.[canonical.categoryId]).toBeUndefined();
    expect(registry.categories[canonical.categoryId]).toBeUndefined();
  });

  it("keeps an unrelated selected execution and its progress unchanged while storing the fresh replacement", () => {
    const { request } = prepared();
    const canonical = receipt(request);
    useTournamentStore.setState(request.previousSnapshot);
    const other = selectOther();
    expect(useTournamentStore.getState().applyCategoryDeleteAndRestart(canonical)).toBe(true);
    const current = useTournamentStore.getState();
    expect(current.config).toEqual(other.config);
    expect(current.fights).toEqual(other.fights);
    expect(current.currentFightIndex).toBe(other.currentFightIndex);
    expect(
      current.getCategoryEntries().some((entry) => entry.id === canonical.replacementCategoryId)
    ).toBe(true);
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(registry.selectedCategoryId).toBe(other.config.id);
    expect(registry.categories[canonical.categoryId]).toBeUndefined();
    expect(registry.categories[canonical.replacementCategoryId]).toEqual(
      canonical.replacementSnapshot
    );
  });

  it.each([
    409, 410,
  ])("observes committed HTTP%s lineage without restoring source or the initial replacement over another selection", async (status) => {
    const { request } = prepared();
    const canonical = receipt(request);
    useTournamentStore.setState(request.previousSnapshot);
    const other = selectOther();
    const terminalDeletion = {
      ...canonical.deletion,
      categoryId: "terminal-replacement",
      requestId: crypto.randomUUID(),
    };
    localStorage.setItem(
      PENDING_CATEGORY_RESTART_KEY,
      JSON.stringify({ mode: "delete-and-restart", categoryId: canonical.categoryId, request })
    );
    useCategoryRestartState.setState({ recoveryRequired: true });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: status === 409 ? "category_archived" : "replacement_deleted",
            categoryId: canonical.categoryId,
            message: "Estado avanzado",
            deletion: canonical.deletion,
            ...(status === 409
              ? {
                  archivedCategoryId: canonical.replacementCategoryId,
                  replacementCategoryId: "later-replacement",
                }
              : {
                  replacementCategoryId: canonical.replacementCategoryId,
                  replacementDeletion: terminalDeletion,
                }),
          }),
          { status }
        )
    );
    vi.stubGlobal("fetch", fetcher);
    await recoverCategoryRestart();
    expect(localStorage.getItem(ledgerKey)).toContain(canonical.categoryId);
    expect(useTournamentStore.getState().config).toEqual(other.config);
    expect(useTournamentStore.getState().fights).toEqual(other.fights);
    const registry = JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
    expect(registry.categories[canonical.categoryId]).toBeUndefined();
    expect(registry.categories[canonical.replacementCategoryId]).toBeUndefined();
    expect(registry.selectedCategoryId).toBe(other.config.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PENDING_CATEGORY_RESTART_KEY)).toBeNull();
  });
});
