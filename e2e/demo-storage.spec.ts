import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";

let storageBundle = "";

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [resolve(process.cwd(), "src/demo/storage/index.ts")],
    bundle: true, format: "iife", globalName: "DemoStorage", platform: "browser",
    target: "es2022", write: false,
  });
  storageBundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ context, page }) => {
  await context.route("http://demo-storage.local/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Demo storage test</title>" }));
  await page.goto("http://demo-storage.local/");
  await page.addScriptTag({ content: storageBundle });
});

test("commits a canonical snapshot once and pauses a running fight on reopen", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const storage = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const name = `demo-test-${Date.now()}-${Math.random()}`;
    const options = {
      databaseName: name,
      validatePayload: (value: unknown): value is { phase: string; points: number } =>
        !!value && typeof value === "object" && typeof (value as { phase?: unknown }).phase === "string" &&
        typeof (value as { points?: unknown }).points === "number",
      recoverPaused: (payload: { phase: string; points: number }) =>
        payload.phase === "running" ? { ...payload, phase: "paused" } : null,
    };
    let repo = new storage.DemoRepository(options);
    const writer = await repo.acquireWriter();
    repo.subscribe(() => { throw new Error("view failed after commit"); });
    const initial = await repo.readCursor();
    const first = await repo.commit(initial, "g0:start-1", { phase: "ready", points: 0 });
    const retry = await repo.commit(initial, "g0:start-1", { phase: "ready", points: 99 });
    const running = await repo.commit(first.snapshot, "g0:fight-1", { phase: "running", points: 3 });
    await repo.close();
    repo = new storage.DemoRepository(options);
    const reopenedWriter = await repo.acquireWriter();
    const reopened = await repo.read();
    const backup = JSON.parse(await repo.exportBackup()) as { receipts: unknown[] };
    await repo.close();
    return { writer, reopenedWriter, first, retry, running, reopened, receiptCount: backup.receipts.length };
  });
  expect(result.writer).toBe(true);
  expect(result.reopenedWriter).toBe(true);
  expect(result.first.applied).toBe(true);
  expect(result.retry.applied).toBe(false);
  expect(result.retry.snapshot.payload.points).toBe(0);
  expect(result.running.snapshot.revision).toBe(1);
  expect(result.reopened?.payload).toEqual({ phase: "paused", points: 3 });
  expect(result.reopened?.revision).toBe(2);
  expect(result.receiptCount).toBe(3);
});

test("another tab is read-only, then takes over an expired lease after an unexpected close", async ({ context, page }) => {
  const databaseName = `demo-test-${crypto.randomUUID()}`;
  await page.evaluate(async (name) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name,
      validatePayload: (v: unknown): v is { phase: string } => !!v && typeof v === "object" && typeof (v as { phase?: unknown }).phase === "string",
      recoverPaused: (v: { phase: string }) => v.phase === "running" ? { phase: "paused" } : null });
    if (!(await repo.acquireWriter())) throw new Error("first tab was not writer");
    await repo.commit(await repo.readCursor(), "g0:start", { phase: "running" });
    // Deliberately do not close/release: simulates a crashed browser tab.
  }, databaseName);
  const second = await context.newPage();
  await second.goto("http://demo-storage.local/");
  await second.addScriptTag({ content: storageBundle });
  const before = await second.evaluate(async (name) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name,
      validatePayload: (v: unknown): v is { phase: string } => !!v && typeof v === "object" && typeof (v as { phase?: unknown }).phase === "string",
      recoverPaused: (v: { phase: string }) => v.phase === "running" ? { phase: "paused" } : null });
    const acquired = await repo.acquireWriter();
    const observed = await repo.read();
    await repo.close();
    return { acquired, observed };
  }, databaseName);
  expect(before.acquired).toBe(false);
  expect(before.observed?.payload.phase).toBe("running");
  await page.close();
  const after = await second.evaluate(async (name) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name, now: () => Date.now() + 20_000,
      validatePayload: (v: unknown): v is { phase: string } => !!v && typeof v === "object" && typeof (v as { phase?: unknown }).phase === "string",
      recoverPaused: (v: { phase: string }) => v.phase === "running" ? { phase: "paused" } : null });
    const acquired = await repo.acquireWriter();
    const observed = await repo.read();
    await repo.close();
    return { acquired, observed };
  }, databaseName);
  expect(after.acquired).toBe(true);
  expect(after.observed?.payload.phase).toBe("paused");
  await second.close();
});

test("backup preview, stale preview, explicit replacement, reset and invalid import preserve data", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: `demo-test-${Date.now()}-${Math.random()}`,
      validatePayload: (v: unknown): v is { phase: string; results: number[] } =>
        !!v && typeof v === "object" && typeof (v as { phase?: unknown }).phase === "string" &&
        Array.isArray((v as { results?: unknown }).results),
      recoverPaused: (v: { phase: string; results: number[] }) => v.phase === "running" ? { ...v, phase: "paused" } : null });
    await repo.acquireWriter();
    const first = await repo.commit(await repo.readCursor(), "g0:result-1", { phase: "running", results: [1] });
    const backup = await repo.exportBackup();
    const stale = await repo.previewImport(backup);
    const second = await repo.commit(first.snapshot, "g0:result-2", { phase: "done", results: [1, 2] });
    let staleCode = "";
    try { await repo.importBackup(stale, { confirmOverwrite: true }); }
    catch (error) { staleCode = (error as { code: string }).code; }
    let badCode = "";
    try { await repo.previewImport('{"format":"nope"}'); }
    catch (error) { badCode = (error as { code: string }).code; }
    const stillThere = await repo.read();
    const preview = await repo.previewImport(backup);
    let unconfirmedCode = "";
    try { await repo.importBackup(preview, { confirmOverwrite: false } as never); }
    catch (error) { unconfirmedCode = (error as { code: string }).code; }
    const imported = await repo.importBackup(preview, { confirmOverwrite: true });
    const importedReceiptCount = (JSON.parse(await repo.exportBackup()) as { receipts: unknown[] }).receipts.length;
    let staleResetCode = "";
    try { await repo.reset({ confirm: true, expected: second.snapshot }); }
    catch (error) { staleResetCode = (error as { code: string }).code; }
    await repo.reset({ confirm: true, expected: imported });
    const reset = await repo.read();
    await repo.close();
    return { staleCode, badCode, unconfirmedCode, staleResetCode,
      stillThere, imported, importedReceiptCount, reset };
  });
  expect(result.staleCode).toBe("conflict");
  expect(result.badCode).toBe("invalid-backup");
  expect(result.unconfirmedCode).toBe("conflict");
  expect(result.staleResetCode).toBe("conflict");
  expect(result.stillThere?.payload.results).toEqual([1, 2]);
  expect(result.imported.payload.results).toEqual([1]);
  expect(result.imported.payload.phase).toBe("paused");
  expect(result.imported.revision).toBe(2);
  expect(result.importedReceiptCount).toBe(0);
  expect(result.reset).toBeNull();
});

test("storage failure and corrupt canonical state never erase the last good snapshot", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: `demo-test-${Date.now()}-${Math.random()}`,
      validatePayload: (v: unknown): v is { points: number } => !!v && typeof v === "object" && typeof (v as { points?: unknown }).points === "number",
      recoverPaused: () => null });
    await repo.acquireWriter();
    await repo.commit(await repo.readCursor(), "g0:initial", { points: 1 });
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === "state" && (value as { payload?: { points?: number } })?.payload?.points === 9)
        throw new DOMException("simulated", "QuotaExceededError");
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    let quotaCode = "";
    try { await repo.commit({ generation: 0, revision: 0 }, "g0:failed", { points: 9 }); }
    catch (error) { quotaCode = (error as { code: string }).code; }
    finally { IDBObjectStore.prototype.put = original; }
    const afterQuota = await repo.read();
    if (!afterQuota) throw new Error("missing snapshot after quota failure");
    const originalClear = IDBObjectStore.prototype.clear;
    IDBObjectStore.prototype.clear = function () {
      if (this.name === "receipts") throw new DOMException("simulated", "QuotaExceededError");
      return originalClear.call(this);
    };
    let resetQuotaCode = "";
    try { await repo.reset({ confirm: true, expected: afterQuota }); }
    catch (error) { resetQuotaCode = (error as { code: string }).code; }
    finally { IDBObjectStore.prototype.clear = originalClear; }
    const afterFailedReset = await repo.read();
    const receiptCount = (JSON.parse(await repo.exportBackup()) as { receipts: unknown[] }).receipts.length;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open((repo as unknown as { name: string }).name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put({ nonsense: true }, "active");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    let corruptCode = "";
    try { await repo.read(); }
    catch (error) { corruptCode = (error as { code: string }).code; }
    await repo.close();
    return { quotaCode, afterQuota, resetQuotaCode, afterFailedReset, receiptCount, corruptCode };
  });
  expect(result.quotaCode).toBe("quota");
  expect(result.afterQuota?.payload.points).toBe(1);
  expect(result.resetQuotaCode).toBe("quota");
  expect(result.afterFailedReset?.payload.points).toBe(1);
  expect(result.receiptCount).toBe(1);
  expect(result.corruptCode).toBe("corrupt");
});

test("two browser profiles keep independent desk data even with the same database name", async ({ browser, page }) => {
  const databaseName = `demo-test-${crypto.randomUUID()}`;
  const otherContext = await browser.newContext();
  await otherContext.route("http://demo-storage.local/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Other profile</title>" }));
  const otherPage = await otherContext.newPage();
  await otherPage.goto("http://demo-storage.local/");
  await otherPage.addScriptTag({ content: storageBundle });
  const operate = async (target: typeof page, score: number) => target.evaluate(async ({ name, score }) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name,
      validatePayload: (v: unknown): v is { score: number } => !!v && typeof v === "object" && typeof (v as { score?: unknown }).score === "number",
      recoverPaused: () => null });
    const writer = await repo.acquireWriter();
    const result = await repo.commit(await repo.readCursor(), `g0:score-${score}`, { score });
    await repo.close();
    return { writer, score: result.snapshot.payload.score };
  }, { name: databaseName, score });
  try {
    expect(await operate(page, 1)).toEqual({ writer: true, score: 1 });
    expect(await operate(otherPage, 9)).toEqual({ writer: true, score: 9 });
  } finally {
    await otherContext.close();
  }
});

test("reset fences stale commands, previews and old command IDs across generations", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { DemoRepository, makeDemoCommandId } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: `demo-test-${Date.now()}-${Math.random()}`,
      validatePayload: (v: unknown): v is { name: string } => !!v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string",
      recoverPaused: () => null });
    await repo.acquireWriter();
    const original = await repo.commit(await repo.readCursor(), "g0:private-old-command-XYZ",
      { name: "PRIVATE_OLD_COMPETITOR_XYZ" });
    const preview = await repo.previewImport(await repo.exportBackup());
    const tombstone = await repo.reset({ confirm: true, expected: original.snapshot });
    const afterReset = { snapshot: await repo.read(), cursor: await repo.readCursor() };
    await new Promise((resolve) => setTimeout(resolve, 10));
    const fresh = await repo.commit(tombstone, makeDemoCommandId(tombstone.generation, "new-command"),
      { name: "new" });
    let staleCommand = "";
    try { await repo.commit(original.snapshot, "g0:stale-new-id", { name: "overwritten" }); }
    catch (error) { staleCommand = (error as { code: string }).code; }
    let reusedOldId = "";
    try { await repo.commit(fresh.snapshot, "g0:private-old-command-XYZ", { name: "overwritten" }); }
    catch (error) { reusedOldId = (error as { code: string }).code; }
    let untaggedId = "";
    try { await repo.commit(fresh.snapshot, "raw-id", { name: "overwritten" }); }
    catch (error) { untaggedId = (error as { code: string }).code; }
    let staleImport = "";
    try { await repo.importBackup(preview, { confirmOverwrite: true }); }
    catch (error) { staleImport = (error as { code: string }).code; }
    const final = await repo.read();
    const afterResetBackup = await repo.exportBackup();
    await repo.close();
    return { original, tombstone, afterReset, fresh, staleCommand, reusedOldId, untaggedId, staleImport,
      final, afterResetBackup };
  });
  expect(result.afterReset.snapshot).toBeNull();
  expect(result.afterReset.cursor).toEqual(result.tombstone);
  expect(result.tombstone).toEqual({ generation: 1, revision: 1 });
  expect(result.fresh.snapshot.generation).toBe(1);
  expect(result.fresh.snapshot.revision).toBe(2);
  expect(result.staleCommand).toBe("conflict");
  expect(result.reusedOldId).toBe("conflict");
  expect(result.untaggedId).toBe("conflict");
  expect(result.staleImport).toBe("conflict");
  expect(result.final?.payload.name).toBe("new");
  expect(result.afterResetBackup).not.toContain("PRIVATE_OLD_COMPETITOR_XYZ");
  expect(result.afterResetBackup).not.toContain("private-old-command-XYZ");
  expect(result.afterResetBackup).not.toContain(result.original.receipt.committedAt);
  expect((JSON.parse(result.afterResetBackup) as { receipts: unknown[] }).receipts).toHaveLength(1);
});

test("closing during writer acquisition leaves no late lease", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const name = `demo-test-${Date.now()}-${Math.random()}`;
    const options = { databaseName: name,
      validatePayload: (v: unknown): v is { name: string } => !!v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string",
      recoverPaused: () => null };
    const closingRepo = new DemoRepository(options);
    const acquisition = closingRepo.acquireWriter();
    const closing = closingRepo.close();
    const acquiredAfterClose = await acquisition;
    await closing;
    const freshRepo = new DemoRepository(options);
    const freshWriter = await freshRepo.acquireWriter();
    await freshRepo.close();
    return { acquiredAfterClose, freshWriter, lateWriter: closingRepo.isWriter };
  });
  expect(result.acquiredAfterClose).toBe(false);
  expect(result.lateWriter).toBe(false);
  expect(result.freshWriter).toBe(true);
});

test("same tab reload reclaims its lease immediately and continues the finished demo offline", async ({ context, page }) => {
  const databaseName = `demo-test-${crypto.randomUUID()}`;
  await page.evaluate(async (name) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name,
      validatePayload: (v: unknown): v is { result: string; points: number } =>
        !!v && typeof v === "object" && typeof (v as { result?: unknown }).result === "string" &&
        typeof (v as { points?: unknown }).points === "number",
      recoverPaused: () => null });
    await repo.acquireWriter();
    await repo.commit(await repo.readCursor(), "g0:finished", { result: "red", points: 3 });
    // Reload without await repo.close(): the old page may leave an unexpired lease.
  }, databaseName);
  await page.reload();
  await page.addScriptTag({ content: storageBundle });
  await context.setOffline(true);
  try {
    const result = await page.evaluate(async (name) => {
      const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
      const repo = new DemoRepository({ databaseName: name,
        validatePayload: (v: unknown): v is { result: string; points: number } =>
          !!v && typeof v === "object" && typeof (v as { result?: unknown }).result === "string" &&
          typeof (v as { points?: unknown }).points === "number",
        recoverPaused: () => null });
      const started = Date.now();
      const writer = await repo.acquireWriter();
      const elapsed = Date.now() - started;
      const before = await repo.read();
      const after = before && await repo.commit(before, "g0:offline-next", { result: "red", points: 4 });
      await repo.close();
      return { writer, elapsed, before, after };
    }, databaseName);
    expect(result.writer).toBe(true);
    expect(result.elapsed).toBeLessThan(2_000);
    expect(result.before?.payload).toEqual({ result: "red", points: 3 });
    expect(result.after?.snapshot.payload.points).toBe(4);
  } finally { await context.setOffline(false); }
});

test("a live second tab with cloned sessionStorage remains read-only and stale commands are fenced", async ({ context, page }) => {
  const databaseName = `demo-test-${crypto.randomUUID()}`;
  await page.evaluate(async (name) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name,
      validatePayload: (v: unknown): v is { score: number } => !!v && typeof v === "object" && typeof (v as { score?: unknown }).score === "number",
      recoverPaused: () => null });
    (window as unknown as { testRepo: typeof repo }).testRepo = repo;
    await repo.acquireWriter();
    await repo.commit(await repo.readCursor(), "g0:first", { score: 1 });
  }, databaseName);
  const token = await page.evaluate(() => sessionStorage.getItem("tkdfight-browser-desk-v2:tab-id"));
  if (!token) throw new Error("missing tab identity");
  const ownerId = await page.evaluate(() =>
    (window as unknown as { testRepo: { ownerId: string } }).testRepo.ownerId);
  const second = await context.newPage();
  await second.goto("http://demo-storage.local/");
  await second.evaluate(({ token, ownerId, name }) => {
    sessionStorage.setItem("tkdfight-browser-desk-v2:tab-id", token);
    // Even a stale cloned navigation marker must not displace a responsive live owner.
    sessionStorage.setItem(`${name}:retired-owner`, ownerId);
  }, { token, ownerId, name: databaseName });
  await second.addScriptTag({ content: storageBundle });
  try {
    const blocked = await second.evaluate(async (name) => {
      const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
      const repo = new DemoRepository({ databaseName: name,
        validatePayload: (v: unknown): v is { score: number } => !!v && typeof v === "object" && typeof (v as { score?: unknown }).score === "number",
        recoverPaused: () => null });
      (window as unknown as { testRepo: typeof repo }).testRepo = repo;
      const acquired = await repo.acquireWriter();
      const stale = await repo.read();
      return { acquired, stale };
    }, databaseName);
    expect(blocked.acquired).toBe(false);
    expect(blocked.stale?.payload.score).toBe(1);
    if (!blocked.stale) throw new Error("missing read-only snapshot");
    const current = await page.evaluate(async () => {
      const repo = (window as unknown as { testRepo: import("../src/demo/storage").DemoRepository<{ score: number }> }).testRepo;
      const snapshot = await repo.read();
      if (!snapshot) throw new Error("missing original snapshot");
      const committed = await repo.commit(snapshot, "g0:second", { score: 2 });
      await repo.close();
      return committed.snapshot;
    });
    const takeover = await second.evaluate(async ({ stale }) => {
      const repo = (window as unknown as { testRepo: import("../src/demo/storage").DemoRepository<{ score: number }> }).testRepo;
      const acquired = await repo.acquireWriter();
      let staleCode = "";
      try { await repo.commit(stale, "g0:stale", { score: 9 }); }
      catch (error) { staleCode = (error as { code: string }).code; }
      const final = await repo.read();
      await repo.close();
      return { acquired, staleCode, final };
    }, { stale: blocked.stale });
    expect(current.payload.score).toBe(2);
    expect(takeover.acquired).toBe(true);
    expect(takeover.staleCode).toBe("conflict");
    expect(takeover.final?.payload.score).toBe(2);
  } finally { await second.close(); }
});

test("an idle read-only tab automatically recovers a crashed writer within fifteen seconds", async ({ context, page }) => {
  test.setTimeout(25_000);
  const databaseName = `demo-test-${crypto.randomUUID()}`;
  await page.evaluate(async (name) => {
    const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
    const repo = new DemoRepository({ databaseName: name,
      validatePayload: (v: unknown): v is { phase: string } => !!v && typeof v === "object" && typeof (v as { phase?: unknown }).phase === "string",
      recoverPaused: (v: { phase: string }) => v.phase === "running" ? { phase: "paused" } : null });
    await repo.acquireWriter();
    await repo.commit(await repo.readCursor(), "g0:running", { phase: "running" });
  }, databaseName);
  const second = await context.newPage();
  await second.goto("http://demo-storage.local/");
  await second.addScriptTag({ content: storageBundle });
  try {
    const blocked = await second.evaluate(async (name) => {
      const { DemoRepository } = (window as unknown as { DemoStorage: typeof import("../src/demo/storage") }).DemoStorage;
      const repo = new DemoRepository({ databaseName: name,
        validatePayload: (v: unknown): v is { phase: string } => !!v && typeof v === "object" && typeof (v as { phase?: unknown }).phase === "string",
        recoverPaused: (v: { phase: string }) => v.phase === "running" ? { phase: "paused" } : null });
      (window as unknown as { testRepo: typeof repo }).testRepo = repo;
      return repo.acquireWriter();
    }, databaseName);
    expect(blocked).toBe(false);
    const crashAt = Date.now();
    await page.close();
    await expect.poll(() => second.evaluate(() =>
      (window as unknown as { testRepo: { isWriter: boolean } }).testRepo.isWriter),
      { timeout: 15_000, intervals: [250] }).toBe(true);
    const recovered = await second.evaluate(async () => {
      const repo = (window as unknown as { testRepo: import("../src/demo/storage").DemoRepository<{ phase: string }> }).testRepo;
      const snapshot = await repo.read();
      await repo.close();
      return snapshot;
    });
    expect(Date.now() - crashAt).toBeLessThan(15_000);
    expect(recovered?.payload.phase).toBe("paused");
  } finally { await second.close(); }
});
