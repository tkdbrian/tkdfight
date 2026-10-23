import { create } from "zustand";
import { z } from "zod";
import { canonicalJson, validateBrowserPayload } from "./full-backup-contract";
import { categoryExecutionUnavailable } from "./category-deletion-persistence";

export const TOURNAMENT_PERSISTENCE_JOURNAL = "tkd-pending-tournament-persistence-v1";
const MAIN = "tkd-tournament";
const REGISTRY = "tkd-tournament-categories";
const journalSchema = z.strictObject({ version: z.literal(1), main: z.string().max(32 * 1024 * 1024),
  registry: z.string().max(32 * 1024 * 1024) });
type Journal = z.infer<typeof journalSchema>;
interface AuthorityConflict { main: string; registry: string; summary: string }
interface PersistenceState { blocked: boolean; message: string | null; conflict: AuthorityConflict | null }
export const useTournamentPersistenceState = create<PersistenceState>(() => ({ blocked: false, message: null, conflict: null }));
let pending: Journal | null = null;
let pendingBaseline: { main: string | null; registry: string | null } | null = null;
let unreadableBaselineMain: string | null | undefined;

function failure(error: unknown): false {
  useTournamentPersistenceState.setState({ blocked: true,
    message: `No se pudo guardar el torneo completo. No cierres ni recargues esta ventana. ${error instanceof Error ? error.message : "Almacenamiento no disponible"}` });
  return false;
}

export function reportTournamentPersistenceFailure(message: string): false {
  if (!useTournamentPersistenceState.getState().blocked) {
    try { unreadableBaselineMain = localStorage.getItem(MAIN); } catch { /* Keep blocked if the authority cannot be read. */ }
  }
  return failure(new Error(message));
}

const snapshotKeys = ["phase", "config", "competitors", "fights", "groups", "bracketMatches", "bracketSeeds", "currentFightIndex", "setupStarted"] as const;
const snapshotObject = z.object({ config: z.object({ id: z.string() }).passthrough(),
  competitors: z.array(z.unknown()), fights: z.array(z.record(z.string(), z.unknown())) }).passthrough();

function validateExistingAuthorities(): void {
  const main = localStorage.getItem(MAIN), registry = localStorage.getItem(REGISTRY);
  validateBrowserPayload({ [MAIN]: null, [REGISTRY]: registry,
    "tkd-category-deletions-v1": null, "tkd-retired-category-sources-v1": null });
  if (main === null || registry === null) return;
  const envelope = z.object({ version: z.union([z.literal(0), z.literal(1)]), state: z.record(z.string(), z.unknown()) }).parse(JSON.parse(main));
  const principal = envelope.state;
  // Preserve supported partial legacy documents; their existing migration fills defaults.
  if (envelope.version === 0 || snapshotKeys.some((key) => !(key in principal)) ||
    !z.object({ id: z.string().min(1) }).safeParse(principal.config).success) return;
  validateBrowserPayload({ [MAIN]: main, [REGISTRY]: registry,
    "tkd-category-deletions-v1": null, "tkd-retired-category-sources-v1": null });
  const current = snapshotObject.parse(principal);
  const saved = z.object({ version: z.number(), selectedCategoryId: z.string().nullable().optional(),
    categories: z.record(z.string(), z.unknown()) }).parse(JSON.parse(registry));
  if (saved.version !== 2) return;
  if (saved.selectedCategoryId !== current.config.id)
    throw new Error("Las categorías de las copias no coinciden; se conservaron ambas sin elegir una automáticamente");
  const selected = snapshotObject.parse(saved.categories[current.config.id]);
  const category = Object.fromEntries(snapshotKeys.map((key) => [key, principal[key]]));
  if (canonicalJson(category) === canonicalJson(selected)) return;
  const counts = (value: z.infer<typeof snapshotObject>): string =>
    `${value.competitors.length} competidores, ${value.fights.length} peleas, ${value.fights.filter((fight) => fight.completed === true).length} resultados`;
  const label = (value: z.infer<typeof snapshotObject>): string =>
    typeof value.config.categoryName === "string" && value.config.categoryName ? value.config.categoryName : value.config.id;
  useTournamentPersistenceState.setState({ conflict: { main, registry,
    summary: `Categoría principal: ${label(current)}; categoría guardada: ${label(selected)}. Copia principal: ${counts(current)}. Copia de categoría: ${counts(selected)}.` } });
  throw new Error("Las copias guardadas difieren; no se eligió una automáticamente. Revisá las cantidades antes de conservar la copia principal");
}

function validate(journal: Journal): void {
  validateBrowserPayload({ [MAIN]: journal.main, [REGISTRY]: journal.registry,
    "tkd-category-deletions-v1": null, "tkd-retired-category-sources-v1": null });
  const main = z.object({ state: z.object({ config: z.object({ id: z.string().min(1) }) }) }).parse(JSON.parse(journal.main));
  const registry = z.object({ version: z.literal(2), selectedCategoryId: z.string().nullable(),
    categories: z.record(z.string(), z.unknown()) }).parse(JSON.parse(journal.registry));
  if (registry.selectedCategoryId !== main.state.config.id || !Object.hasOwn(registry.categories, main.state.config.id))
    throw new Error("Las identidades del guardado no coinciden");
  if (categoryExecutionUnavailable(main.state.config.id))
    throw new Error("La ejecución fue archivada o eliminada; no se recuperó una copia antigua");
}

function apply(journal: Journal): boolean {
  validate(journal);
  const raw = JSON.stringify(journal);
  const existing = localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL);
  if (existing !== null && existing !== raw)
    throw new Error("Otra ventana tiene un guardado diferente pendiente; no se sobrescribió");
  if (pending === journal && pendingBaseline && existing === null &&
    ((localStorage.getItem(MAIN) !== pendingBaseline.main && localStorage.getItem(MAIN) !== journal.main) ||
      (localStorage.getItem(REGISTRY) !== pendingBaseline.registry && localStorage.getItem(REGISTRY) !== journal.registry)))
    throw new Error("Otra ventana cambió el torneo mientras este guardado estaba pendiente; no se sobrescribió");
  localStorage.setItem(TOURNAMENT_PERSISTENCE_JOURNAL, raw);
  if (localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL) !== raw) throw new Error("No se pudo verificar el registro de recuperación");
  localStorage.setItem(MAIN, journal.main);
  if (localStorage.getItem(MAIN) !== journal.main) throw new Error("No se pudo verificar el torneo guardado");
  localStorage.setItem(REGISTRY, journal.registry);
  if (localStorage.getItem(REGISTRY) !== journal.registry) throw new Error("No se pudieron verificar las categorías guardadas");
  localStorage.removeItem(TOURNAMENT_PERSISTENCE_JOURNAL);
  if (localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL) !== null) throw new Error("La recuperación sigue pendiente");
  pending = null;
  pendingBaseline = null;
  unreadableBaselineMain = undefined;
  useTournamentPersistenceState.setState({ blocked: false, message: null, conflict: null });
  return true;
}

/** Commit both browser authorities, retaining the exact intended bytes until all writes verify. */
export function commitTournamentAuthorities(main: string, registry: string): boolean {
  if (useTournamentPersistenceState.getState().blocked) return false;
  try {
    const existing = localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL);
    if (existing !== null) return failure(new Error("Otra ventana dejó un guardado pendiente; recuperalo antes de continuar"));
    const journal = journalSchema.parse({ version: 1, main, registry });
    validate(journal);
    pendingBaseline = { main: localStorage.getItem(MAIN), registry: localStorage.getItem(REGISTRY) };
    pending = journal;
    return apply(journal);
  } catch (error) { return failure(error); }
}

/** Called before hydration and explicitly by Retry; never erase an unverified journal. */
export function recoverTournamentAuthorities(): boolean {
  try {
    const raw = localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL);
    const journal = pending ?? (raw === null ? null : journalSchema.parse(JSON.parse(raw)));
    if (!journal) {
      if (unreadableBaselineMain !== undefined && localStorage.getItem(MAIN) !== unreadableBaselineMain)
        throw new Error("Otra ventana cambió la copia principal durante el fallo de lectura; no se sobrescribió");
      validateExistingAuthorities();
      useTournamentPersistenceState.setState({ blocked: false, message: null, conflict: null });
      return true;
    }
    return apply(journal);
  } catch (error) { return failure(error); }
}

export function hasPendingTournamentCommit(): boolean {
  if (pending) return true;
  try { return localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL) !== null; }
  catch { return true; }
}

/** Explicit operator choice only; refuse stale previews or a different/deleted category. */
export function conservePrincipalTournamentCopy(): boolean {
  const conflict = useTournamentPersistenceState.getState().conflict;
  if (!conflict || pending) return false;
  try {
    if (localStorage.getItem(MAIN) !== conflict.main || localStorage.getItem(REGISTRY) !== conflict.registry)
      throw new Error("Las copias cambiaron; volvé a revisar antes de decidir");
    const principal = z.object({ state: z.record(z.string(), z.unknown()) }).parse(JSON.parse(conflict.main)).state;
    const current = snapshotObject.parse(principal);
    const registry = z.object({ selectedCategoryId: z.string(), categories: z.record(z.string(), z.unknown()) })
      .passthrough().parse(JSON.parse(conflict.registry));
    if (registry.selectedCategoryId !== current.config.id) throw new Error("Identidad de categoría no verificable");
    registry.categories[current.config.id] = Object.fromEntries(snapshotKeys.map((key) => [key, principal[key]]));
    useTournamentPersistenceState.setState({ blocked: false });
    return commitTournamentAuthorities(conflict.main, JSON.stringify(registry));
  } catch (error) { return failure(error); }
}

export function tournamentPersistenceBlocked(): boolean {
  if (useTournamentPersistenceState.getState().blocked) return true;
  try { return localStorage.getItem(TOURNAMENT_PERSISTENCE_JOURNAL) !== null; }
  catch (error) { failure(error); return true; }
}

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === TOURNAMENT_PERSISTENCE_JOURNAL && event.newValue !== null)
    failure(new Error("Otra ventana está guardando el torneo. Revisá la recuperación antes de continuar"));
});
