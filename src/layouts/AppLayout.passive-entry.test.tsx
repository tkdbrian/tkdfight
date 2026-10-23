import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/layouts/AppLayout";
import type { ServerState } from "@/lib/socket-types";
import { useTournamentStore } from "@/store/tournament";
import { recordedCategory } from "@/test/category-restart-fixtures";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("@/components/CategoryTabs", () => ({ CategoryTabs: () => <div>Categorías</div> }));
vi.mock("@/lib/tour", () => ({ startGlobalTour: vi.fn(), continueTourIfPending: vi.fn() }));
const initial = useTournamentStore.getState();
const snapshot = recordedCategory();
const intent = {
  kind: "category-continue",
  categoryId: snapshot.config.id,
  fightId: snapshot.fights[0].id,
};
const base: ServerState = {
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
beforeEach(() => {
  vi.stubGlobal("__APP_VERSION__", "test");
  useTournamentStore.setState(snapshot);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => useTournamentStore.setState(initial, true));
  localStorage.clear();
});
function mount(state: unknown = intent): void {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/fight", state }]}>
      <AppLayout>
        <p>Combate local consultable</p>
      </AppLayout>
    </MemoryRouter>
  );
}
describe("narrow passive Combat layout exception", () => {
  it.each([
    "offline",
    "unknown",
    "other-category",
  ])("allows validated local consultation while %s", (mode) => {
    const state =
      mode === "other-category"
        ? {
            ...base,
            activeMatchLock: {
              fightId: "other",
              categoryId: "other-category",
              tournamentId: 9,
              resultStatus: "pending_confirmation",
            },
          }
        : base;
    mocks.useSocket.mockReturnValue({
      state,
      connected: mode !== "offline",
      stateReady: mode !== "unknown",
    });
    mount();
    expect(screen.getByText("Combate local consultable")).toBeVisible();
  });
  it.each([
    undefined,
    { ...intent, categoryId: "foreign" },
    { ...intent, fightId: "missing" },
  ])("does not grant a consult bypass for absent/stale/foreign intent", (state) => {
    mocks.useSocket.mockReturnValue({ state: base, connected: false, stateReady: false });
    mount(state ?? null);
    expect(screen.queryByText("Combate local consultable")).not.toBeInTheDocument();
  });
  it("retains missing-own-bout recovery even with a different valid local target", () => {
    mocks.useSocket.mockReturnValue({
      connected: true,
      stateReady: true,
      state: {
        ...base,
        activeMatchLock: {
          fightId: "missing-own",
          categoryId: snapshot.config.id,
          tournamentId: 1,
          resultStatus: "pending_confirmation",
        },
      },
    });
    mount();
    expect(screen.queryByText("Combate local consultable")).not.toBeInTheDocument();
    expect(screen.getByText(/El servidor conserva el combate missing-own/)).toBeVisible();
  });
});
