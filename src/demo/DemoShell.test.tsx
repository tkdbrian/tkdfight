import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEMO_SHELL_ASSET_PATH, DemoShell } from "./DemoShell";

vi.mock("./runtime", () => ({
  createBrowserDeskRuntime: () => ({
    subscribe: () => () => {},
    open: async () => null,
    close: async () => {},
  }),
}));

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

afterEach(() => {
  if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
  else Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllGlobals();
  document.head.querySelectorAll("[data-demo-test]").forEach((node) => { node.remove(); });
});

function stubWorker(scriptPath: string, register = vi.fn().mockResolvedValue({})) {
  const controller = { scriptURL: new URL(scriptPath, location.origin).href };
  const scope = scriptPath === "/demo-sw.js" ? "/demo/" : "/";
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      ready: Promise.resolve({}),
      register,
      getRegistration: async () => ({
        scope: new URL(scope, location.origin).href,
        active: controller,
        installing: null,
        waiting: null,
      }),
    },
  });
  return register;
}

function stubPrecache(name: string, paths: string[]) {
  vi.stubGlobal("caches", {
    keys: async () => [name],
    open: async () => ({
      keys: async () => paths.map((path) => ({ url: new URL(path, location.origin).href })),
    }),
  });
}

it("does not promise offline use when the browser lacks service workers", async () => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  render(<DemoShell />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("no ofrece almacenamiento"));
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("Sin uso offline; seguí online"))).toBe(true);
  fireEvent.click(screen.getByText("Detalles"));
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("no ofrece almacenamiento"))).toBe(true);
});

it("recognizes only a scoped demo worker with its current revisioned app assets", async () => {
  const register = stubWorker("/demo-sw.js");
  stubPrecache("tkd-browser-demo-precache-v2", [
    "/index.html?__WB_REVISION__=abc", DEMO_SHELL_ASSET_PATH,
  ]);
  render(<DemoShell />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("listos para abrir sin conexión"));
  expect(register).not.toHaveBeenCalled(); // An offline reload can use its existing current cache.
});

it("rejects an old root worker and old Workbox cache", async () => {
  stubWorker("/sw.js");
  stubPrecache("workbox-precache-v2", ["/index.html?__WB_REVISION__=old", DEMO_SHELL_ASSET_PATH]);
  render(<DemoShell />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Preparando archivos"));
});

it("does not report ready when an updated entry asset has not been precached", async () => {
  stubWorker("/demo-sw.js");
  stubPrecache("tkd-browser-demo-precache-v2", ["/index.html?__WB_REVISION__=old", DEMO_SHELL_ASSET_PATH]);
  const script = document.createElement("script");
  script.type = "module";
  script.src = "/assets/index-new.js";
  script.dataset.demoTest = "";
  document.head.append(script);
  render(<DemoShell />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Preparando archivos"));
});

it("explains denied worker registration and allows retry without disabling the online desk", async () => {
  let cacheReady = false;
  const register = vi.fn().mockRejectedValueOnce(new Error("Denied")).mockImplementation(async () => {
    cacheReady = true;
    return {};
  });
  stubWorker("/demo-sw.js", register);
  vi.stubGlobal("caches", {
    keys: async () => cacheReady ? ["tkd-browser-demo-precache-v2"] : [],
    open: async () => ({ keys: async () => ["/index.html", DEMO_SHELL_ASSET_PATH].map((path) => ({ url: new URL(path, location.origin).href })) }),
  });
  render(<DemoShell />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No está lista para uso sin conexión; sigue disponible online"));
  expect(register).toHaveBeenCalledWith("/demo-sw.js", { scope: "/demo/" });
  fireEvent.click(screen.getByText("Detalles"));
  fireEvent.click(screen.getByRole("button", { name: /Reintentar descarga/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("listos para abrir sin conexión"));
  expect(register).toHaveBeenCalledTimes(2);
});

it("reports a failed precache inspection instead of preparing forever", async () => {
  stubWorker("/demo-sw.js");
  vi.stubGlobal("caches", { keys: vi.fn().mockRejectedValue(new Error("CacheStorage denied")) });
  render(<DemoShell />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No está lista para uso sin conexión; sigue disponible online"));
  fireEvent.click(screen.getByText("Detalles"));
  expect(screen.getByRole("button", { name: /Reintentar descarga/ })).toBeVisible();
});

it("times out a worker registration that never settles", async () => {
  vi.useFakeTimers();
  try {
    stubWorker("/demo-sw.js", vi.fn(() => new Promise(() => {})));
    stubPrecache("tkd-browser-demo-precache-v2", []);
    render(<DemoShell />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("status")).toHaveTextContent("No está lista para uso sin conexión; sigue disponible online");
  } finally { vi.useRealTimers(); }
});
