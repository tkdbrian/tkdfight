import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSocket } from "@/hooks/useSocket";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: unknown) => void>(),
  connected: true,
  emit: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({
    ...transport,
    on: (event: string, handler: (payload?: unknown) => void) => {
      transport.handlers.set(event, handler);
    },
  }),
}));
afterEach(() => {
  cleanup();
  transport.handlers.clear();
  transport.emit.mockReset();
});
describe("fresh server state after reconnect", () => {
  it("does not mark a reconnected transport ready until its new state:update arrives", () => {
    const view = renderHook(() => useSocket());
    act(() => transport.handlers.get("connect")?.());
    act(() => transport.handlers.get("state:update")?.({ categoryId: "old" }));
    expect(view.result.current.stateReady).toBe(true);
    act(() => transport.handlers.get("disconnect")?.());
    expect(view.result.current.stateReady).toBe(false);
    act(() => transport.handlers.get("connect")?.());
    expect(view.result.current.connected).toBe(true);
    expect(view.result.current.stateReady).toBe(false);
    expect(view.result.current.state.categoryId).toBe("old");
    act(() => transport.handlers.get("state:update")?.({ categoryId: "fresh" }));
    expect(view.result.current.stateReady).toBe(true);
    expect(view.result.current.state.categoryId).toBe("fresh");
  });
});
