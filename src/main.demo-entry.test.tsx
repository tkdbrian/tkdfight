import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/App", () => {
  throw new Error("Shared App imported in local demo");
});
vi.mock("@/maintenance/full-backup-maintenance", () => {
  throw new Error("Shared maintenance imported in local demo");
});
vi.mock("@/demo/DemoShell", () => ({ DemoShell: () => <main>Demo aislada</main> }));

const originalPath = location.pathname;

afterEach(() => {
  history.replaceState(null, "", originalPath);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
  delete document.documentElement.dataset.tkdDemoBridge;
});

it.each(["/demo", "/demo/"])(
  "%s mounts without checking SQL, touching legacy browser keys, or importing remote App",
  async (path) => {
    history.replaceState(null, "", path);
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const fetchSpy = vi.fn(() => { throw new Error("Remote fetch in local demo"); });
    vi.stubGlobal("fetch", fetchSpy);
    const readLegacyKey = vi.spyOn(Storage.prototype, "getItem");

    await act(async () => { await import("./main"); });
    await waitFor(() => expect(root).toHaveTextContent("Demo aislada"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readLegacyKey).not.toHaveBeenCalled();
  }
);

it("still checks the server before mounting the shared root", async () => {
  history.replaceState(null, "", "/");
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    json: async () => ({ maintenanceRequired: true, buildId: null }),
  }));
  vi.stubGlobal("fetch", fetchSpy);

  await act(async () => { await import("./main"); });
  await waitFor(() => expect(root).toHaveTextContent("Inicio bloqueado por seguridad"));
  expect(fetchSpy).toHaveBeenCalledWith("/boot-status", { cache: "no-store" });
});

it("keeps the old-worker rescue URL outside SQL and legacy storage", async () => {
  history.replaceState(null, "", "/tv/demo");
  document.documentElement.dataset.tkdDemoBridge = "1";
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const fetchSpy = vi.fn(() => { throw new Error("Remote fetch from demo rescue"); });
  vi.stubGlobal("fetch", fetchSpy);
  const readLegacyKey = vi.spyOn(Storage.prototype, "getItem");

  await act(async () => { await import("./main"); });
  await waitFor(() => expect(root).toHaveTextContent("Preparando la demo individual"));
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(readLegacyKey).not.toHaveBeenCalled();
});

it("does not change the legacy /tv/demo behavior without demo build marker", async () => {
  history.replaceState(null, "", "/tv/demo");
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const fetchSpy = vi.fn(async () => ({
    ok: true,
    json: async () => ({ maintenanceRequired: true, buildId: null }),
  }));
  vi.stubGlobal("fetch", fetchSpy);
  await act(async () => { await import("./main"); });
  await waitFor(() => expect(root).toHaveTextContent("Inicio bloqueado por seguridad"));
  expect(fetchSpy).toHaveBeenCalledWith("/boot-status", { cache: "no-store" });
});
