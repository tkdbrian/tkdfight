import type { FightEntry } from "@/store/tournament";

interface StoredProposal {
  version: 1;
  stage: string;
  fights: FightEntry[];
}

function storageKey(categoryId: string, stage: string): string {
  return `tkd-pending-fight-v1:${encodeURIComponent(categoryId)}:${encodeURIComponent(stage)}`;
}

/** Stable matchup identity; a retry must not change contestants or playoff phase. */
function boutSignature(fight: FightEntry): string {
  return JSON.stringify([
    fight.red.id,
    fight.blue.id,
    fight.groupId ?? null,
    fight.isFinalFight ?? false,
    fight.isTiebreakExtra ?? false,
    fight.isGoldenPointFight ?? false,
    fight.playoffKind ?? null,
    fight.playoffBasis ?? null,
    fight.bracketMatchId ?? null,
  ]);
}

/** Persist IDs before sync so a lost HTTP response can be retried idempotently. */
export function getOrCreateFightProposal(
  categoryId: string,
  stage: string,
  create: () => FightEntry[]
): FightEntry[] {
  const proposed = create();
  if (proposed.length === 0) return [];
  const key = storageKey(categoryId, stage);
  const raw = localStorage.getItem(key);
  if (!raw) {
    const record: StoredProposal = { version: 1, stage, fights: proposed };
    localStorage.setItem(key, JSON.stringify(record));
    return proposed;
  }

  let record: StoredProposal;
  try {
    record = JSON.parse(raw) as StoredProposal;
  } catch {
    throw new Error("La propuesta anterior no se pudo leer; no se crearán IDs nuevos.");
  }
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== 1 ||
    record.stage !== stage ||
    !Array.isArray(record.fights) ||
    record.fights.length !== proposed.length ||
    record.fights.some(
      (fight, index) =>
        typeof fight?.id !== "string" ||
        !fight.id ||
        !fight.red?.id ||
        !fight.blue?.id ||
        boutSignature(fight) !== boutSignature(proposed[index])
    )
  ) {
    throw new Error(
      "La propuesta anterior no coincide con esta llave; no se crearán peleas duplicadas."
    );
  }
  return proposed.map((fight, index) => ({
    ...fight,
    id: record.fights[index].id,
    tiebreakerSeconds: record.fights[index].tiebreakerSeconds,
  }));
}

/** Clear only the exact proposal that was acknowledged and appended locally. */
export function clearFightProposal(categoryId: string, stage: string, fights: FightEntry[]): void {
  try {
    const key = storageKey(categoryId, stage);
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const record = JSON.parse(raw) as StoredProposal;
    if (
      Array.isArray(record.fights) &&
      record.fights.length === fights.length &&
      record.fights.every((fight, index) => fight.id === fights[index].id)
    ) {
      localStorage.removeItem(key);
    }
  } catch {
    // The confirmed local append must not be rolled back due to storage cleanup failure.
  }
}
