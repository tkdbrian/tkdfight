import { waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BACKUP_PENDING_MARKER } from "@/lib/full-backup-browser";
import { canonicalJson, createBackupEnvelope, sha256Hex } from "@/lib/full-backup-contract";
import { mountBackupMaintenance } from "./full-backup-maintenance";
import { readRestoreStage, writeRestoreStage } from "./full-backup-stage";

function fakeIndexedDb(): IDBFactory {
  const values = new Map<string, unknown>();
  let created = false;
  const database = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => {
      created = true;
    },
    close: () => {},
    transaction: () => {
      const tx = {
        oncomplete: null as null | (() => void),
        onerror: null,
        onabort: null,
        objectStore: () => ({
          put: (value: unknown, key: string) => {
            values.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
          },
          delete: (key: string) => {
            values.delete(key);
            queueMicrotask(() => tx.oncomplete?.());
          },
          get: (key: string) => {
            const request = {
              result: undefined as unknown,
              onsuccess: null as null | (() => void),
              onerror: null,
              error: null,
            };
            queueMicrotask(() => {
              request.result = values.get(key);
              request.onsuccess?.();
            });
            return request;
          },
        }),
      };
      return tx;
    },
  };
  return {
    open: () => {
      const request = {
        result: database,
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null,
        error: null,
      };
      queueMicrotask(() => {
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
}

it("leaves export and restore disabled without Web Locks or IndexedDB", async () => {
  const mount = document.createElement("div");
  vi.stubGlobal("indexedDB", undefined);
  await mountBackupMaintenance(mount);
  const buttons = [...mount.querySelectorAll("button")];
  expect(buttons).toHaveLength(3);
  expect(buttons.every((button) => button.disabled)).toBe(true);
  expect(mount.textContent).toContain("Bloqueado");
  vi.unstubAllGlobals();
});

it("recovers a pending SQL receipt from staged IndexedDB browser keys", async () => {
  localStorage.clear();
  sessionStorage.clear();
  const meta = document.createElement("meta");
  meta.name = "tkd-build-id";
  meta.content = "fixture";
  document.head.append(meta);
  const indexedDb = fakeIndexedDb();
  const browser = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  const envelope = await createBackupEnvelope(
    { sql: { tables: {}, sequences: {} }, browser },
    "fixture",
    "T1",
    "backup-1",
    "2026-10-23T00:00:00.000Z"
  );
  const stage = {
    raw: JSON.stringify(envelope),
    backupId: envelope.backupId,
    payloadHash: envelope.payloadHash,
    browserHash: await sha256Hex(canonicalJson(browser)),
    browser,
    originals: browser,
  };
  await writeRestoreStage(stage, indexedDb);
  localStorage.setItem(BACKUP_PENDING_MARKER, JSON.stringify({ backupId: stage.backupId }));
  const receipt = {
    backup_id: stage.backupId,
    payload_hash: stage.payloadHash,
    browser_hash: stage.browserHash,
    status: "pending",
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/status"))
      return {
        ok: true,
        json: async () => ({
          buildId: "fixture",
          role: "T1",
          receipt,
          leaseActive: false,
          idle: true,
        }),
      };
    if (url.endsWith("/begin")) return { ok: true, json: async () => ({ token: "lease" }) };
    if (url.endsWith("/complete"))
      return {
        ok: true,
        json: async () => ({
          receipt: { ...receipt, status: "complete" },
        }),
      };
    throw new Error(`Unexpected ${url} ${init?.method}`);
  });
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock) => Promise<void>
      ) => callback({ name: "tkd-tournament-operation" } as Lock),
    },
  });
  vi.stubGlobal("indexedDB", indexedDb);
  vi.stubGlobal("fetch", fetcher);
  const removeItem = Storage.prototype.removeItem;
  let failMarkerRemoval = true;
  const removal = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
    this: Storage,
    key: string
  ) {
    if (key === BACKUP_PENDING_MARKER && failMarkerRemoval)
      throw new Error("simulated marker storage failure");
    removeItem.call(this, key);
  });
  try {
    const mount = document.createElement("div");
    await mountBackupMaintenance(mount);
    const retry = [...mount.querySelectorAll("button")][2];
    expect(retry.disabled).toBe(false);
    retry.click();
    await waitFor(() => expect(mount.textContent).toContain("simulated marker storage failure"));
    expect(await readRestoreStage(indexedDb)).not.toBeNull();
    expect(localStorage.getItem(BACKUP_PENDING_MARKER)).not.toBeNull();
    failMarkerRemoval = false;
    retry.click();
    await waitFor(() => expect(localStorage.getItem(BACKUP_PENDING_MARKER)).toBeNull());
    expect(await readRestoreStage(indexedDb)).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/complete"))).toBe(true);
  } finally {
    removal.mockRestore();
    if (original) Object.defineProperty(navigator, "locks", original);
    else Reflect.deleteProperty(navigator, "locks");
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    meta.remove();
  }
});

it("enables maintenance only after acquiring an exclusive cross-tab lock", async () => {
  const mount = document.createElement("div");
  const meta = document.createElement("meta");
  meta.name = "tkd-build-id";
  meta.content = "fixture";
  document.head.append(meta);
  const request = vi.fn(
    async (_name: string, _options: LockOptions, callback: (lock: Lock) => Promise<void>) =>
      callback({ name: "tkd-tournament-operation" } as Lock)
  );
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        buildId: "fixture",
        role: "T1",
        leaseActive: false,
        receipt: null,
        idle: true,
      }),
    }))
  );
  try {
    await mountBackupMaintenance(mount);
    expect(request).toHaveBeenCalledWith(
      "tkd-tournament-operation",
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function)
    );
    const buttons = [...mount.querySelectorAll("button")];
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(true);
  } finally {
    if (original) Object.defineProperty(navigator, "locks", original);
    else Reflect.deleteProperty(navigator, "locks");
    vi.unstubAllGlobals();
    meta.remove();
  }
});
