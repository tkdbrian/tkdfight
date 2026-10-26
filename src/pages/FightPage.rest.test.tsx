import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerState } from "@/lib/socket-types";
import { FightPage } from "@/pages/FightPage";
import { type FightEntry, useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({
  useSocket: vi.fn(),
  request: vi.fn(),
  emit: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));

const initial = useTournamentStore.getState();
function fight(
  id: string,
  red: string,
  blue: string,
  groupId = "G1",
  completed = false
): FightEntry {
  return {
    id,
    red: { id: red, name: red, team: "" },
    blue: { id: blue, name: blue, team: "" },
    groupId,
    completed,
  };
}
const last = {
  fightId: "ab",
  categoryId: "rest-category",
  redId: "A",
  blueId: "B",
  confirmedAt: "2026-10-26T12:00:00.000Z",
};
const noMatch = {
  rules: null,
  categoryId: null,
  match: null,
  matchState: null,
  resultConfirmed: false,
  matchPaused: false,
  judges: [],
  judgeVotes: {},
  judgeTotals: {},
  roundFlags: [],
  penaltyCounts: { warnings: { red: 0, blue: 0 }, fouls: { red: 0, blue: 0 } },
  fallos: [],
  serverUrl: "",
} as ServerState;

function setup(
  fights: FightEntry[],
  response: unknown = { ok: true, last, ambiguous: false }
): void {
  act(() =>
    useTournamentStore.setState({
      ...initial,
      config: {
        ...initial.config,
        id: "rest-category",
        mode: "round-robin",
        matchType: "sparring",
      },
      fights,
      groups: [],
      currentFightIndex: 1,
      phase: "fighting",
    })
  );
  mocks.useSocket.mockReturnValue({
    connected: true,
    stateReady: true,
    state: noMatch,
    emit: mocks.emit,
    request: mocks.request,
    socket: { on: vi.fn(), off: vi.fn() },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("last-confirmed")) return { ok: true, json: async () => response };
      if (url.includes("/api/ring/status"))
        return { ok: true, json: async () => ({ activeMatchLock: null }) };
      return { ok: true, json: async () => ({}) };
    })
  );
  Element.prototype.scrollIntoView = vi.fn();
  mocks.request.mockResolvedValue({ ok: false, error: "test load stop" });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  act(() => useTournamentStore.setState(initial));
});

describe("operator-confirmed round-robin rest advisory", () => {
  it("offers a disjoint selection after postponed order without loading or reordering", async () => {
    const fights = [
      fight("ab", "A", "B", "G1", true),
      fight("ae", "A", "E"),
      fight("cd", "C", "D"),
    ];
    setup(fights);
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    expect(await screen.findByRole("button", { name: "Usar sugerida" })).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Usar sugerida" }));
    expect(useTournamentStore.getState().fights.map((entry) => entry.id)).toEqual([
      "ab",
      "ae",
      "cd",
    ]);
    expect(
      useTournamentStore.getState().fights[useTournamentStore.getState().currentFightIndex].id
    ).toBe("cd");
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
  });

  it("requires a second deliberate load after keeping the original and rechecks last result", async () => {
    setup([fight("ab", "A", "B", "G1", true), fight("ae", "A", "E"), fight("cd", "C", "D")]);
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Mantener prevista" }));
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("match:load", expect.anything())
    );
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).includes("last-confirmed"));
    expect(calls).toHaveLength(3);
  });

  it("stops the load if a newly confirmed result appears during sync", async () => {
    setup([fight("ab", "A", "B", "G1", true), fight("ae", "A", "E"), fight("cd", "C", "D")]);
    let reads = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("last-confirmed")) {
        reads++;
        return {
          ok: true,
          json: async () => ({ ok: true, last: reads === 1 ? null : last, ambiguous: false }),
        } as Response;
      }
      return { ok: true, json: async () => ({ activeMatchLock: null }) } as Response;
    });
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    expect(await screen.findByRole("button", { name: "Usar sugerida" })).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
  });

  it("warns on an unavailable result instead of treating it as no previous bout", async () => {
    setup([fight("ab", "A", "B", "G1", true), fight("ae", "A", "E")], { ok: false });
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    expect(
      await screen.findByRole("button", { name: "Continuar sin verificación" })
    ).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
  });

  it("requires explicit continuation when the last-result network request rejects", async () => {
    setup([fight("ab", "A", "B", "G1", true), fight("ae", "A", "E")]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("last-confirmed")) throw new Error("network offline");
      return { ok: true, json: async () => ({ activeMatchLock: null }) } as Response;
    });
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    const continueButton = await screen.findByRole("button", {
      name: "Continuar sin verificación",
    });
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
    fireEvent.click(continueButton);
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("match:load", expect.anything())
    );
  });

  it("ignores a delayed last-result reply after manual selection changes", async () => {
    setup([fight("ab", "A", "B", "G1", true), fight("ae", "A", "E"), fight("cd", "C", "D")]);
    let release: (value: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    act(() => useTournamentStore.getState().setCurrentFightIndex(2));
    await act(async () =>
      release({ ok: true, json: async () => ({ ok: true, last, ambiguous: false }) } as Response)
    );
    expect(
      screen.queryByRole("dialog", { name: "Descanso entre combates" })
    ).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
  });

  it("shows the advisory again after recovery/remount with no local override", async () => {
    setup([fight("ab", "A", "B", "G1", true), fight("ae", "A", "E"), fight("cd", "C", "D")]);
    const first = render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Mantener prevista" }));
    first.unmount();
    render(<FightPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Cargar combate" })[0]);
    expect(await screen.findByRole("button", { name: "Usar sugerida" })).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalledWith("match:load", expect.anything());
  });

  it("renders repeated interleaved group labels without duplicate React keys", () => {
    setup([
      fight("ab", "A", "B", "G1", true),
      fight("cd", "C", "D", "G2"),
      fight("ae", "A", "E", "G1"),
    ]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<FightPage />);
    expect(screen.getAllByText("Llave 1").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByTitle("Ver lista de combates"));
    const dialog = screen.getByRole("dialog", { name: /Combates/ });
    const rows = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim() ?? "")
      .filter((label) => /^\d+\./.test(label));
    expect(rows).toEqual(expect.arrayContaining(["1. A vs B", "2. C vs D", "3. A vs E"]));
    expect(rows.map((label) => label.slice(0, 2))).toEqual(["1.", "2.", "3."]);
    expect(within(dialog).getAllByText("Llave G1")).toHaveLength(2);
    expect(error.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    error.mockRestore();
  });
});
