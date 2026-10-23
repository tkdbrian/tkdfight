import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleSetSparring } from "@/engine/types";
import {
  lookupCategoryDeletion,
  previewCategoryDeletion,
  requestCategoryDeletion,
} from "@/lib/category-deletion-client";
import { beginCategoryDeletion, recoverCategoryDeletion } from "@/lib/category-deletion-controller";
import { createRestartReplacement } from "@/lib/category-lifecycle";
import { lookupCategoryReplacement, requestCategoryRestart } from "@/lib/category-restart-client";
import type { RestartCategoryRequest } from "@/lib/category-restart-contract";
import { beginCategoryRestart, recoverCategoryRestart } from "@/lib/category-restart-controller";
import baseline from "@/rules/rules/rules_sparring_itf_baseline.json";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useCategoryRestartState } from "@/store/category-restart-state";
import { type TournamentCategorySnapshot, useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

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
let snapshot: TournamentCategorySnapshot;
function corruptRules(): void {
  Object.assign(snapshot.config, {
    ruleSet: { ...baseline, rounds: { ...baseline.rounds, count: "bad count" } },
  });
}
function restartRequest(): RestartCategoryRequest {
  return {
    requestId: crypto.randomUUID(),
    categoryId: snapshot.config.id,
    previousSnapshot: snapshot,
    replacementSnapshot: createRestartReplacement(snapshot),
  };
}
beforeEach(() => {
  localStorage.clear();
  snapshot = recordedCategory();
  snapshot.config.ruleSet = baseline as RuleSetSparring;
  useTournamentStore.setState(snapshot);
});
afterEach(() => {
  vi.unstubAllGlobals();
  useCategoryRestartState.setState({ pending: false, recoveryRequired: false, message: null });
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});

describe("safe validation with real preset metadata", () => {
  it.each([
    { operation: "restart", json: true },
    { operation: "delete", json: true },
    { operation: "restart", json: false },
    { operation: "delete", json: false },
  ])("does not leak unknown server errors or invalid JSON: $operation/json=$json", async ({
    operation,
    json,
  }) => {
    const privateData = "PRIVATE_COMPETITOR_DATA ".repeat(100);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            json
              ? JSON.stringify({
                  ok: false,
                  error: "unknown_internal_failure",
                  message: privateData,
                  graph: snapshot,
                })
              : privateData,
            { status: 500 }
          )
      )
    );
    const error: unknown = await (operation === "restart"
      ? lookupCategoryReplacement(snapshot.config.id)
      : lookupCategoryDeletion(snapshot.config.id)
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Missing application error");
    expect(error.message.length).toBeLessThan(240);
    expect(error.message).toMatch(/Recuperá|actualizá/i);
    expect(error.message).not.toMatch(/PRIVATE_COMPETITOR_DATA|unknown_internal_failure/);
  });
  it.each([
    "restart",
    "delete",
  ])("rejects invalid %s request locally without raw Zod details, a POST or a recovery journal", async (operation) => {
    corruptRules();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const promise =
      operation === "restart"
        ? requestCategoryRestart(restartRequest())
        : requestCategoryDeletion(snapshot.config.id, {
            requestId: crypto.randomUUID(),
            expectedRevision: "a".repeat(64),
            localSnapshot: snapshot,
          });
    const error: unknown = await promise.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Missing application error");
    expect(error.message.length).toBeLessThan(240);
    expect(error.message).toMatch(/configuración.*reglas/);
    expect(error.message).not.toMatch(/invalid_union|unrecognized_keys/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      localStorage.getItem(
        `tkd-pending-category-${operation === "restart" ? "restart" : "deletion"}-v1`
      )
    ).toBeNull();
  });

  it.each([
    "restart",
    "delete",
  ])("keeps an invalid %s recovery journal intact and readonly with a human configuration message", async (operation) => {
    corruptRules();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const key = `tkd-pending-category-${operation === "restart" ? "restart" : "deletion"}-v1`;
    const journal =
      operation === "restart"
        ? restartRequest()
        : {
            categoryId: snapshot.config.id,
            request: {
              requestId: crypto.randomUUID(),
              expectedRevision: "a".repeat(64),
              localSnapshot: snapshot,
            },
          };
    const raw = JSON.stringify(journal);
    localStorage.setItem(key, raw);
    expect(
      await (operation === "restart" ? recoverCategoryRestart() : recoverCategoryDeletion())
    ).toBe(false);
    const state =
      operation === "restart"
        ? useCategoryRestartState.getState()
        : useCategoryDeletionState.getState();
    expect(state.recoveryRequired).toBe(true);
    expect(state.message).toMatch(/configuración.*reglas/);
    expect(state.message?.length).toBeLessThan(240);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("round-trips all real preset metadata through acknowledged restart without stripping it", async () => {
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      const payload = JSON.parse(String(options?.body)) as RestartCategoryRequest;
      expect(payload.previousSnapshot.config.ruleSet).toEqual(baseline);
      expect(payload.replacementSnapshot.config.ruleSet).toEqual(baseline);
      return new Response(
        JSON.stringify({
          ok: true,
          requestId: payload.requestId,
          categoryId: payload.categoryId,
          replacementCategoryId: payload.replacementSnapshot.config.id,
          replacementSnapshot: payload.replacementSnapshot,
          archive: {
            categoryId: payload.categoryId,
            requestId: payload.requestId,
            replacementCategoryId: payload.replacementSnapshot.config.id,
            sourceTournamentId: 1,
            replacementTournamentId: 2,
            archivedAt: "2026-10-22T00:00:00.000Z",
            provenance: "as-recorded",
            warnings: [],
          },
        })
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await beginCategoryRestart(snapshot, free)).toBe(true);
    expect(useTournamentStore.getState().config.ruleSet).toEqual(baseline);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates actual full preset metadata in Delete preview and commit without reducing the request", async () => {
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as {
        requestId?: string;
        localSnapshot: TournamentCategorySnapshot;
      };
      expect(body.localSnapshot.config.ruleSet).toEqual(baseline);
      return new Response(
        JSON.stringify(
          url.endsWith("deletion-preview")
            ? {
                ok: true,
                categoryId: snapshot.config.id,
                revision: "a".repeat(64),
                counts,
                warnings: [],
                requiresConfirmationText: true,
              }
            : {
                ok: true,
                requestId: body.requestId,
                categoryId: snapshot.config.id,
                tournamentId: null,
                deletedAt: "2026-10-22T00:00:00.000Z",
                counts,
              }
        )
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const preview = await previewCategoryDeletion(snapshot);
    expect(await beginCategoryDeletion(snapshot, preview, free, "ELIMINAR")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    "restart",
    "delete",
  ])("never publishes an invalid %s ACK or leaks its private payload, retaining the recovery journal", async (operation) => {
    const before = localStorage.getItem("tkd-tournament");
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            diagnostic: {
              privateGraph: "PRIVATE_COMPETITOR_DATA",
              issues: [{ code: "invalid_union" }],
            },
          })
        )
    );
    vi.stubGlobal("fetch", fetcher);
    const result =
      operation === "restart"
        ? await beginCategoryRestart(snapshot, free)
        : await beginCategoryDeletion(
            snapshot,
            {
              ok: true,
              categoryId: snapshot.config.id,
              revision: "a".repeat(64),
              counts,
              warnings: [],
              requiresConfirmationText: true,
            },
            free,
            "ELIMINAR"
          );
    expect(result).toBe(false);
    const state =
      operation === "restart"
        ? useCategoryRestartState.getState()
        : useCategoryDeletionState.getState();
    expect(state.recoveryRequired).toBe(true);
    expect(state.message).toMatch(/inválida.*recuper/i);
    expect(state.message).not.toMatch(/PRIVATE_COMPETITOR_DATA|invalid_union/);
    expect(localStorage.getItem("tkd-tournament")).toBe(before);
    expect(
      localStorage.getItem(
        `tkd-pending-category-${operation === "restart" ? "restart" : "deletion"}-v1`
      )
    ).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
