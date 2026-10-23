import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryTabs } from "@/components/CategoryTabs";
import type { ServerState } from "@/lib/socket-types";
import { useTournamentStore } from "@/store/tournament";

const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: notifications }));
const initial = useTournamentStore.getState();
const server: ServerState = {
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  notifications.success.mockReset();
  localStorage.clear();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
});
describe("reversible category X", () => {
  it("hides immediately and offers Recover without deleting, confirmation or server activation", async () => {
    localStorage.clear();
    useTournamentStore.setState({
      config: { ...initial.config, id: "previous", categoryName: "Anterior" },
    });
    const draft = useTournamentStore.getState().createCategory();
    useTournamentStore.getState().setConfig({ categoryName: "Preparación" });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(
      <MemoryRouter>
        <CategoryTabs connected stateReady serverState={server} />
      </MemoryRouter>
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Ocultar Preparación" }))
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(notifications.success).toHaveBeenCalledWith(
      "Categoría ocultada",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Recuperar", onClick: expect.any(Function) }),
      })
    );
    const options: unknown = notifications.success.mock.calls[0]?.[1];
    if (!options || typeof options !== "object" || !("action" in options))
      throw new Error("Missing recovery action");
    const action = options.action;
    if (
      !action ||
      typeof action !== "object" ||
      !("onClick" in action) ||
      typeof action.onClick !== "function"
    )
      throw new Error("Missing recovery callback");
    const recover = action.onClick;
    act(() => recover());
    expect(
      useTournamentStore
        .getState()
        .getCategoryEntries()
        .find((entry) => entry.id === draft)?.visible
    ).toBe(true);
    expect(useTournamentStore.getState().config.id).toBe("previous");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
