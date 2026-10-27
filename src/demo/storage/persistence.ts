/** A hint to the browser, never a durability guarantee. Backups remain essential. */
export async function requestDemoStoragePersistence(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return "unsupported";
  try { return await navigator.storage.persist() ? "granted" : "denied"; }
  catch { return "unsupported"; }
}

export async function demoStorageEstimate(): Promise<{ usage?: number; quota?: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage, quota: estimate.quota };
  } catch { return null; }
}
