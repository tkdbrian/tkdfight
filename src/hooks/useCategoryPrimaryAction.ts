import { useEffect, useRef, useState } from "react";
import {
  type CategoryPrimaryAction,
  type CategoryPrimaryActionContext,
  getCategoryPrimaryAction,
  hasCategoryChampion,
} from "@/lib/category-lifecycle";
import type { FightEntry } from "@/store/tournament";

const METRICS = [
  "flagsRed",
  "flagsBlue",
  "foulsRed",
  "foulsBlue",
  "warningsRed",
  "warningsBlue",
] as const;

export function categoryResultMatches(
  categoryId: string,
  fight: FightEntry,
  response: unknown
): boolean {
  if (!response || typeof response !== "object") return false;
  const envelope = response as { ok?: unknown; result?: unknown };
  if (!envelope.ok || !envelope.result || typeof envelope.result !== "object") return false;
  const result = envelope.result as Record<string, unknown>;
  return (
    result.status === "confirmed" &&
    result.fightId === fight.id &&
    result.categoryId === categoryId &&
    fight.completed &&
    result.winner === fight.winner &&
    METRICS.every(
      (field) =>
        Number.isInteger(fight[field]) &&
        Number.isInteger(result[field]) &&
        fight[field] === result[field]
    )
  );
}

/** Uses the same read-only durable-result checks as Standings/Results; never loads a bout. */
export function useCategoryPrimaryAction(
  context: CategoryPrimaryActionContext,
  request: ((event: string, data: unknown) => Promise<unknown>) | undefined
): CategoryPrimaryAction {
  const [verifiedKey, setVerifiedKey] = useState<string | null>(null);
  const requestRef = useRef(request);
  requestRef.current = request;
  const key = JSON.stringify(context.snapshot);
  const candidate = hasCategoryChampion(context.snapshot);
  useEffect(() => {
    if (!candidate || !context.connected || !context.stateReady || !requestRef.current) return;
    let cancelled = false;
    const snapshot = JSON.parse(key) as CategoryPrimaryActionContext["snapshot"];
    const dependencies = snapshot.fights.filter((fight) => !fight.groupId?.startsWith("EXT:"));
    void Promise.all(
      dependencies.map(async (fight) =>
        categoryResultMatches(
          snapshot.config.id,
          fight,
          await requestRef.current?.("match:result:get", {
            categoryId: snapshot.config.id,
            matchId: fight.id,
          })
        )
      )
    )
      .then((checks) => {
        if (!cancelled) setVerifiedKey(checks.length > 0 && checks.every(Boolean) ? key : null);
      })
      .catch(() => {
        if (!cancelled) setVerifiedKey(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, candidate, context.connected, context.stateReady]);
  return getCategoryPrimaryAction({ ...context, resultsVerified: verifiedKey === key });
}
