import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";

let runtimeBundle = "";

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [resolve(process.cwd(), "src/demo/runtime/index.ts")],
    alias: { "@": resolve(process.cwd(), "src") },
    bundle: true, format: "iife", globalName: "DemoRuntime", platform: "browser",
    target: "es2022", write: false,
  });
  runtimeBundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ context, page }) => {
  await context.route("http://localhost:8765/**", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Desk runtime</title>",
  }));
  await page.goto("http://localhost:8765/");
  await page.addScriptTag({ content: runtimeBundle });
});

test("same browser keeps a fight paused after reopen; another tab is read-only", async ({ context, page }) => {
  const databaseName = `desk-runtime-${crypto.randomUUID()}`;
  const first = await page.evaluate(async (name) => {
    const { createBrowserDeskRuntime, makeDemoCommandId } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime({ databaseName: name });
    let view = await runtime.open();
    const id = (nonce: string) => makeDemoCommandId(view.generation, nonce);
    view = await runtime.dispatch({ type: "category/create", categoryId: "cat-1" }, id("create-1"));
    view = await runtime.dispatch({ type: "category/configure", categoryId: "cat-1",
      patch: { categoryName: "A", mode: "round-robin" } }, id("configure-1"));
    for (let index = 1; index <= 3; index++) {
      view = await runtime.dispatch({ type: "category/addCompetitor", categoryId: "cat-1",
        competitor: { name: `C${index}` }, competitorId: `C${index}` }, id(`competitor-${index}`));
    }
    view = await runtime.dispatch({ type: "category/start", categoryId: "cat-1" }, id("start-category"));
    const fightId = view.state.categories["cat-1"].fights[0].id;
    view = await runtime.dispatch({ type: "fight/load", categoryId: "cat-1", fightId }, id("load-1"));
    const loadId = view.state.active!.loadId;
    view = await runtime.dispatch({ type: "fight/start", categoryId: "cat-1", fightId, loadId }, id("start-fight"));
    view = await runtime.dispatch({ type: "fight/tick", categoryId: "cat-1", fightId, loadId }, id("tick-1"));
    (window as unknown as { desk: typeof runtime }).desk = runtime;
    return { fightId, phase: view.state.active?.state.phase, timeLeft: view.state.active?.state.timeLeft };
  }, databaseName);
  expect(first.phase).toBe("round");
  expect(first.timeLeft).toBe(59);

  const second = await context.newPage();
  await second.goto("http://localhost:8765/");
  await second.addScriptTag({ content: runtimeBundle });
  const readonly = await second.evaluate(async (name) => {
    const { createBrowserDeskRuntime, makeDemoCommandId } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime({ databaseName: name });
    const view = await runtime.open();
    let error = "";
    try { await runtime.dispatch({ type: "category/create" }, makeDemoCommandId(view.generation, "forbidden")); }
    catch (cause) { error = (cause as { code?: string }).code ?? "unknown"; }
    await runtime.close();
    return { writer: view.isWriter, categories: view.state.categoryOrder.length, error };
  }, databaseName);
  expect(readonly).toEqual({ writer: false, categories: 1, error: "read-only" });

  await page.evaluate(async () => {
    await (window as unknown as { desk: { close(): Promise<void> } }).desk.close();
  });
  const reopened = await page.evaluate(async (name) => {
    const { createBrowserDeskRuntime } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime({ databaseName: name });
    const view = await runtime.open();
    await runtime.close();
    return { phase: view.state.active?.state.phase, paused: view.state.active?.paused,
      timeLeft: view.state.active?.state.timeLeft };
  }, databaseName);
  expect(reopened).toEqual({ phase: "round", paused: true, timeLeft: 59 });
  await second.close();
});

test("a retried swap does not invert twice and old-generation commands cannot cross reset/import", async ({ page }) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createBrowserDeskRuntime, makeDemoCommandId } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime({ databaseName });
    let view = await runtime.open();
    view = await runtime.dispatch({ type: "category/create", categoryId: "cat-2" });
    view = await runtime.dispatch({ type: "category/configure", categoryId: "cat-2",
      patch: { categoryName: "B" } });
    for (let index = 1; index <= 3; index++) view = await runtime.dispatch({
      type: "category/addCompetitor", categoryId: "cat-2",
      competitor: { name: `Atleta ${index}` }, competitorId: `A${index}`,
    });
    view = await runtime.dispatch({ type: "category/start", categoryId: "cat-2" });
    const fightId = view.state.categories["cat-2"].fights[0].id;
    view = await runtime.dispatch({ type: "fight/load", categoryId: "cat-2", fightId });
    const loaded = view.state.active!;
    const swap = { type: "fight/swap" as const, categoryId: "cat-2", fightId,
      loadId: loaded.loadId, assignmentRevision: 0,
      expectedRedId: loaded.red.id, expectedBlueId: loaded.blue.id };
    const swapId = makeDemoCommandId(view.generation, "swap-once");
    const oldPendingId = makeDemoCommandId(view.generation, "pending-category-create");
    view = await runtime.dispatch(swap, swapId);
    const afterFirst = view.state.active!.red.id;
    view = await runtime.dispatch(swap, swapId);
    const afterRetry = view.state.active!.red.id;
    const backup = await runtime.exportBackup();
    const beforeResetGeneration = view.generation;
    view = await runtime.reset({ confirm: true });
    const emptyCategories = view.state.categoryOrder.length;
    const afterResetGeneration = view.generation;
    let staleReceiptRejected = false;
    try { await runtime.dispatch(swap, swapId); }
    catch { staleReceiptRejected = true; }
    let oldPendingRejected = false;
    try { await runtime.dispatch({ type: "category/create", categoryId: "stale-category" }, oldPendingId); }
    catch (error) { oldPendingRejected = (error as { code?: string }).code === "conflict"; }
    let rawRejected = false;
    try { await runtime.dispatch({ type: "category/create", categoryId: "raw-category" }, "raw-uuid"); }
    catch (error) { rawRejected = (error as { code?: string }).code === "conflict"; }
    const stillEmpty = (await runtime.read()).state.categoryOrder.length === 0;
    const preview = await runtime.previewImport(backup);
    view = await runtime.importBackup(preview, { confirmOverwrite: true });
    const afterImportGeneration = view.generation;
    let oldAfterImportRejected = false;
    try { await runtime.dispatch({ type: "category/create", categoryId: "stale-import" }, oldPendingId); }
    catch (error) { oldAfterImportRejected = (error as { code?: string }).code === "conflict"; }
    view = await runtime.dispatch({ type: "category/select", categoryId: "cat-2" });
    const postImportDispatch = view.generation === afterImportGeneration
      && view.state.selectedCategoryId === "cat-2";
    await runtime.close();
    return { afterFirst, afterRetry, expected: loaded.blue.id,
      emptyCategories, beforeResetGeneration, afterResetGeneration,
      afterImportGeneration,
      staleReceiptRejected, oldPendingRejected, oldAfterImportRejected, rawRejected, stillEmpty,
      postImportDispatch,
      restoredRed: view.state.active?.red.id,
      restoredCategories: view.state.categoryOrder.length };
  }, `desk-runtime-${crypto.randomUUID()}`);
  expect(result.afterFirst).toBe(result.expected);
  expect(result.afterRetry).toBe(result.expected);
  expect(result.emptyCategories).toBe(0);
  expect(result.afterResetGeneration).toBeGreaterThan(result.beforeResetGeneration);
  expect(result.afterImportGeneration).toBeGreaterThan(result.afterResetGeneration);
  expect(result.staleReceiptRejected).toBe(true);
  expect(result.oldPendingRejected).toBe(true);
  expect(result.oldAfterImportRejected).toBe(true);
  expect(result.rawRejected).toBe(true);
  expect(result.stillEmpty).toBe(true);
  expect(result.postImportDispatch).toBe(true);
  expect(result.restoredRed).toBe(result.expected);
  expect(result.restoredCategories).toBe(1);
});

test("reset is idempotent, fences stale bout commands, and permits restarting", async ({ page }) => {
  const result = await page.evaluate(async (databaseName) => {
    const { createBrowserDeskRuntime, makeDemoCommandId } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime({ databaseName });
    let view = await runtime.open();
    view = await runtime.dispatch({ type: "category/create", categoryId: "cat-reset" });
    view = await runtime.dispatch({ type: "category/configure", categoryId: "cat-reset",
      patch: { categoryName: "Reinicio" } });
    for (let index = 1; index <= 3; index++) view = await runtime.dispatch({
      type: "category/addCompetitor", categoryId: "cat-reset",
      competitor: { name: `Atleta ${index}` }, competitorId: `R${index}`,
    });
    view = await runtime.dispatch({ type: "category/start", categoryId: "cat-reset" });
    const fightId = view.state.categories["cat-reset"].fights[0].id;
    view = await runtime.dispatch({ type: "fight/load", categoryId: "cat-reset", fightId });
    const old = { categoryId: "cat-reset", fightId, loadId: view.state.active!.loadId };
    const firstStartId = makeDemoCommandId(view.generation, "first-start");
    const resetId = makeDemoCommandId(view.generation, "reset-once");
    view = await runtime.dispatch({ type: "fight/start", ...old }, firstStartId);
    view = await runtime.dispatch({ type: "fight/vote", ...old, judgeId: "J1", vote: "red" });
    view = await runtime.dispatch({ type: "fight/reset", ...old }, resetId);
    const resetRevision = view.revision;
    const newLoadId = view.state.active!.loadId;
    const clean = view.state.active!.state.phase === "idle"
      && Object.keys(view.state.active!.judgeVotes).length === 0;
    view = await runtime.dispatch({ type: "fight/reset", ...old }, resetId);
    const replayRevision = view.revision;
    let staleRejected = false;
    try { await runtime.dispatch({ type: "fight/start", ...old }, makeDemoCommandId(view.generation, "stale-start")); }
    catch (error) { staleRejected = (error as { code?: string }).code === "stale"; }
    view = await runtime.dispatch({ type: "fight/start", categoryId: "cat-reset", fightId,
      loadId: newLoadId }, makeDemoCommandId(view.generation, "restart"));
    await runtime.close();
    return { clean, stickyStarted: view.state.active?.started, oldLoadId: old.loadId,
      newLoadId, resetRevision, replayRevision, staleRejected,
      phase: view.state.active?.state.phase, finalRevision: view.revision };
  }, `desk-runtime-${crypto.randomUUID()}`);
  expect(result.clean).toBe(true);
  expect(result.stickyStarted).toBe(true);
  expect(result.newLoadId).not.toBe(result.oldLoadId);
  expect(result.replayRevision).toBe(result.resetRevision);
  expect(result.staleRejected).toBe(true);
  expect(result.phase).toBe("round");
  expect(result.finalRevision).toBe(result.resetRevision + 1);
});

test("two browser profiles have independent default desks and invalid import cannot replace one", async ({ browser, page }) => {
  const first = await page.evaluate(async () => {
    const { createBrowserDeskRuntime } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime();
    await runtime.open();
    const view = await runtime.dispatch({ type: "category/create", categoryId: "private-A" });
    (window as unknown as { desk: typeof runtime }).desk = runtime;
    return view.state.categoryOrder;
  });
  expect(first).toEqual(["private-A"]);

  const otherContext = await browser.newContext();
  await otherContext.route("http://localhost:8765/**", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>Other desk</title>",
  }));
  const otherPage = await otherContext.newPage();
  await otherPage.goto("http://localhost:8765/");
  await otherPage.addScriptTag({ content: runtimeBundle });
  const other = await otherPage.evaluate(async () => {
    const { createBrowserDeskRuntime } = (window as unknown as {
      DemoRuntime: typeof import("../src/demo/runtime")
    }).DemoRuntime;
    const runtime = createBrowserDeskRuntime();
    let view = await runtime.open();
    const before = view.state.categoryOrder;
    view = await runtime.dispatch({ type: "category/create", categoryId: "private-B" });
    const after = view.state.categoryOrder;
    await runtime.close();
    return { before, after };
  });
  expect(other).toEqual({ before: [], after: ["private-B"] });
  await otherContext.close();

  const verified = await page.evaluate(async () => {
    const runtime = (window as unknown as { desk: import("../src/demo/runtime").DeskRuntime }).desk;
    const before = await runtime.read();
    const raw = JSON.parse(await runtime.exportBackup()) as { snapshot: { payload: { categories: Record<string, unknown> } } };
    delete raw.snapshot.payload.categories["private-A"];
    let rejected = false;
    try { await runtime.previewImport(JSON.stringify(raw)); }
    catch { rejected = true; }
    const after = await runtime.read();
    await runtime.close();
    return { rejected, before: before.state.categoryOrder, after: after.state.categoryOrder };
  });
  expect(verified).toEqual({ rejected: true, before: ["private-A"], after: ["private-A"] });
});
