#!/usr/bin/env node
// Local browser regression: pass a built v4.1.1 dist and a built demo dist.
// No public site, SQL database, or existing browser profile is touched.
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright";

if (process.argv.length !== 4) {
  throw new Error("Usage: node scripts/verify-demo-legacy-migration.mjs <v4.1.1-dist> <demo-dist>");
}
const oldDist = resolve(process.argv[2]);
const demoDist = resolve(process.argv[3]);
for (const path of [join(oldDist, "sw.js"), join(oldDist, "registerSW.js"), join(demoDist, "demo-sw.js")]) {
  assert.ok(existsSync(path), `Missing build artifact: ${path}`);
}
assert.match(readFileSync(join(oldDist, "sw.js"), "utf8"), /\^\\\/tv/);
assert.match(readFileSync(join(demoDist, "index.html"), "utf8"), /id="tkd-demo-legacy-bridge"/);

let currentDist = oldDist;
const mime = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
};
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/boot-status") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ maintenanceRequired: false, buildId: null, hasTournamentData: false }));
    return;
  }
  let file = resolve(currentDist, `.${pathname}`);
  const pathWithinDist = relative(currentDist, file);
  if (pathWithinDist.startsWith("..") || isAbsolute(pathWithinDist) || !existsSync(file) || !statSync(file).isFile()) {
    file = join(currentDist, "index.html");
  }
  response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.end(readFileSync(file));
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not bind local test server");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"));
  currentDist = demoDist;
  const operationalRequests = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/boot-status" || path.startsWith("/api/") || path.startsWith("/socket.io")) operationalRequests.push(path);
  });
  // /tv/* is deliberately excluded from the v4.1.1 root worker's navigation fallback.
  await page.goto(`${origin}/tv/demo`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Mesa de prueba/ }).waitFor();
  await page.getByRole("status").getByText(/Archivos de la app listos/).waitFor();
  const state = await page.evaluate(() => ({
    path: location.pathname,
    worker: navigator.serviceWorker.controller?.scriptURL,
  }));
  assert.equal(state.path, "/demo/");
  assert.equal(state.worker, `${origin}/demo-sw.js`);
  assert.deepEqual(operationalRequests, []);
  await context.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.getByRole("heading", { name: /Mesa de prueba/ }).waitFor();
  console.log("v4.1.1 root worker → /tv/demo rescue → /demo/ offline: PASS");
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
