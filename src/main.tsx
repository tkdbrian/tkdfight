import "@/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { decideBackupBoot } from "@/lib/full-backup-boot";
import { BACKUP_PENDING_MARKER, readBrowserKeys } from "@/lib/full-backup-browser";
import { indexBuildId, verifyBuildIdentity } from "@/lib/full-backup-build-id";
import { validateBrowserPayload } from "@/lib/full-backup-contract";

const root = document.getElementById("root");
if (!root) throw new Error("No root element found");

async function maintenanceRequired(requireBrowserAuthority = false): Promise<boolean> {
  const response = await fetch("/boot-status", { cache: "no-store" });
  if (!response.ok) throw new Error("No se pudo verificar el estado del servidor");
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { maintenanceRequired?: unknown }).maintenanceRequired !== "boolean" ||
    !(
      (value as { buildId?: unknown }).buildId === null ||
      typeof (value as { buildId?: unknown }).buildId === "string"
    )
  )
    throw new Error("Estado del servidor inválido");
  const state = value as {
    maintenanceRequired: boolean;
    buildId: string | null;
    hasTournamentData?: unknown;
    activeCategoryIds?: unknown;
  };
  verifyBuildIdentity(state.buildId, indexBuildId(), import.meta.env.PROD);
  if (requireBrowserAuthority && state.hasTournamentData) {
    const browser = readBrowserKeys(localStorage);
    if (!browser["tkd-tournament"] || !browser["tkd-tournament-categories"])
      throw new Error(
        "Perfil sin categoría local para este torneo SQL. Use recuperación desde respaldo."
      );
    validateBrowserPayload(browser);
    const registry = JSON.parse(browser["tkd-tournament-categories"]) as {
      categories?: Record<string, unknown>;
    };
    if (
      !Array.isArray(state.activeCategoryIds) ||
      state.activeCategoryIds.some(
        (id) => typeof id !== "string" || !Object.hasOwn(registry.categories ?? {}, id)
      )
    )
      throw new Error(
        "Categoría local no coincide con el servidor. Use recuperación desde respaldo."
      );
  }
  return state.maintenanceRequired;
}

async function acquireSharedOperationLock(): Promise<void> {
  if (!navigator.locks)
    throw new Error("Este navegador no permite un bloqueo seguro entre pestañas");
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request("tkd-tournament-operation", { mode: "shared" }, async (lock) => {
        if (!lock) {
          reject(new Error("No se pudo bloquear la pestaña"));
          return;
        }
        resolve();
        await new Promise<void>(() => {});
      })
      .catch(reject);
  });
}

async function start(mount: HTMLElement): Promise<void> {
  const mode = decideBackupBoot(
    location.pathname,
    localStorage.getItem(BACKUP_PENDING_MARKER) !== null,
    await maintenanceRequired()
  );
  if (mode === "maintenance") {
    const { mountBackupMaintenance } = await import("@/maintenance/full-backup-maintenance");
    await mountBackupMaintenance(mount);
    return;
  }
  await acquireSharedOperationLock();
  if (localStorage.getItem(BACKUP_PENDING_MARKER) !== null || (await maintenanceRequired(true))) {
    const { mountBackupMaintenance } = await import("@/maintenance/full-backup-maintenance");
    await mountBackupMaintenance(mount);
    return;
  }
  const { App } = await import("@/App");
  createRoot(mount).render(
    <StrictMode>
      <App />
      <Toaster richColors position="top-right" closeButton />
    </StrictMode>
  );
}

void start(root).catch((error: unknown) => {
  root.textContent = `Inicio bloqueado por seguridad: ${String(error)}`;
});
