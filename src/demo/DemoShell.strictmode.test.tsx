import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const { createRuntime, closeRuntime } = vi.hoisted(() => {
  const closeRuntime = vi.fn(async () => {});
  const view = { state: { version: 1, eventId: "test", tournamentName: "Demo", categories: {},
    categoryOrder: [], selectedCategoryId: null, active: null, history: [] }, generation: 1, revision: 0, isWriter: true };
  const runtime = {
    open: vi.fn(async () => view), read: vi.fn(async () => view),
    subscribe: vi.fn(() => () => {}), dispatch: vi.fn(async () => view),
    exportBackup: vi.fn(async () => "{}"), previewImport: vi.fn(), importBackup: vi.fn(),
    reset: vi.fn(async () => view), close: closeRuntime,
  };
  return { createRuntime: vi.fn(() => runtime), closeRuntime };
});
vi.mock("./runtime", () => ({ createBrowserDeskRuntime: createRuntime }));

import { DemoShell } from "./DemoShell";

it("retains one writer runtime across the StrictMode effect replay", async () => {
  const mounted = render(<StrictMode><DemoShell /></StrictMode>);
  await screen.findByRole("heading", { name: "Mesa de prueba" });
  await waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
  expect(closeRuntime).not.toHaveBeenCalled();
  mounted.unmount();
  await waitFor(() => expect(closeRuntime).toHaveBeenCalledTimes(1));
});
