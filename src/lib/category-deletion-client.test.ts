import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CategoryDeletionRequestError,
  lookupCategoryDeletion,
  previewCategoryDeletion,
  requestCategoryDeletion,
} from "@/lib/category-deletion-client";
import { recordedCategory } from "@/test/category-restart-fixtures";

const counts = {
  competitors: 3,
  fights: 3,
  completedFights: 0,
  confirmedResults: 0,
  localOnlyFights: 3,
};
afterEach(() => vi.unstubAllGlobals());

describe("canonical deletion transport", () => {
  it("pairs authoritative counts and revision with the exact selected snapshot", async () => {
    const snapshot = recordedCategory();
    const preview = {
      ok: true,
      categoryId: snapshot.config.id,
      revision: "a".repeat(64),
      counts,
      warnings: [],
      requiresConfirmationText: true,
    };
    const fetcher = vi.fn(
      async (_url: string, _options?: RequestInit) => new Response(JSON.stringify(preview))
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await previewCategoryDeletion(snapshot)).toEqual(preview);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      localSnapshot: snapshot,
    });
  });

  it("validates receipt identity and rejects foreign or malformed successful acknowledgements", async () => {
    const localSnapshot = recordedCategory();
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: "a".repeat(64),
      localSnapshot,
    };
    const receipt = {
      ok: true,
      categoryId: localSnapshot.config.id,
      requestId: request.requestId,
      tournamentId: null,
      deletedAt: "2026-10-22T00:00:00.000Z",
      counts,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(receipt)))
    );
    expect(await requestCategoryDeletion(localSnapshot.config.id, request)).toEqual(receipt);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...receipt, categoryId: "foreign" })))
    );
    await expect(requestCategoryDeletion(localSnapshot.config.id, request)).rejects.toThrow(
      /ajena/
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    );
    await expect(lookupCategoryDeletion(localSnapshot.config.id)).rejects.toThrow(/inválida/);
  });

  it("retains canonical terminal deletion separately from the queried archived source", async () => {
    const deletion = {
      ok: true,
      categoryId: "terminal-C",
      requestId: crypto.randomUUID(),
      tournamentId: 9,
      deletedAt: "2026-10-22T00:00:00.000Z",
      counts,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "replacement_deleted",
              categoryId: "source-A",
              message: "Reemplazo eliminado",
              deletion,
            }),
            { status: 410 }
          )
      )
    );
    const error = await lookupCategoryDeletion("source-A").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CategoryDeletionRequestError);
    if (!(error instanceof CategoryDeletionRequestError)) throw new Error("Expected typed error");
    expect(error.deletion?.categoryId).toBe("terminal-C");
    expect(error.categoryId).toBe("source-A");
  });

  it("treats only canonical missing lookup as absence, preserving unknown server failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, error: "deletion_not_found", message: "Sin eliminación" }),
            { status: 404 }
          )
      )
    );
    expect(await lookupCategoryDeletion("old")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gateway", { status: 502 }))
    );
    await expect(lookupCategoryDeletion("old")).rejects.toThrow();
  });
});
