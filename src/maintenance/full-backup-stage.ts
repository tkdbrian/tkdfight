import {
  BACKUP_PENDING_MARKER,
  readBrowserKeys,
  writeBrowserKeys,
} from "@/lib/full-backup-browser";
import type { BackupPayload } from "@/lib/full-backup-contract";
import { canonicalJson, sha256Hex } from "@/lib/full-backup-contract";

export interface RestoreStage {
  raw: string;
  backupId: string;
  payloadHash: string;
  browserHash: string;
  browser: BackupPayload["browser"];
  originals: BackupPayload["browser"];
}

function openStage(indexedDb: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!indexedDb) return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDb.open("tkd-backup-recovery-v1", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("restore"))
        request.result.createObjectStore("restore");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

export async function writeRestoreStage(
  stage: RestoreStage,
  indexedDb = globalThis.indexedDB
): Promise<void> {
  const database = await openStage(indexedDb);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("restore", "readwrite");
      tx.objectStore("restore").put(stage, "pending");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB stage failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB stage aborted"));
    });
  } finally {
    database.close();
  }
}

export async function readRestoreStage(
  indexedDb = globalThis.indexedDB
): Promise<RestoreStage | null> {
  const database = await openStage(indexedDb);
  try {
    return await new Promise<RestoreStage | null>((resolve, reject) => {
      const request = database
        .transaction("restore", "readonly")
        .objectStore("restore")
        .get("pending");
      request.onsuccess = () => resolve((request.result as RestoreStage | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
  } finally {
    database.close();
  }
}

export async function clearRestoreStage(indexedDb = globalThis.indexedDB): Promise<void> {
  const database = await openStage(indexedDb);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("restore", "readwrite");
      tx.objectStore("restore").delete("pending");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB clear failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB clear aborted"));
    });
  } finally {
    database.close();
  }
}

export async function rollbackUncommittedRestore(
  stage: RestoreStage,
  storage: Storage,
  indexedDb = globalThis.indexedDB
): Promise<void> {
  writeBrowserKeys(storage, stage.originals);
  const expected = await sha256Hex(canonicalJson(stage.originals));
  const actual = await sha256Hex(canonicalJson(readBrowserKeys(storage)));
  if (actual !== expected)
    throw new Error("No se pudo verificar el navegador anterior. Restauración bloqueada.");
  storage.removeItem(BACKUP_PENDING_MARKER);
  await clearRestoreStage(indexedDb);
}
