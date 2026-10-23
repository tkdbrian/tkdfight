import { z } from "zod";
import {
  assertBrowserIdle,
  assertPristineBrowser,
  BACKUP_PENDING_MARKER,
  readBrowserKeys,
  writeBrowserKeys,
} from "@/lib/full-backup-browser";
import { indexBuildId, verifyBuildIdentity } from "@/lib/full-backup-build-id";
import type { BackupEnvelope, BackupRole } from "@/lib/full-backup-contract";
import {
  BACKUP_MAX_BYTES,
  canonicalJson,
  parseBackupEnvelope,
  sha256Hex,
} from "@/lib/full-backup-contract";
import type { RestoreStage } from "./full-backup-stage";
import {
  clearRestoreStage,
  readRestoreStage,
  rollbackUncommittedRestore,
  writeRestoreStage,
} from "./full-backup-stage";

interface Receipt {
  backup_id: string;
  payload_hash: string;
  browser_hash: string;
  status: "pending" | "complete";
}
interface ServerStatus {
  buildId: string | null;
  role: BackupRole | null;
  leaseActive: boolean;
  receipt: Receipt | null;
  idle: boolean;
}

const TOKEN_KEY = "tkd-backup-lease-session-v1";

async function status(): Promise<ServerStatus> {
  const response = await fetch("/api/backup/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Estado de respaldo inaccesible desde este equipo");
  const result = (await response.json()) as ServerStatus;
  verifyBuildIdentity(result.buildId, indexBuildId(), true);
  if (!z.enum(["T1", "T2", "T3", "MC"]).safeParse(result.role).success)
    throw new Error("El servidor no acredita la identidad de este tatami");
  return result;
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/backup/${endpoint}`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result
        ? String((result as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return result as T;
}

async function begin(recoveryBackupId?: string): Promise<string> {
  const existing = sessionStorage.getItem(TOKEN_KEY);
  if (existing && (await status()).leaseActive) return existing;
  const result = await post<{ token: string }>(
    "begin",
    recoveryBackupId ? { recoveryBackupId } : {}
  );
  sessionStorage.setItem(TOKEN_KEY, result.token);
  return result.token;
}

async function abort(token: string): Promise<void> {
  await post("complete", { token, abort: true });
  sessionStorage.removeItem(TOKEN_KEY);
}

async function exclusiveWebLock(): Promise<void> {
  if (!navigator.locks || !globalThis.indexedDB)
    throw new Error("Este navegador necesita Web Locks e IndexedDB para un respaldo seguro");
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(
        "tkd-tournament-operation",
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject(new Error("Cierre las otras pestañas del torneo y vuelva a intentar"));
            return;
          }
          resolve();
          await new Promise<void>(() => {});
        }
      )
      .catch(reject);
  });
}

function verifyReceipt(receipt: Receipt | null, stage: RestoreStage): boolean {
  return (
    !!receipt &&
    receipt.backup_id === stage.backupId &&
    receipt.payload_hash === stage.payloadHash &&
    receipt.browser_hash === stage.browserHash
  );
}

async function browserHash(): Promise<string> {
  return sha256Hex(canonicalJson(readBrowserKeys(localStorage)));
}

async function finishRestore(token: string, stage: RestoreStage): Promise<void> {
  if ((await browserHash()) !== stage.browserHash)
    throw new Error("La lectura del navegador no coincide con el respaldo. Inicio bloqueado.");
  const server = await status();
  if (!verifyReceipt(server.receipt, stage)) throw new Error("Recibo SQL ausente o no coincide");
  const result = await post<{ receipt: Receipt }>("complete", {
    token,
    backupId: stage.backupId,
    payloadHash: stage.payloadHash,
    browserHash: stage.browserHash,
  });
  if (!verifyReceipt(result.receipt, stage) || result.receipt.status !== "complete")
    throw new Error("El servidor no confirmó el respaldo restaurado");
  localStorage.removeItem(BACKUP_PENDING_MARKER);
  await clearRestoreStage();
  sessionStorage.removeItem(TOKEN_KEY);
  location.assign("/");
}

async function recoverRestore(): Promise<void> {
  const stage = await readRestoreStage();
  if (!stage) throw new Error("Marcador de restauración sin datos IndexedDB: no se puede iniciar");
  const server = await status();
  if (!server.buildId) throw new Error("Falta ID de compilación del paquete");
  if (!server.role) throw new Error("Tatami sin identidad");
  const backup = await parseBackupEnvelope(stage.raw, server.buildId, server.role);
  if (
    backup.backupId !== stage.backupId ||
    backup.payloadHash !== stage.payloadHash ||
    (await sha256Hex(canonicalJson(backup.payload.browser))) !== stage.browserHash
  )
    throw new Error("Etapa IndexedDB dañada; no se puede reanudar");
  if (server.receipt && !verifyReceipt(server.receipt, stage))
    throw new Error("El recibo SQL corresponde a otro respaldo: inicio bloqueado");
  const token = await begin(server.receipt?.status === "pending" ? stage.backupId : undefined);
  writeBrowserKeys(localStorage, stage.browser);
  if ((await browserHash()) !== stage.browserHash)
    throw new Error("No se pudo verificar el navegador");
  if (!server.receipt) {
    try {
      await post("restore", { token, backup: stage.raw });
    } catch (error) {
      const updated = await status();
      if (!verifyReceipt(updated.receipt, stage)) throw error;
    }
  }
  await finishRestore(token, stage);
}

async function backupToFile(): Promise<void> {
  assertBrowserIdle(localStorage);
  const server = await status();
  if (!server.buildId || !server.role || !server.idle || server.receipt?.status === "pending")
    throw new Error("Paquete sin ID o torneo no libre para respaldo");
  const token = await begin();
  try {
    const envelope = await post<BackupEnvelope>("export", {
      token,
      browser: readBrowserKeys(localStorage),
    });
    const raw = JSON.stringify(envelope);
    await parseBackupEnvelope(raw, server.buildId, server.role);
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `TKD-${envelope.backupId}.tkd-backup.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } finally {
    await abort(token);
  }
}

async function restoreFromFile(file: File): Promise<void> {
  assertPristineBrowser(localStorage);
  if (file.size > BACKUP_MAX_BYTES) throw new Error("El archivo supera 32 MiB");
  const server = await status();
  if (!server.buildId || !server.role || !server.idle || server.receipt)
    throw new Error("El destino no es un paquete vacío y libre");
  const raw = await file.text();
  const backup = await parseBackupEnvelope(raw, server.buildId, server.role);
  const browser = backup.payload.browser;
  const stage: RestoreStage = {
    raw,
    backupId: backup.backupId,
    payloadHash: backup.payloadHash,
    browserHash: await sha256Hex(canonicalJson(browser)),
    browser,
    originals: readBrowserKeys(localStorage),
  };
  const token = await begin();
  try {
    await writeRestoreStage(stage);
    localStorage.setItem(
      BACKUP_PENDING_MARKER,
      JSON.stringify({
        backupId: stage.backupId,
        payloadHash: stage.payloadHash,
        browserHash: stage.browserHash,
      })
    );
    writeBrowserKeys(localStorage, browser);
    if ((await browserHash()) !== stage.browserHash)
      throw new Error("Fallo de lectura del navegador");
    try {
      await post("restore", { token, backup: raw });
    } catch (error) {
      const updated = await status();
      if (!verifyReceipt(updated.receipt, stage)) throw error;
    }
    await finishRestore(token, stage);
  } catch (error) {
    let current: ServerStatus;
    try {
      current = await status();
    } catch {
      throw error;
    }
    if (current.receipt?.status === "pending") throw error;
    if (current.receipt) throw error;
    await rollbackUncommittedRestore(stage, localStorage);
    await abort(token);
    throw error;
  }
}

export async function mountBackupMaintenance(root: HTMLElement): Promise<void> {
  root.replaceChildren();
  const panel = document.createElement("main");
  panel.className = "min-h-screen bg-slate-950 p-8 text-slate-100 space-y-4";
  const title = document.createElement("h1");
  title.className = "text-3xl font-bold";
  title.textContent = "Mantenimiento y respaldo TKD";
  const message = document.createElement("p");
  message.className = "max-w-xl text-slate-300";
  message.textContent = "Verificando acceso exclusivo…";
  const backupButton = document.createElement("button");
  backupButton.textContent = "Descargar respaldo completo";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".json,.tkd-backup.json,application/json";
  const restoreButton = document.createElement("button");
  restoreButton.textContent = "Restaurar en equipo vacío";
  const retryButton = document.createElement("button");
  retryButton.textContent = "Reintentar restauración pendiente";
  for (const button of [backupButton, restoreButton, retryButton]) {
    button.className = "rounded bg-blue-700 px-4 py-2 font-semibold disabled:opacity-40 mr-3";
    button.disabled = true;
  }
  const back = document.createElement("a");
  back.href = "/";
  back.textContent = "Volver al torneo";
  back.className = "block text-blue-300 underline";
  panel.append(title, message, backupButton, file, restoreButton, retryButton, back);
  root.append(panel);
  try {
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1")
      throw new Error("El respaldo sólo está permitido en esta computadora por localhost");
    await exclusiveWebLock();
    const server = await status();
    if (!server.buildId) throw new Error("Falta build-id.json: respaldo deshabilitado");
    const pending =
      localStorage.getItem(BACKUP_PENDING_MARKER) !== null || server.receipt?.status === "pending";
    message.textContent = pending
      ? "Hay una restauración pendiente. No se cargará el torneo hasta verificarla."
      : "Cierre las otras pestañas y no inicie combates durante el respaldo.";
    backupButton.disabled = pending;
    restoreButton.disabled = pending;
    retryButton.disabled = !pending;
    back.hidden = pending;
  } catch (error) {
    message.textContent = `Bloqueado: ${String(error)}`;
    return;
  }
  const run = async (work: () => Promise<void>, success: string) => {
    for (const button of [backupButton, restoreButton, retryButton]) button.disabled = true;
    message.textContent = "Procesando. No cierre esta ventana.";
    try {
      await work();
      message.textContent = success;
    } catch (error) {
      message.textContent = `Bloqueado: ${String(error)}. Revise y reintente sin abrir el torneo.`;
    }
    const latest = await status().catch(() => null);
    const pending =
      localStorage.getItem(BACKUP_PENDING_MARKER) !== null || latest?.receipt?.status === "pending";
    backupButton.disabled = !latest || pending;
    restoreButton.disabled = !latest || pending;
    retryButton.disabled = !latest || !pending;
  };
  backupButton.onclick = () => {
    void run(
      backupToFile,
      "Respaldo preparado. Verifique que el archivo .tkd-backup.json se haya guardado antes de cerrar."
    );
  };
  restoreButton.onclick = () => {
    void run(async () => {
      const selected = file.files?.[0];
      if (!selected) throw new Error("Seleccione primero el archivo .tkd-backup.json");
      await restoreFromFile(selected);
    }, "Restauración verificada. Abriendo torneo.");
  };
  retryButton.onclick = () => {
    void run(recoverRestore, "Restauración verificada. Abriendo torneo.");
  };
}
