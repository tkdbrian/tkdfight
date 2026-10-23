import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const mounted = vi.fn();
vi.mock("@/maintenance/full-backup-maintenance", () => ({ mountBackupMaintenance: mounted }));
vi.mock("@/App", () => {
  throw new Error("Writable App imported before maintenance gate");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
  mounted.mockReset();
});

it("does not evaluate App/store imports when server reports pending SQL restore", async () => {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        maintenanceRequired: true,
        buildId: null,
      }),
    }))
  );
  await import("./main");
  await waitFor(() => expect(mounted).toHaveBeenCalledWith(root));
  expect(root.textContent).not.toContain("Writable App imported");
});
