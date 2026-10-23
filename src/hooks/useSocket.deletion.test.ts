import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSocket } from "@/hooks/useSocket";
import { useCategoryDeletionState } from "@/store/category-deletion-state";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const transport = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  emit: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({
    ...transport,
    on: (event: string, handler: (payload: unknown) => void) =>
      transport.handlers.set(event, handler),
  }),
}));
const initial = useTournamentStore.getState();
const marker = {
  categoryId: "category-old",
  requestId: crypto.randomUUID(),
  deletedAt: "2026-10-22T00:00:00.000Z",
};
beforeEach(() => {
  localStorage.clear();
  useTournamentStore.setState(recordedCategory());
});
afterEach(() => {
  cleanup();
  transport.handlers.clear();
  transport.emit.mockClear();
  useCategoryDeletionState.setState({
    pending: false,
    recoveryRequired: false,
    message: null,
    observed: [],
  });
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});
describe("canonical deletion observations", () => {
  it.each([
    "state:update",
    "category:deleted",
  ])("retires stale local graph on %s without activating another server category", (event) => {
    renderHook(() => useSocket());
    const receipt = {
      ok: true,
      ...marker,
      tournamentId: null,
      counts: {
        competitors: 3,
        fights: 3,
        completedFights: 0,
        confirmedResults: 0,
        localOnlyFights: 3,
      },
    };
    act(() =>
      transport.handlers.get(event)?.(
        event === "state:update" ? { categoryDeletions: [marker] } : receipt
      )
    );
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .some((entry) => entry.id === marker.categoryId)
    ).toBe(false);
    expect(useTournamentStore.getState().config.eventId).toBe("event-kept");
    expect(transport.emit).not.toHaveBeenCalled();
  });
  it("ignores malformed deletion events instead of removing a graph", () => {
    renderHook(() => useSocket());
    act(() =>
      transport.handlers.get("category:deleted")?.({ ok: true, categoryId: marker.categoryId })
    );
    expect(useTournamentStore.getState().config.id).toBe(marker.categoryId);
  });
});
