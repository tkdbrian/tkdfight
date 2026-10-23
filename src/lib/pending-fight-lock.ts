import type { ServerState } from "@/lib/socket-types";

export interface BlockedFightInfo {
  blockedFightId: string;
  blockedCategoryId: string | null;
  pendingConfirmation: boolean;
  blockedRedName?: string;
  blockedBlueName?: string;
}

interface LocalFightIdentity {
  id: string;
  red: { name: string };
  blue: { name: string };
}

export interface FightLockNotice {
  fightId: string;
  categoryId: string | null;
  localIndex: number | null;
  pendingConfirmation: boolean;
  message: string;
  actionLabel: string;
}

/** The durable lock wins over local selection; numbering comes only from this category's local list. */
export function describeFightLock(
  state: ServerState,
  categoryId: string,
  fights: readonly LocalFightIdentity[],
  refused?: BlockedFightInfo | null,
): FightLockNotice | null {
  // A refused-load ACK may be newer than the captured socket state. The caller
  // discards this metadata as soon as another authoritative broadcast arrives.
  const lock = refused ? { fightId: refused.blockedFightId, categoryId: refused.blockedCategoryId,
    resultStatus: refused.pendingConfirmation ? "pending_confirmation" : null } : state.activeMatchLock;
  const active = !refused && state.match && !state.resultConfirmed ? state.match : null;
  const fightId = lock?.fightId ?? active?.id ?? refused?.blockedFightId;
  if (!fightId) return null;
  const lockedCategoryId = lock ? lock.categoryId : active ? state.categoryId ?? null : refused?.blockedCategoryId ?? null;
  const matchingServerMatch = state.match?.id === fightId && state.categoryId === lockedCategoryId ? state.match : null;
  const pendingConfirmation = lock?.resultStatus === "pending_confirmation" ||
    !!(matchingServerMatch && !state.resultConfirmed && state.matchState?.phase === "finished" && state.matchState.result) ||
    (!lock && !active && !!refused?.pendingConfirmation);
  const index = lockedCategoryId === categoryId ? fights.findIndex((fight) => fight.id === fightId) : -1;
  const localIndex = index === -1 ? null : index;
  const local = localIndex === null ? null : fights[localIndex];
  const redName = matchingServerMatch?.red.name ?? local?.red.name ?? refused?.blockedRedName;
  const blueName = matchingServerMatch?.blue.name ?? local?.blue.name ?? refused?.blockedBlueName;
  const names = redName && blueName ? `${redName} vs. ${blueName}` : null;
  const label = localIndex !== null ? `el combate ${localIndex + 1}${names ? `: ${names}` : ""}`
    : names ? `el combate de ${names}` : "un combate";
  let message = pendingConfirmation
    ? `Falta confirmar ${label}.`
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} sigue cargado en el tatami.`;
  if (localIndex === null) {
    message += lockedCategoryId !== categoryId
      ? " Volvé a su categoría para revisar el resultado o estado del combate."
      : " La pelea no está en esta llave local; recuperá la categoría correspondiente para revisarla.";
  }
  return { fightId, categoryId: lockedCategoryId, localIndex, pendingConfirmation, message,
    actionLabel: pendingConfirmation ? "Ir al combate pendiente" : "Volver al combate activo" };
}
