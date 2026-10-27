import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { DemoShell } from "./DemoShell";

const mocks = vi.hoisted(() => {
  const state = { version: 1 as const, eventId: "test", tournamentName: "Demo", categories: {},
    archives: {}, categoryOrder: [], selectedCategoryId: null, active: null, history: [] };
  const first = { state, generation: 1, revision: 0, isWriter: true };
  const second = { state: { ...state, eventId: "new" }, generation: 2, revision: 1, isWriter: true };
  let current = first;
  return {
    first, second, savedId: "", getCurrent: () => current,
    setCurrent: (next: typeof first) => { current = next; },
    dispatch: vi.fn(async (_command: unknown, _id?: string) => current),
    persist: vi.fn(async () => "granted" as const),
    generated: vi.fn((generation: number) => `g${generation}:auto`),
  };
});

vi.mock("./runtime", () => ({
  makeDemoCommandId: mocks.generated,
  createBrowserDeskRuntime: () => ({
    open: async () => mocks.getCurrent(), read: async () => mocks.getCurrent(),
    subscribe: () => () => {}, dispatch: mocks.dispatch,
    reset: async () => { mocks.setCurrent(mocks.second); return mocks.second; },
    close: async () => {}, exportBackup: async () => "{}", previewImport: vi.fn(), importBackup: vi.fn(),
  }),
}));
vi.mock("./storage", () => ({ requestDemoStoragePersistence: mocks.persist }));
vi.mock("./ui/DemoFight", () => ({
  DemoFight: ({ view, dispatch }: { view: { generation: number };
    dispatch: (command: { type: "category/create" } | { type: "category/select"; categoryId: string },
      commandId?: string) => Promise<unknown> }) => <div>
    <p>Generación {view.generation}</p>
    <button type="button" onClick={() => {
      mocks.savedId = `g${view.generation}:retained`;
      void dispatch({ type: "category/create" }, mocks.savedId);
    }}>Crear acción retenida</button>
    <button type="button" onClick={() => void dispatch({ type: "category/create" }, mocks.savedId)}>Reintentar acción retenida</button>
    <button type="button" onClick={() => void dispatch({ type: "category/create" })}>Crear acción nueva</button>
    <button type="button" onClick={() => void dispatch({ type: "category/select", categoryId: "cat-1" })}>Crear acción en cola</button>
  </div>,
}));
vi.mock("./ui/DemoBackup", () => ({
  DemoBackup: ({ reset }: { reset: () => Promise<unknown> }) => {
    const [pending, setPending] = useState(false);
    return <div><p>{pending ? "Respaldo pendiente" : "Respaldo limpio"}</p>
      <button type="button" onClick={() => setPending(true)}>Marcar respaldo pendiente</button>
      <button type="button" onClick={() => void reset()}>Reiniciar prueba</button></div>;
  },
}));

it("keeps old action IDs across reset, rejects their retry, and tags new actions at creation", async () => {
  mocks.setCurrent(mocks.first);
  sessionStorage.setItem("tkd-demo-pending-v1:0:old:cat:categoryName", "Older private title");
  sessionStorage.setItem("tkd-demo-pending-v1:1:test:cat:tableChief", "Pending private chief");
  mocks.dispatch.mockReset().mockImplementation(async (_command, id) => {
    if (id?.startsWith("g1:") && mocks.getCurrent().generation === 2) throw new Error("Acción antigua");
    return mocks.getCurrent();
  });
  render(<DemoShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Combate" }));
  await screen.findByText("Generación 1");
  expect(sessionStorage.getItem("tkd-demo-pending-v1:0:old:cat:categoryName")).toBeNull();
  expect(sessionStorage.getItem("tkd-demo-pending-v1:1:test:cat:tableChief")).toBe("Pending private chief");
  fireEvent.click(screen.getByRole("button", { name: "Crear acción retenida" }));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith({ type: "category/create" }, "g1:retained"));
  fireEvent.click(screen.getByRole("button", { name: "Respaldo" }));
  fireEvent.click(screen.getByRole("button", { name: "Marcar respaldo pendiente" }));
  expect(screen.getByText("Respaldo pendiente")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Reiniciar prueba" }));
  await screen.findByText("Respaldo limpio");
  fireEvent.click(screen.getByRole("button", { name: "Combate" }));
  await screen.findByText("Generación 2");
  expect(sessionStorage.getItem("tkd-demo-pending-v1:1:test:cat:tableChief")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar acción retenida" }));
  await screen.findByText("Acción antigua");
  expect(mocks.dispatch).toHaveBeenLastCalledWith({ type: "category/create" }, "g1:retained");
  fireEvent.click(screen.getByRole("button", { name: "Crear acción nueva" }));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenLastCalledWith({ type: "category/create" }, "g2:auto"));
  expect(mocks.generated).toHaveBeenCalledWith(2);
});

it("captures a queued command's generation before a reset and never retags it afterward", async () => {
  mocks.setCurrent(mocks.first);
  mocks.generated.mockClear();
  let releaseFirst!: (view: typeof mocks.first) => void;
  const stalled = new Promise<typeof mocks.first>((resolve) => { releaseFirst = resolve; });
  mocks.dispatch.mockReset().mockImplementationOnce(async () => stalled)
    .mockImplementation(async (_command, id) => {
      if (id?.startsWith("g1:") && mocks.getCurrent().generation === 2) throw new Error("Acción antigua");
      return mocks.getCurrent();
    });
  render(<DemoShell />);
  fireEvent.click(await screen.findByRole("button", { name: "Combate" }));
  await screen.findByText("Generación 1");
  fireEvent.click(screen.getByRole("button", { name: "Crear acción retenida" }));
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Crear acción en cola" }));
  expect(mocks.generated).toHaveBeenCalledWith(1);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Respaldo" }));
  fireEvent.click(screen.getByRole("button", { name: "Reiniciar prueba" }));
  await screen.findByText("Respaldo limpio");
  releaseFirst(mocks.first);
  await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(
    { type: "category/select", categoryId: "cat-1" }, "g1:auto"));
  fireEvent.click(screen.getByRole("button", { name: "Combate" }));
  expect(await screen.findByText("Generación 2")).toBeVisible();
});

it("requests browser persistence only after an explicit click and reports the result", async () => {
  mocks.setCurrent(mocks.first);
  mocks.persist.mockClear();
  render(<DemoShell />);
  expect(mocks.persist).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Conservar demo en este navegador" }));
  await waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/El navegador aceptó conservar los datos locales/)).toBeVisible();
  expect(screen.getByText(/Exportá respaldos igualmente/)).toBeVisible();
});
