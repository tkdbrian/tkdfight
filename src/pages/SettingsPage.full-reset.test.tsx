import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/pages/SettingsPage";
import { TOURNAMENT_CATEGORY_STORAGE_KEY, useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({ useSocket: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: mocks.useSocket }));
vi.mock("@/lib/tournament-presets", () => ({ fetchPresets: vi.fn(async () => []), savePreset: vi.fn(), deleteServerPreset: vi.fn() }));
const initialState = useTournamentStore.getState();
const listeners = new Set<() => void>();
const socket = { on: (event: string, listener: () => void) => { if (event === "ring:full-reset") listeners.add(listener); },
  off: (event: string, listener: () => void) => { if (event === "ring:full-reset") listeners.delete(listener); } };

beforeEach(() => {
  localStorage.removeItem("tkd-tournament"); localStorage.removeItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
  act(() => {
    useTournamentStore.setState({ ...initialState, config: { ...initialState.config,
      id: "reset-old-category", categoryName: "Anterior" }, competitors: [{ id: "old-person", name: "Alumno" }] });
    useTournamentStore.getState().createCategory();
    useTournamentStore.getState().setConfig({ categoryName: "Borrador" });
  });
  mocks.useSocket.mockReturnValue({ connected: true, stateReady: true, state: {
    activeMatchLock: null, match: null, resultConfirmed: false }, socket });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
});
afterEach(() => {
  cleanup(); listeners.clear(); vi.clearAllMocks(); vi.unstubAllGlobals();
  act(() => useTournamentStore.setState(initialState));
  localStorage.removeItem("tkd-tournament"); localStorage.removeItem(TOURNAMENT_CATEGORY_STORAGE_KEY);
});

async function openReset(): Promise<HTMLElement> {
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Cuadrilátero" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: /^Reiniciar/ }));
  return screen.getByRole("dialog");
}
function rawGraph(): { main: string | null; registry: string | null } {
  return { main: localStorage.getItem("tkd-tournament"), registry: localStorage.getItem(TOURNAMENT_CATEGORY_STORAGE_KEY) };
}

describe("reinicio local únicamente tras aceptación del servidor", () => {
  it("offers full-document maintenance entrypoints for backup and recovery", () => {
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Guardar respaldo completo" }).getAttribute("href"))
      .toBe("/maintenance");
    expect(screen.getByRole("link", { name: "Recuperar respaldo" }).getAttribute("href"))
      .toBe("/maintenance");
  });

  it("cleans every local category on HTTP success even if no socket broadcast arrives", async () => {
    const oldIds = useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id);
    const dialog = await openReset();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Sí, reiniciar/ }));
    await waitFor(() => expect(useTournamentStore.getState().getCategoryEntries()).toHaveLength(1));
    const after = useTournamentStore.getState();
    expect(oldIds).not.toContain(after.config.id); expect(after.competitors).toEqual([]);
    expect(after.fights).toEqual([]); expect(after.phase).toBe("setup");
    expect(after.getCategoryEntries()[0].isDraft).toBe(false);
    expect(fetch).toHaveBeenCalledWith("/api/ring/full-reset", { method: "POST" });
  });

  it("cleans the full local registry when the existing explicit reset broadcast arrives", async () => {
    const oldIds = useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await act(async () => { for (const listener of [...listeners]) listener(); });
    expect(useTournamentStore.getState().getCategoryEntries()).toHaveLength(1);
    expect(oldIds).not.toContain(useTournamentStore.getState().config.id);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps one canonical identity if the broadcast arrives before its successful HTTP response", async () => {
    let broadcastId = "";
    vi.mocked(fetch).mockImplementation(async () => {
      for (const listener of [...listeners]) listener();
      broadcastId = useTournamentStore.getState().config.id;
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    });
    const dialog = await openReset();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Sí, reiniciar/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useTournamentStore.getState().getCategoryEntries().map((entry) => entry.id)).toEqual([broadcastId]);
    expect(useTournamentStore.getState().config.id).toBe(broadcastId);
    const main = JSON.parse(localStorage.getItem("tkd-tournament")!);
    expect(main.state.config.id).toBe(broadcastId);
  });

  it.each(["409", "403", "network", "body-rejected"])("retains all graphs when reset fails (%s)", async (failure) => {
    vi.mocked(fetch).mockImplementation(async () => {
      if (failure === "network") throw new Error("offline");
      return { ok: failure === "body-rejected", status: failure === "409" ? 409 : 403,
        json: async () => ({ ok: false }) } as Response;
    });
    const dialog = await openReset(); const before = rawGraph();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Sí, reiniciar/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rawGraph()).toEqual(before); expect(useTournamentStore.getState().getCategoryEntries()).toHaveLength(2);
  });

  it.each(["disconnected", "unsynchronized", "active-lock"])("does not request or clear anything while %s", async (condition) => {
    const current = mocks.useSocket();
    mocks.useSocket.mockReturnValue({ ...current, connected: condition !== "disconnected",
      stateReady: condition !== "unsynchronized", state: { ...current.state,
        activeMatchLock: condition === "active-lock" ? { fightId: "busy", categoryId: "old" } : null } });
    const dialog = await openReset(); const before = rawGraph();
    fireEvent.click(within(dialog).getByRole("button", { name: /^Sí, reiniciar/ }));
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled(); expect(rawGraph()).toEqual(before);
  });
});
