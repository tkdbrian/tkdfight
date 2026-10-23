import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const appImport = vi.hoisted(() => vi.fn());
vi.mock("@/App", () => {
  appImport();
  return { App: () => null };
});

const oldLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
afterEach(() => {
  if (oldLocks) Object.defineProperty(navigator, "locks", oldLocks);
  else Reflect.deleteProperty(navigator, "locks");
  vi.unstubAllGlobals();
  vi.resetModules();
  appImport.mockReset();
  localStorage.clear();
  document.body.replaceChildren();
});

it("blocks App before hydration when SQL has tournament data but this browser has no category registry", async () => {
  localStorage.clear();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        maintenanceRequired: false,
        buildId: null,
        hasTournamentData: true,
      }),
    }))
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock) => Promise<void>
      ) => callback({ name: "tkd-tournament-operation" } as Lock),
    },
  });
  await import("./main");
  await waitFor(() => expect(root.textContent).toMatch(/categor|perfil|respaldo|recuperaci.n/i));
  expect(appImport).not.toHaveBeenCalled();
});
