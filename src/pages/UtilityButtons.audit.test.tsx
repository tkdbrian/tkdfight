import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "@/pages/SettingsPage";
import { StandingsPage } from "@/pages/StandingsPage";
import { useTournamentStore } from "@/store/tournament";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true, stateReady: true,
  state: { activeMatchLock: null, match: null, ringAlias: "T1", ringName: "Original" },
  request: mocks.request }) }));
vi.mock("@/lib/tournament-presets", () => ({ fetchPresets: vi.fn(async () => []),
  savePreset: vi.fn(), deleteServerPreset: vi.fn() }));
vi.mock("canvas-confetti", () => ({ default: vi.fn() }));
const initial = useTournamentStore.getState();

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.request.mockReset();
  localStorage.clear(); act(() => useTournamentStore.setState(initial, true));
  localStorage.clear();
});

it.each([403, 500])("never claims the tatami name was saved after HTTP %s", async (status) => {
  const fetchMock = vi.fn(async () => ({ ok: false, status,
    json: async () => ({ error: "Nombre no guardado" }) }));
  vi.stubGlobal("fetch", fetchMock);
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Cuadrilátero" }), { button: 0, ctrlKey: false });
  fireEvent.change(await screen.findByLabelText("Nombre completo"), { target: { value: "Nuevo nombre" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar nombre" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ring/config", expect.objectContaining({ method: "PUT" })));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole("button", { name: "Guardado" })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent(/No se pudo guardar/);
});

it.each(["network", "malformed", "mismatched"])("shows an error instead of saved for %s acknowledgment", async (kind) => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (kind === "network") throw new Error("offline");
    return { ok: true, json: async () => kind === "malformed" ? { ok: true } : { alias: "T1", name: "Different" } };
  }));
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Cuadrilátero" }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("button", { name: "Guardar nombre" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo guardar/);
  expect(screen.queryByRole("button", { name: "Guardado" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Guardar nombre" })).toBeEnabled();
});

it("locks pending edits and duplicate saves, then accepts only the requested name", async () => {
  let release: (response: Response) => void = () => {};
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter><SettingsPage /></MemoryRouter>);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Cuadrilátero" }), { button: 0, ctrlKey: false });
  fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: " Nuevo nombre " } });
  const save = screen.getByRole("button", { name: "Guardar nombre" });
  fireEvent.click(save); fireEvent.click(save);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Nombre completo")).toBeDisabled();
  expect(screen.getByLabelText("Alias corto")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Guardado" })).not.toBeInTheDocument();
  await act(async () => release(new Response(JSON.stringify({ alias: "T1", name: "Nuevo nombre" }))));
  expect(screen.getByRole("button", { name: "Guardado" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Nombre completo"), { target: { value: "Otra edición" } });
  expect(screen.queryByRole("button", { name: "Guardado" })).not.toBeInTheDocument();
});

it("escapes all CSV string fields without changing tournament data", () => {
  const groupId = 'Llave "A", 1';
  const competitors = [{ id: "quoted-a", name: 'Ana "A", Uno', team: 'Club "Sur"\nSede' },
    { id: "quoted-b", name: "Beto", team: "Norte" }];
  act(() => useTournamentStore.setState({ ...initial,
    config: { ...initial.config, id: "csv-audit", mode: "round-robin", categoryName: "CSV audit" },
    competitors, groups: [{ id: groupId, competitors, size: 2 }],
    fights: [{ id: "csv-fight", red: competitors[0], blue: competitors[1], groupId, completed: false }],
    phase: "fighting" }));
  let csv = "";
  const NativeBlob = Blob;
  vi.stubGlobal("Blob", class extends NativeBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options); csv = String(parts[0]);
    }
  });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:audit") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<MemoryRouter><StandingsPage /></MemoryRouter>);
  const before = JSON.stringify(useTournamentStore.getState());
  const button = screen.getByRole("button", { name: "Exportar CSV" });
  expect(button).toBeEnabled(); fireEvent.click(button);
  expect(csv).toContain('"Llave ""A"", 1"');
  expect(csv).toContain('"Ana ""A"", Uno","Club ""Sur""\nSede"');
  expect(JSON.stringify(useTournamentStore.getState())).toBe(before);
});
