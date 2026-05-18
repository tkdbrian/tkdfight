import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ServerState } from "@/lib/socket-types";

export interface RingTarget {
  ip: string;
  port: number;
  alias?: string;
}

export interface RingLiveState {
  target: RingTarget;
  connected: boolean;
  state: ServerState | null;
  lastUpdate: number;
}

const EMPTY: ServerState = {
  rules: null,
  match: null,
  matchState: null,
  matchPaused: false,
  judges: [],
  judgeVotes: {},
  judgeTotals: {},
  penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
  fallos: [],
  roundFlags: [],
  serverUrl: "",
};

/**
 * Connects to multiple tatami servers via Socket.io and returns their live state.
 * Each tatami runs its own Express+Socket.io server on the LAN.
 */
export function useRingClient(targets: RingTarget[]) {
  const socketsRef = useRef<Map<string, Socket>>(new Map());
  const [rings, setRings] = useState<Map<string, RingLiveState>>(new Map());

  const key = (t: RingTarget) => `${t.ip}:${t.port}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is a stable inline function; adding it to deps would cause infinite reconnect loops
  useEffect(() => {
    const currentKeys = new Set(targets.map(key));
    const existing = socketsRef.current;

    // Remove sockets no longer in targets
    for (const [k, socket] of existing) {
      if (!currentKeys.has(k)) {
        socket.disconnect();
        existing.delete(k);
        setRings((prev) => {
          const next = new Map(prev);
          next.delete(k);
          return next;
        });
      }
    }

    // Add new sockets
    for (const target of targets) {
      const k = key(target);
      if (existing.has(k)) continue;

      const url = `http://${target.ip}:${target.port}`;
      const socket = io(url, {
        path: "/socket.io",
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
        timeout: 5000,
      });

      // Init state
      setRings((prev) => {
        const next = new Map(prev);
        next.set(k, { target, connected: false, state: null, lastUpdate: 0 });
        return next;
      });

      socket.on("connect", () => {
        setRings((prev) => {
          const next = new Map(prev);
          const cur = next.get(k);
          if (cur) next.set(k, { ...cur, connected: true });
          return next;
        });
      });

      socket.on("disconnect", () => {
        setRings((prev) => {
          const next = new Map(prev);
          const cur = next.get(k);
          if (cur) next.set(k, { ...cur, connected: false });
          return next;
        });
      });

      socket.on("state:update", (data: ServerState) => {
        setRings((prev) => {
          const next = new Map(prev);
          next.set(k, {
            target,
            connected: true,
            state: {
              ...EMPTY,
              ...data,
              fallos: Array.isArray(data?.fallos) ? data.fallos : [],
              judges: Array.isArray(data?.judges) ? data.judges : [],
              roundFlags: Array.isArray(data?.roundFlags) ? data.roundFlags : [],
            },
            lastUpdate: Date.now(),
          });
          return next;
        });
      });

      existing.set(k, socket);
    }

    return () => {
      for (const socket of existing.values()) {
        socket.disconnect();
      }
      existing.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(targets)]);

  const ringList = Array.from(rings.values());

  return { rings: ringList, ringsMap: rings };
}
