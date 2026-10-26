import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSocket } from "@/hooks/useSocket";
import { markLocalSwapPending } from "@/lib/match-swap-pending";
import { useTournamentStore } from "@/store/tournament";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  emit: vi.fn(), disconnect: vi.fn(),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({ ...transport, on: (event: string, handler: (payload: unknown) => void) =>
    transport.handlers.set(event, handler) }),
}));
const initial = useTournamentStore.getState();
const red = { id: "r", name: "Red" };
const blue = { id: "b", name: "Blue" };
afterEach(() => {
  cleanup(); transport.handlers.clear();
  markLocalSwapPending("swap-category", "swap-fight", false);
  act(() => useTournamentStore.setState(initial, true));
});

describe("cross-tab operative color reconciliation", () => {
  it("updates only the FightEntry pair from a canonical state broadcast", () => {
    const bracket = { id: "bracket", round: 0, position: 0, red: { competitor: red },
      blue: { competitor: blue }, completed: false };
    act(() => useTournamentStore.setState({
      config: { ...initial.config, id: "swap-category" },
      fights: [{ id: "swap-fight", red, blue, completed: false, bracketMatchId: bracket.id }],
      bracketMatches: [bracket],
    }));
    renderHook(() => useSocket());
    act(() => transport.handlers.get("state:update")?.({ categoryId: "swap-category",
      match: { id: "swap-fight", red: blue, blue: red } }));
    expect(useTournamentStore.getState().fights[0].red.id).toBe("b");
    expect(useTournamentStore.getState().fights[0].blue.id).toBe("r");
    expect(useTournamentStore.getState().bracketMatches[0]).toEqual(bracket);
  });

  it("does not apply the initiating tab's broadcast before its ACK", () => {
    act(() => useTournamentStore.setState({ config: { ...initial.config, id: "swap-category" },
      fights: [{ id: "swap-fight", red, blue, completed: false }] }));
    markLocalSwapPending("swap-category", "swap-fight", true);
    renderHook(() => useSocket());
    act(() => transport.handlers.get("state:update")?.({ categoryId: "swap-category",
      match: { id: "swap-fight", red: blue, blue: red } }));
    expect(useTournamentStore.getState().fights[0].red.id).toBe("r");
  });
});
