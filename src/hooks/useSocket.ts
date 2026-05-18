import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ServerState } from "@/lib/socket-types";

const DEFAULT_STATE: ServerState = {
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

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<ServerState>(DEFAULT_STATE);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const sock = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = sock;
    setSocket(sock);

    sock.on("connect", () => setConnected(true));
    sock.on("disconnect", () => setConnected(false));
    sock.on("state:update", (data: ServerState) => setState(data));
    sock.on("ring:config-updated", (data: { alias: string; name: string }) =>
      setState((prev) => ({ ...prev, ringAlias: data.alias, ringName: data.name }))
    );

    return () => {
      sock.disconnect();
      setSocket(null);
    };
  }, []);

  function emit<T>(event: string, data?: T) {
    socketRef.current?.emit(event, data);
  }

  return { connected, state, emit, socket };
}
