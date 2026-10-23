import { expect, it } from "vitest";
import { BACKUP_PENDING_MARKER } from "@/lib/full-backup-browser";
import {
  clearRestoreStage,
  readRestoreStage,
  rollbackUncommittedRestore,
  writeRestoreStage,
} from "./full-backup-stage";

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

it("fails closed when durable browser staging is unavailable", async () => {
  await expect(readRestoreStage(undefined)).rejects.toThrow("IndexedDB");
});

it("does not acknowledge a failed IndexedDB stage write", async () => {
  const request = {
    result: null,
    error: new DOMException("quota", "QuotaExceededError"),
    onerror: null as null | (() => void),
  };
  const factory = {
    open: () => {
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  } as unknown as IDBFactory;
  const empty = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  await expect(
    writeRestoreStage(
      {
        raw: "{}",
        backupId: "b",
        payloadHash: "p",
        browserHash: "h",
        browser: empty,
        originals: empty,
      },
      factory
    )
  ).rejects.toThrow("quota");
});

it("durably stages, reads back, and clears a recovery payload", async () => {
  const indexedDb = fakeIndexedDb();
  const browser = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  const stage = {
    raw: "full backup bytes",
    backupId: "id",
    payloadHash: "payload",
    browserHash: "browser",
    browser,
    originals: browser,
  };
  await writeRestoreStage(stage, indexedDb);
  expect(await readRestoreStage(indexedDb)).toEqual(stage);
  await clearRestoreStage(indexedDb);
  expect(await readRestoreStage(indexedDb)).toBeNull();
});

it("retains IndexedDB recovery if rollback cannot clear its pending marker", async () => {
  const indexedDb = fakeIndexedDb();
  const empty = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  const stage = {
    raw: "bytes",
    backupId: "id",
    payloadHash: "hash",
    browserHash: "browser",
    browser: empty,
    originals: empty,
  };
  await writeRestoreStage(stage, indexedDb);
  const values = new Map<string, string>([[BACKUP_PENDING_MARKER, "pending"]]);
  const storage = {
    get length() {
      return values.size;
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      if (key === BACKUP_PENDING_MARKER) throw new Error("storage fault");
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
  } as Storage;
  await expect(rollbackUncommittedRestore(stage, storage, indexedDb)).rejects.toThrow(
    "storage fault"
  );
  expect(storage.getItem(BACKUP_PENDING_MARKER)).toBe("pending");
  expect(await readRestoreStage(indexedDb)).toEqual(stage);
});

it("refuses rollback cleanup if original browser keys cannot be read back", async () => {
  const indexedDb = fakeIndexedDb();
  const empty = {
    "tkd-tournament": null,
    "tkd-tournament-categories": null,
    "tkd-category-deletions-v1": null,
    "tkd-retired-category-sources-v1": null,
  };
  const stage = {
    raw: "bytes",
    backupId: "id",
    payloadHash: "hash",
    browserHash: "browser",
    browser: empty,
    originals: empty,
  };
  await writeRestoreStage(stage, indexedDb);
  const storage = {
    get length() {
      return 1;
    },
    getItem: (key: string) => (key === BACKUP_PENDING_MARKER ? "pending" : "corrupt"),
    setItem: () => {},
    removeItem: (key: string) => {
      if (key === BACKUP_PENDING_MARKER) throw new Error("marker must remain");
    },
    key: () => BACKUP_PENDING_MARKER,
    clear: () => {},
  } as Storage;
  await expect(rollbackUncommittedRestore(stage, storage, indexedDb)).rejects.toThrow("verificar");
  expect(await readRestoreStage(indexedDb)).toEqual(stage);
});
