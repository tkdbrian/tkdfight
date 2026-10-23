import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CategoryDeletionReceipt,
  type CategoryDeletionTombstone,
  categoryDeletionRequestSchema,
} from "@/lib/category-deletion-contract";
import { beginCategoryDeletion } from "@/lib/category-deletion-controller";
import {
  CATEGORY_DELETIONS_KEY,
  RETIRED_CATEGORY_SOURCES_KEY,
} from "@/lib/category-deletion-persistence";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import {
  PENDING_CATEGORY_DELETION_KEY,
  useCategoryDeletionState,
} from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import {
  TOURNAMENT_CATEGORY_STORAGE_KEY,
  type TournamentCategorySnapshot,
  useTournamentStore,
} from "@/store/tournament";
import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";

const initial = useTournamentStore.getState();

function tombstone(categoryId: string): CategoryDeletionTombstone {
  return { categoryId, requestId: crypto.randomUUID(), deletedAt: "2026-10-22T00:00:00.000Z" };
}

function seed(
  categories: TournamentCategorySnapshot[],
  selected: TournamentCategorySnapshot
): void {
  localStorage.setItem(
    TOURNAMENT_CATEGORY_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      categories: Object.fromEntries(categories.map((snapshot) => [snapshot.config.id, snapshot])),
      visibleCategoryIds: categories.map((snapshot) => snapshot.config.id),
      selectedCategoryId: selected.config.id,
      draftCategoryId: null,
      draftReturnCategoryId: null,
    })
  );
  act(() => useTournamentStore.setState(selected));
}

function graphJson(): string {
  const state = useTournamentStore.getState();
  return JSON.stringify({
    config: state.config,
    fights: state.fights,
    groups: state.groups,
    competitors: state.competitors,
    bracketMatches: state.bracketMatches,
    bracketSeeds: state.bracketSeeds,
    currentFightIndex: state.currentFightIndex,
    phase: state.phase,
  });
}

function registry(): {
  categories: Record<string, TournamentCategorySnapshot>;
  archives?: unknown;
  selectedCategoryId: string | null;
  visibleCategoryIds: string[];
} {
  return JSON.parse(localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) ?? "{}");
}

beforeEach(() => {
  localStorage.clear();
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Local tombstones must not activate the server");
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  localStorage.clear();
  act(() => useTournamentStore.setState(initial, true));
  localStorage.clear();
});

describe("independent deletion tombstone persistence integration", () => {
  it("preserves the selected sibling's exact progress while deleting a different execution and rejecting its old replacement ACK", () => {
    const deleted = recordedCategory();
    const sibling = createRestartReplacement(deleted);
    sibling.currentFightIndex = 1;
    sibling.fights[0] = { ...sibling.fights[0], completed: true, winner: "blue", flagsBlue: 3 };
    seed([deleted, sibling], sibling);
    const before = graphJson();
    const beforeSibling = JSON.stringify(registry().categories[sibling.config.id]);

    expect(
      useTournamentStore.getState().applyCategoryDeletions([tombstone(deleted.config.id)])
    ).toBe(true);
    expect(graphJson()).toBe(before);
    expect(registry().selectedCategoryId).toBe(sibling.config.id);
    expect(JSON.stringify(registry().categories[sibling.config.id])).toBe(beforeSibling);
    expect(registry().categories[deleted.config.id]).toBeUndefined();
    const stale = restartReceipt();
    stale.replacementCategoryId = deleted.config.id;
    stale.replacementSnapshot = deleted;
    expect(useTournamentStore.getState().applyCategoryRestart(stale)).toBe(false);
    expect(graphJson()).toBe(before);
    expect(useTournamentStore.getState().reopenCategory(deleted.config.id)).toBe(false);
    expect(useTournamentStore.getState().restoreCategorySnapshot(deleted.config.id)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records a retired restart source separately from the actually deleted terminal target without inventing an archive", () => {
    const source = recordedCategory();
    const sibling = createRestartReplacement(source);
    seed([source, sibling], sibling);
    const sourceBytes = JSON.stringify(registry().categories[source.config.id]);
    const before = graphJson();
    const terminal = tombstone("deleted-terminal-generation");

    expect(useTournamentStore.getState().retireCategorySource(source.config.id, terminal)).toBe(
      true
    );
    expect(JSON.parse(localStorage.getItem(CATEGORY_DELETIONS_KEY) ?? "[]")).toEqual([terminal]);
    expect(JSON.parse(localStorage.getItem(RETIRED_CATEGORY_SOURCES_KEY) ?? "[]")).toEqual([
      { sourceCategoryId: source.config.id, deletedTargetCategoryId: terminal.categoryId },
    ]);
    expect(JSON.stringify(registry().categories[source.config.id])).toBe(sourceBytes);
    expect(registry().archives).toBeUndefined();
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === source.config.id)
    ).toBe(false);
    expect(useTournamentStore.getState().reopenCategory(source.config.id)).toBe(false);
    expect(graphJson()).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a marker durable and old memory non-writable if the main authority write fails", () => {
    const deleted = recordedCategory();
    seed([deleted], deleted);
    const before = graphJson();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "tkd-tournament") throw new Error("main authority quota");
      original.call(this, key, value);
    });
    expect(
      useTournamentStore.getState().applyCategoryDeletions([tombstone(deleted.config.id)])
    ).toBe(false);
    expect(JSON.parse(localStorage.getItem(CATEGORY_DELETIONS_KEY) ?? "[]")).toEqual([
      expect.objectContaining({ categoryId: deleted.config.id }),
    ]);
    useTournamentStore.getState().addCompetitor({ name: "Must not resurrect" });
    expect(graphJson()).toBe(before);
    expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates only an empty same-event local draft when the final visible execution is deleted", () => {
    const deleted = recordedCategory();
    deleted.config.eventId = "same-event-retained";
    deleted.config.profileId = "yusan-2026";
    seed([deleted], deleted);
    act(() =>
      useTournamentStore.setState({ eventProfiles: { "same-event-retained": "yusan-2026" } })
    );
    localStorage.setItem("independent-preference", "preserved");

    expect(
      useTournamentStore.getState().applyCategoryDeletions([tombstone(deleted.config.id)])
    ).toBe(true);
    const next = useTournamentStore.getState();
    expect(next.config.id).not.toBe(deleted.config.id);
    expect(next.config).toMatchObject({
      eventId: deleted.config.eventId,
      tournamentName: deleted.config.tournamentName,
      categoryName: "",
      profileId: "yusan-2026",
    });
    expect(next.eventProfiles).toEqual({ "same-event-retained": "yusan-2026" });
    expect(next.fights).toEqual([]);
    expect(next.competitors).toEqual([]);
    expect(next.phase).toBe("setup");
    expect(next.getCategoryEntries()).toEqual([
      expect.objectContaining({ id: next.config.id, visible: true, isDraft: true, fightIds: [] }),
    ]);
    expect(localStorage.getItem("independent-preference")).toBe("preserved");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("consumes another tab's tombstone without autosaving its stale current graph back into the registry", () => {
    const deleted = recordedCategory();
    const sibling = createRestartReplacement(deleted);
    seed([deleted, sibling], deleted);
    const siblingBefore = structuredClone(registry().categories[sibling.config.id]);
    localStorage.setItem(CATEGORY_DELETIONS_KEY, JSON.stringify([tombstone(deleted.config.id)]));
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: CATEGORY_DELETIONS_KEY,
          storageArea: localStorage,
          newValue: localStorage.getItem(CATEGORY_DELETIONS_KEY),
        })
      )
    );

    expect(useTournamentStore.getState().config.id).toBe(sibling.config.id);
    expect(registry().categories[deleted.config.id]).toBeUndefined();
    expect(registry().categories[sibling.config.id]).toEqual(siblingBefore);
    expect(useTournamentStore.getState().saveCategorySnapshot()).toBe(true);
    expect(registry().visibleCategoryIds).toEqual([sibling.config.id]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("durably retires a stale deletion source before clearing its journal when 410 identifies a different deleted target", async () => {
    const source = recordedCategory();
    const sibling = createRestartReplacement(source);
    seed([source, sibling], source);
    const sourceBefore = structuredClone(registry().categories[source.config.id]);
    const terminal = tombstone("actually-deleted-terminal");
    const deletion = {
      ok: true,
      ...terminal,
      tournamentId: null,
      counts: {
        competitors: 3,
        fights: 3,
        completedFights: 0,
        confirmedResults: 0,
        localOnlyFights: 3,
      },
    };
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "replacement_deleted",
            categoryId: source.config.id,
            message: "El reemplazo ya fue eliminado",
            deletion,
          }),
          { status: 410 }
        )
    );
    vi.stubGlobal("fetch", fetcher);
    const preview = {
      ok: true as const,
      categoryId: source.config.id,
      revision: "a".repeat(64),
      counts: deletion.counts,
      warnings: [],
      requiresConfirmationText: true,
    };

    expect(
      await beginCategoryDeletion(
        source,
        preview,
        { connected: true, stateReady: true, serverState: { match: null, activeMatchLock: null } },
        "ELIMINAR"
      )
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(CATEGORY_DELETIONS_KEY) ?? "[]")).toEqual([terminal]);
    expect(JSON.parse(localStorage.getItem(RETIRED_CATEGORY_SOURCES_KEY) ?? "[]")).toEqual([
      { sourceCategoryId: source.config.id, deletedTargetCategoryId: terminal.categoryId },
    ]);
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
    expect(registry().categories[source.config.id]).toEqual(sourceBefore);
    expect(useTournamentStore.getState().config.id).toBe(sibling.config.id);
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === source.config.id)
    ).toBe(false);
    expect(useCategoryDeletionState.getState().recoveryRequired).toBe(false);
  });

  it("recovers a committed deletion after a lost 503 acknowledgement without a second destructive POST", async () => {
    const deleted = recordedCategory();
    const sibling = createRestartReplacement(deleted);
    sibling.currentFightIndex = 1;
    seed([deleted, sibling], deleted);
    let canonical: CategoryDeletionReceipt | undefined;
    const counts = {
      competitors: 3,
      fights: 3,
      completedFights: 0,
      confirmedResults: 0,
      localOnlyFights: 3,
    };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => {
      if (options?.method === "POST") {
        if (typeof options.body !== "string") throw new Error("Missing deletion request");
        const request = categoryDeletionRequestSchema.parse(JSON.parse(options.body));
        expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).not.toBeNull();
        expect(useTournamentStore.getState().config.id).toBe(deleted.config.id);
        expect(registry().categories[deleted.config.id]).toEqual(deleted);
        canonical = {
          ok: true,
          categoryId: deleted.config.id,
          requestId: request.requestId,
          deletedAt: "2026-10-22T00:00:00.000Z",
          tournamentId: null,
          counts,
        };
        return new Response(
          JSON.stringify({
            ok: false,
            error: "deletion_failed",
            message: "Proxy lost the committed acknowledgement",
          }),
          { status: 503 }
        );
      }
      if (!canonical) throw new Error("Lookup before committed deletion");
      return new Response(JSON.stringify(canonical));
    });
    vi.stubGlobal("fetch", fetcher);
    const preview = {
      ok: true as const,
      categoryId: deleted.config.id,
      revision: "a".repeat(64),
      counts,
      warnings: [],
      requiresConfirmationText: true,
    };

    expect(
      await beginCategoryDeletion(
        deleted,
        preview,
        { connected: true, stateReady: true, serverState: { match: null, activeMatchLock: null } },
        "ELIMINAR"
      )
    ).toBe(true);
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
    expect(useTournamentStore.getState().config.id).toBe(sibling.config.id);
    expect(useTournamentStore.getState().currentFightIndex).toBe(1);
    expect(registry().categories[deleted.config.id]).toBeUndefined();
    expect(localStorage.getItem(PENDING_CATEGORY_DELETION_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(CATEGORY_DELETIONS_KEY) ?? "[]")).toEqual([
      expect.objectContaining({ categoryId: deleted.config.id, requestId: canonical?.requestId }),
    ]);
    expect(useCategoryDeletionState.getState().recoveryRequired).toBe(false);
  });

  it("hydrates a partially written stale main and registry without reviving the deleted execution", async () => {
    const deleted = recordedCategory();
    seed([deleted], deleted);
    localStorage.setItem(CATEGORY_DELETIONS_KEY, JSON.stringify([tombstone(deleted.config.id)]));
    vi.resetModules();
    const { useTournamentStore: reloaded } = await import("@/store/tournament");
    expect(reloaded.getState().config.id).not.toBe(deleted.config.id);
    expect(reloaded.getState().config.eventId).toBe(deleted.config.eventId);
    expect(reloaded.getState().getCategoryEntries()).toEqual([
      expect.objectContaining({ id: reloaded.getState().config.id, isDraft: true }),
    ]);
    expect(registry().categories[deleted.config.id]).toBeUndefined();
    expect(reloaded.getState().reopenCategory(deleted.config.id)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
