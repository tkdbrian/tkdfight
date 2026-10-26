const pendingLocalSwaps = new Set<string>();

function key(categoryId: string, matchId: string): string {
  return JSON.stringify([categoryId, matchId]);
}

/** Prevent the initiating tab from adopting a broadcast before its ACK is verified. */
export function markLocalSwapPending(categoryId: string, matchId: string, pending: boolean): void {
  const identity = key(categoryId, matchId);
  if (pending) pendingLocalSwaps.add(identity);
  else pendingLocalSwaps.delete(identity);
}

export function isLocalSwapPending(categoryId: string, matchId: string): boolean {
  return pendingLocalSwaps.has(key(categoryId, matchId));
}
