import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupCategoryReplacement, requestCategoryRestart } from "@/lib/category-restart-client";

import { recordedCategory, restartReceipt } from "@/test/category-restart-fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("restart API client", () => {
  it("validates the canonical ACK and posts the immutable request", async () => {
    const success = restartReceipt();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(success)));
    vi.stubGlobal("fetch", fetcher);
    const payload = {
      requestId: success.requestId,
      categoryId: success.categoryId,
      previousSnapshot: recordedCategory(),
      replacementSnapshot: success.replacementSnapshot,
    };
    expect(await requestCategoryRestart(payload)).toEqual(success);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/ring/restart-category",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) })
    );
  });

  it("rejects conflicts and malformed ACK without returning a success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, error: "active_match", message: "Tatami ocupado" }),
            { status: 409 }
          )
      )
    );
    const success = restartReceipt();
    const payload = {
      requestId: success.requestId,
      categoryId: success.categoryId,
      previousSnapshot: recordedCategory(),
      replacementSnapshot: success.replacementSnapshot,
    };
    await expect(requestCategoryRestart(payload)).rejects.toThrow("Tatami ocupado");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ...success, replacementCategoryId: "wrong" }))
      )
    );
    await expect(requestCategoryRestart(payload)).rejects.toThrow(/respuesta/i);
  });

  it("looks up encoded old identity and treats 404 as no committed replacement", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await lookupCategoryReplacement("old/category")).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/ring/categories/old%2Fcategory/replacement",
      expect.anything()
    );
  });
});
