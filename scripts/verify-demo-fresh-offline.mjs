#!/usr/bin/env node
// Isolated Chromium acceptance for a freshly built opt-in demo; never contacts the public site.
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright";

const dist = resolve(process.argv[2] ?? "dist");
assert.ok(existsSync(join(dist, "demo-sw.js")), "Build with TKD_BROWSER_DEMO_BUILD=1 first");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const operationalRequests = [];
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/boot-status" || pathname.startsWith("/api/") || pathname.startsWith("/socket.io")) {
    operationalRequests.push(pathname);
    response.writeHead(503).end("Demo must not request shared operations");
    return;
  }
  let file = resolve(dist, `.${pathname}`);
  const within = relative(dist, file);
  if (within.startsWith("..") || isAbsolute(within) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, "index.html");
  response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not bind test server");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto(`${origin}/demo/`, { waitUntil: "load" });
  await page.getByRole("heading", { name: /Mesa de prueba/ }).waitFor();
  await page.getByRole("status").getByText(/Archivos de la app listos/).waitFor({ timeout: 20_000 });
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), `${origin}/demo-sw.js`);
  assert.deepEqual(operationalRequests, []);
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.getByRole("heading", { name: /Mesa de prueba/ }).waitFor();
  await page.getByRole("status").getByText(/Archivos de la app listos/).waitFor();
  assert.deepEqual(operationalRequests, []);
  console.log("Fresh /demo/ load → scoped worker → offline reload: PASS");
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
