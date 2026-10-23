import type { BackupPayload } from "./full-backup-contract";
import { BACKUP_BROWSER_KEYS, validateBrowserPayload } from "./full-backup-contract";

export const BACKUP_PENDING_MARKER = "tkd-backup-restore-pending-v1";

export function readBrowserKeys(storage: Storage): BackupPayload["browser"] {
  return Object.fromEntries(
    BACKUP_BROWSER_KEYS.map((key) => [key, storage.getItem(key)])
  ) as BackupPayload["browser"];
}

export function writeBrowserKeys(storage: Storage, browser: BackupPayload["browser"]): void {
  validateBrowserPayload(browser);
  for (const key of BACKUP_BROWSER_KEYS) {
    const value = browser[key];
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

export function assertBrowserIdle(storage: Storage): void {
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith("tkd-pending-") || key === BACKUP_PENDING_MARKER)
      throw new Error("Unresolved tournament operation or restore journal");
  }
  validateBrowserPayload(readBrowserKeys(storage));
}

function emptyDraft(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.phase !== "setup") return false;
  const config = snapshot.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return false;
  const names = config as Record<string, unknown>;
  if (names.tournamentName !== "" && names.tournamentName !== "Torneo") return false;
  if (names.categoryName !== "") return false;
  for (const key of ["competitors", "fights", "groups", "bracketMatches"])
    if (!Array.isArray(snapshot[key]) || (snapshot[key] as unknown[]).length !== 0) return false;
  if (
    snapshot.bracketSeeds !== undefined &&
    (!Array.isArray(snapshot.bracketSeeds) || snapshot.bracketSeeds.length !== 0)
  )
    return false;
  if (
    snapshot.eventProfiles !== undefined &&
    (!snapshot.eventProfiles ||
      typeof snapshot.eventProfiles !== "object" ||
      Object.keys(snapshot.eventProfiles).length !== 0)
  )
    return false;
  return true;
}

export function assertPristineBrowser(storage: Storage): void {
  assertBrowserIdle(storage);
  const browser = readBrowserKeys(storage);
  const main = browser["tkd-tournament"];
  if (main !== null) {
    const parsed = JSON.parse(main) as { state?: unknown };
    if (!emptyDraft(parsed.state)) throw new Error("Target browser tournament is not empty");
  }
  const categories = browser["tkd-tournament-categories"];
  if (categories !== null) {
    const parsed = JSON.parse(categories) as {
      categories?: Record<string, unknown>;
      archives?: Record<string, unknown>;
    };
    if (parsed.archives && Object.keys(parsed.archives).length !== 0)
      throw new Error("Target browser contains category archives");
    if (Object.values(parsed.categories ?? {}).some((snapshot) => !emptyDraft(snapshot)))
      throw new Error("Target browser categories are not empty");
  }
  for (const key of ["tkd-category-deletions-v1", "tkd-retired-category-sources-v1"] as const) {
    const raw = browser[key];
    if (raw !== null && (JSON.parse(raw) as unknown[]).length !== 0)
      throw new Error("Target browser contains category history");
  }
}
