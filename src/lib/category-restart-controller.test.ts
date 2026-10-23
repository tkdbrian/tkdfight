import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RestartCategoryRequest,
  RestartCategorySuccess,
} from "@/lib/category-restart-contract";
import { beginCategoryRestart, recoverCategoryRestart } from "@/lib/category-restart-controller";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();
const free = {
  connected: true,
  stateReady: true,
  serverState: { match: null, activeMatchLock: null },
};
function receipt(payload: RestartCategoryRequest): RestartCategorySuccess {
  return {
    ok: true,
    requestId: payload.requestId,
    categoryId: payload.categoryId,
    replacementCategoryId: payload.replacementSnapshot.config.id,
    replacementSnapshot: payload.replacementSnapshot,
    archive: {
      categoryId: payload.categoryId,
      requestId: payload.requestId,
      replacementCategoryId: payload.replacementSnapshot.config.id,
      archivedAt: "2026-10-22",
      sourceTournamentId: 1,
      replacementTournamentId: 2,
      provenance: "as-recorded",
      warnings: [],
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe.each([false, true])("shared restart controller draft=%s", (draft) => {
  function category(): ReturnType<typeof recordedCategory> {
    const previous = recordedCategory();
    if (draft) previous.competitors = [];
    return previous;
  }
  it("blocks duplicate requests and category switches, with no main/registry publication until ACK", async () => {
    const previous = category();
    useTournamentStore.setState(previous);
    const sibling = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().selectCategory(previous.config.id);
    const main = localStorage.getItem("tkd-tournament");
    const registry = localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
    let release: (value: Response) => void = () => {};
    let payload: RestartCategoryRequest | null = null;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      payload = JSON.parse(String(options?.body)) as RestartCategoryRequest;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const pending = beginCategoryRestart(previous, free);
    expect(useCategoryRestartState.getState().pending).toBe(true);
    expect(await beginCategoryRestart(previous, free)).toBe(false);
    expect(useTournamentStore.getState().selectCategory(sibling ?? "")).toBe(false);
    expect(localStorage.getItem("tkd-tournament")).toBe(main);
    expect(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY)).toBe(registry);
    expect(payload).not.toBeNull();
    const posted = payload as RestartCategoryRequest | null;
    if (!posted) throw new Error("Missing posted restart request");
    release(new Response(JSON.stringify(receipt(posted))));
    expect(await pending).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(useTournamentStore.getState().config.id).not.toBe(previous.config.id);
  });

  it("rejects any other-category lock and known conflict without changing existing authorities", async () => {
    const previous = category();
    useTournamentStore.setState(previous);
    const before = localStorage.getItem("tkd-tournament");
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "active_match", message: "Ocupado" }), {
          status: 409,
        })
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await beginCategoryRestart(previous, {
        ...free,
        serverState: { activeMatchLock: { fightId: "other", categoryId: "other" } },
      })
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await beginCategoryRestart(previous, free)).toBe(false);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(false);
    expect(localStorage.getItem("tkd-tournament")).toBe(before);
  });

  it("recovers a lost ACK by canonical lookup with the original request identity", async () => {
    const previous = category();
    useTournamentStore.setState(previous);
    let committed: RestartCategorySuccess | null = null;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        committed = receipt(JSON.parse(String(options.body)) as RestartCategoryRequest);
        throw new Error("ACK perdido");
      }
      return new Response(JSON.stringify(committed));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(previous, free)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(useTournamentStore.getState().config.id).toBe(
      (committed as RestartCategorySuccess | null)?.replacementCategoryId
    );
  });

  it("keeps old view read-only after storage failure and recovers without a second restart", async () => {
    const previous = category();
    useTournamentStore.setState(previous);
    let committed: RestartCategorySuccess | null = null;
    const original = Storage.prototype.setItem;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        committed = receipt(JSON.parse(String(options.body)) as RestartCategoryRequest);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("quota");
        });
      }
      return new Response(JSON.stringify(committed));
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(previous, free)).toBe(false);
    expect(useTournamentStore.getState().config.id).toBe(previous.config.id);
    expect(useCategoryRestartState.getState().recoveryRequired).toBe(true);
    expect(useTournamentStore.getState().createCategory()).toBeNull();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(original);
    expect(await recoverCategoryRestart()).toBe(true);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
});
