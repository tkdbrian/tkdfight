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
  serverUrl: "",
};

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<ServerState>(DEFAULT_STATE);

  useEffect(() => {
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("state:update", (data: ServerState) => setState(data));

    return () => {
      socket.disconnect();
    };
  }, []);

  function emit<T>(event: string, data?: T) {
    socketRef.current?.emit(event, data);
  }

  return { connected, state, emit, socket: socketRef.current };
}
