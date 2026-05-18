import type { RingTarget } from "@/hooks/useRingClient";

export interface DiscoveredRing extends RingTarget {
  alias: string;
  name: string;
}

/**
 * Scans the LAN for TKD tatami servers by trying /api/ring/status on each IP.
 * Uses the same subnet as the local machine (derived from serverUrl or specified).
 */
export async function discoverRings(
  subnet?: string,
  port = 3001,
  onFound?: (ring: DiscoveredRing) => void,
  signal?: AbortSignal
): Promise<DiscoveredRing[]> {
  const base = subnet ?? guessSubnet();
  if (!base) return [];

  const found: DiscoveredRing[] = [];
  const batchSize = 20;

  for (let start = 1; start <= 254 && !signal?.aborted; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, 255 - start) }, (_, i) => start + i);

    const results = await Promise.allSettled(
      batch.map(async (i) => {
        const ip = `${base}.${i}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 800);

        try {
          const res = await fetch(`http://${ip}:${port}/api/ring/status`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (!res.ok) return null;
          const data = await res.json();
          if (data?.online !== true) return null;

          const ring: DiscoveredRing = {
            ip,
            port,
            alias: data.alias ?? `T?`,
            name: data.name ?? `Tatami ${ip}`,
          };
          return ring;
        } catch {
          clearTimeout(timeout);
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        found.push(r.value);
        onFound?.(r.value);
      }
    }
  }

  return found;
}

function guessSubnet(): string | null {
  // Try to extract from the current page's origin
  try {
    const host = window.location.hostname;
    const parts = host.split(".");
    if (parts.length === 4 && parts.every((p) => !Number.isNaN(Number(p)))) {
      return parts.slice(0, 3).join(".");
    }
  } catch { /* ignore */ }
  return "192.168.1";
}
