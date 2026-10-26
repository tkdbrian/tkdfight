import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateGroupsTournament } from "@/lib/bracket";
import { SetupPage } from "@/pages/SetupPage";
import { CATEGORY_START_RECOVERY_REASON, useTournamentStore } from "@/store/tournament";

vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({
    socket: null,
    connected: true,
    stateReady: true,
    state: { match: null, activeMatchLock: null },
  }),
}));
vi.mock("@/lib/tournament-presets", async (original) => ({
  ...(await original<typeof import("@/lib/tournament-presets")>()),
  fetchPresets: async () => [],
}));

const initial = useTournamentStore.getState();
const competitors = Array.from({ length: 6 }, (_, index) => ({
  id: `rr-${index}`,
  name: `Athlete ${index}`,
}));

beforeEach(() => {
  sessionStorage.clear();
  useTournamentStore.setState({
    ...initial,
    config: { ...initial.config, id: crypto.randomUUID(), rrOrderMode: "rest-optimized" },
    competitors,
    fights: [],
    groups: [],
    bracketMatches: [],
    setupStarted: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}"))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useTournamentStore.setState(initial, true);
  localStorage.clear();
  sessionStorage.clear();
});

async function renderSetup(): Promise<void> {
  await act(async () =>
    render(
      <MemoryRouter>
        <SetupPage />
      </MemoryRouter>
    )
  );
}

it("defaults a new multi-group category to chronological recovery ordering and persists selection", async () => {
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: "No especificar Edad" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Peso" }));
  fireEvent.click(screen.getByRole("button", { name: "Round Robin" }));
  expect(screen.getByRole("button", { name: "Optimizar descanso (un tatami)" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  expect(screen.getAllByText(/Llave G[12]/).map((node) => node.textContent)).toEqual([
    "Llave G1",
    "Llave G2",
    "Llave G1",
    "Llave G2",
    "Llave G1",
    "Llave G2",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Por llave (varios tatamis)" }));
  expect(useTournamentStore.getState().config.rrOrderMode).toBe("group-blocks");
  expect(useTournamentStore.getState().categoryOperationReason).toBeNull();
  expect(screen.getAllByText(/Llave G[12]/).map((node) => node.textContent)).toEqual([
    "Llave G1",
    "Llave G1",
    "Llave G1",
    "Llave G2",
    "Llave G2",
    "Llave G2",
  ]);
});

it("reveals the order choice when the sixth entrant arrives after guided setup", async () => {
  useTournamentStore.setState({ competitors: competitors.slice(0, 5) });
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: "No especificar Edad" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Sistema de grado" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Género" }));
  fireEvent.click(screen.getByRole("button", { name: "Sparring" }));
  fireEvent.click(screen.getByRole("button", { name: "No especificar Peso" }));
  fireEvent.click(screen.getByRole("button", { name: "Round Robin" }));
  expect(screen.queryByRole("group", { name: "Orden de combates" })).not.toBeInTheDocument();
  act(() => useTournamentStore.getState().addCompetitor({ name: "Sixth entrant" }));
  expect(screen.getByRole("group", { name: "Orden de combates" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Optimizar descanso (un tatami)" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

it("does not expose retroactive order controls or reorder saved fights", async () => {
  const saved = generateGroupsTournament(competitors, "SERPENTINE", "group-blocks");
  useTournamentStore.setState({
    ...useTournamentStore.getState(),
    ...saved,
    phase: "fighting",
    setupStarted: true,
    config: { ...useTournamentStore.getState().config, rrOrderMode: "rest-optimized" },
  });
  await renderSetup();
  expect(
    screen.queryByRole("button", { name: "Optimizar descanso (un tatami)" })
  ).not.toBeInTheDocument();
  expect(useTournamentStore.getState().fights).toEqual(saved.fights);
  expect(screen.getAllByText(/Llave G[12]/).map((node) => node.textContent)).toEqual([
    "Llave G1",
    "Llave G1",
    "Llave G1",
    "Llave G2",
    "Llave G2",
    "Llave G2",
  ]);
});

it("refuses stale start when the order policy changes while ring status is pending", async () => {
  useTournamentStore.getState().setConfig({ categoryName: "Race RR" });
  let finishStatus: ((response: Response) => void) | undefined;
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    url === "/api/ring/status"
      ? new Promise<Response>((resolve) => {
          finishStatus = resolve;
        })
      : Promise.resolve(new Response("{}"))
  );
  vi.stubGlobal("fetch", fetcher);
  await renderSetup();
  const start = screen.getByTestId("category-primary-action");
  expect(start).toBeEnabled();
  fireEvent.click(start);
  expect(fetcher).toHaveBeenCalledWith("/api/ring/status");
  act(() =>
    useTournamentStore.setState((state) => ({
      config: { ...state.config, rrOrderMode: "group-blocks" },
    }))
  );
  await act(async () => finishStatus?.(new Response("{}")));
  await waitFor(() => expect(useTournamentStore.getState().fights).toEqual([]));
  expect(fetcher.mock.calls.some(([url]) => url === "/api/ring/sync-fights")).toBe(false);
  expect(useTournamentStore.getState().phase).toBe("setup");
  expect(useTournamentStore.getState().config.rrOrderMode).toBe("group-blocks");
});

it("serializes edits and category switches during sync, committing one server fixture", async () => {
  useTournamentStore.getState().setConfig({ categoryName: "Race RR" });
  let finishSync: ((response: Response) => void) | undefined;
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    url === "/api/ring/sync-fights"
      ? new Promise<Response>((resolve) => {
          finishSync = resolve;
        })
      : Promise.resolve(new Response("{}"))
  );
  vi.stubGlobal("fetch", fetcher);
  await renderSetup();
  fireEvent.click(screen.getByRole("button", { name: /Configurar categoría/ }));
  fireEvent.click(screen.getByTestId("category-primary-action"));
  await waitFor(() => expect(finishSync).toBeDefined());
  const before = useTournamentStore.getState();
  expect(screen.getByText("Por llave (varios tatamis)").closest("button")).toBeDisabled();
  act(() => useTournamentStore.getState().setConfig({ rrOrderMode: "group-blocks" }));
  act(() => useTournamentStore.getState().addCompetitor({ name: "Late entrant" }));
  expect(useTournamentStore.getState().createCategory()).toBeNull();
  expect(useTournamentStore.getState().selectCategory("other-category")).toBe(false);
  expect(useTournamentStore.getState().config).toBe(before.config);
  expect(useTournamentStore.getState().competitors).toBe(before.competitors);
  await act(async () => finishSync?.(new Response("{}")));
  const committed = useTournamentStore.getState();
  expect(committed.categoryOperationReason).toBeNull();
  expect(committed.phase).toBe("fighting");
  expect(committed.fights.map((fight) => fight.groupId).join("")).toBe("G1G2G1G2G1G2");
  const syncs = fetcher.mock.calls.filter(([url]) => url === "/api/ring/sync-fights");
  expect(syncs).toHaveLength(1);
  expect(
    JSON.parse(String(syncs[0][1]?.body)).fights.map((fight: { id: string }) => fight.id)
  ).toEqual(committed.fights.map((fight) => fight.id));
  fireEvent.click(screen.getByTestId("category-primary-action"));
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/ring/sync-fights")).toHaveLength(1);
});

it("allows only one start when status replies are delayed across rapid clicks", async () => {
  useTournamentStore.getState().setConfig({ categoryName: "Race RR" });
  const finishStatuses: Array<(response: Response) => void> = [];
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    url === "/api/ring/status"
      ? new Promise<Response>((resolve) => {
          finishStatuses.push(resolve);
        })
      : Promise.resolve(new Response("{}"))
  );
  vi.stubGlobal("fetch", fetcher);
  await renderSetup();
  const initialStatuses = finishStatuses.length;
  const start = screen.getByTestId("category-primary-action");
  fireEvent.click(start);
  fireEvent.click(start);
  await act(async () => {
    finishStatuses.forEach((resolve) => {
      resolve(new Response("{}"));
    });
  });
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/ring/status")).toHaveLength(
    initialStatuses + 1
  );
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/ring/sync-fights")).toHaveLength(1);
  expect(useTournamentStore.getState().fights).toHaveLength(6);
});

it("fails closed after an unexpected state replacement following a successful sync", async () => {
  useTournamentStore.getState().setConfig({ categoryName: "Race RR" });
  let finishSync: ((response: Response) => void) | undefined;
  const fetcher = vi.fn((url: string, _options?: RequestInit) =>
    url === "/api/ring/sync-fights"
      ? new Promise<Response>((resolve) => {
          finishSync = resolve;
        })
      : Promise.resolve(new Response("{}"))
  );
  vi.stubGlobal("fetch", fetcher);
  await renderSetup();
  fireEvent.click(screen.getByTestId("category-primary-action"));
  await waitFor(() => expect(finishSync).toBeDefined());
  act(() =>
    useTournamentStore.setState((state) => ({
      config: { ...state.config, rrOrderMode: "group-blocks" },
    }))
  );
  await act(async () => finishSync?.(new Response("{}")));
  expect(useTournamentStore.getState().categoryOperationReason).toBe(
    CATEGORY_START_RECOVERY_REASON
  );
  expect(useTournamentStore.getState().fights).toEqual([]);
  useTournamentStore.getState().setCategoryOperationReason(null);
  expect(useTournamentStore.getState().categoryOperationReason).toBe(
    CATEGORY_START_RECOVERY_REASON
  );
  fireEvent.click(screen.getByTestId("category-primary-action"));
  expect(fetcher.mock.calls.filter(([url]) => url === "/api/ring/sync-fights")).toHaveLength(1);
});
