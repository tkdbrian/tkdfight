#!/usr/bin/env node
// Run after a `TKD_BROWSER_DEMO_BUILD=1` build against an isolated output; never contacts a server.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");
const mode = process.argv[3] ?? "demo";
const read = (name) => readFileSync(join(dist, name), "utf8");
const manifest = JSON.parse(read(mode === "demo" ? "demo.webmanifest" : "manifest.webmanifest"));
const html = read("index.html");
const sw = read(mode === "demo" ? "demo-sw.js" : "sw.js");
const assets = readdirSync(join(dist, "assets"));

assert.match(sw, /precacheAndRoute/);
assert.match(sw, /url:"index\.html"/);

const demoChunk = assets.find((name) => /^DemoShell-.*\.js$/.test(name));
const entryChunk = assets.find((name) => /^index-.*\.js$/.test(name));
assert.ok(demoChunk, "DemoShell chunk missing");
assert.ok(entryChunk, "Entry chunk missing");
for (const file of [demoChunk, entryChunk]) {
  assert.ok(sw.includes(`assets/${file}`), `${file} must be precached`);
}

if (mode === "demo") {
  assert.equal(manifest.start_url, "/demo/", "Installed demo must reopen /demo/");
  assert.equal(manifest.scope, "/demo/", "Installed demo must not claim the shared root");
  assert.equal(manifest.orientation, "any", "Demo must allow portrait mobile use");
  const rootManifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(rootManifest.start_url, "/");
  assert.equal(rootManifest.scope, "/");
  assert.equal(rootManifest.orientation, "landscape");
  assert.match(sw, /createHandlerBoundToURL\("\/index\.html"\)/);
  assert.match(sw, /tkd-browser-demo/);
  assert.match(sw, /boot-status/);
  assert.match(sw, /socket\\\.io/);
  assert.ok(!sw.includes("api-cache"), "Operational API responses must not be cached");
  assert.match(html, /id="tkd-worker-registration"/);
  assert.match(html, /id="tkd-demo-canonical"/);
  assert.match(html, /id="tkd-demo-legacy-bridge"/);
  assert.match(html, /dataset\.tkdDemoBridge='1'/);
  assert.match(html, /\/tv\/demo/);
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js',\{scope:'\/'\}\)/);
  assert.ok(!html.includes("demo?'/demo-sw.js':'/sw.js'"), "DemoShell must own demo worker registration and failures");
  assert.match(html, /demo\.webmanifest/);
  assert.ok(!existsSync(join(dist, "registerSW.js")), "Dual-worker build must not register both scopes blindly");
  const rootSw = read("sw.js");
  assert.ok(rootSw.includes("demo(?:"), "Root bridge must pass /demo navigations to the network");
  assert.ok(rootSw.includes("api-cache"), "Root bridge must preserve remote API caching");
  assert.ok(!rootSw.includes("cleanupOutdatedCaches"), "Root bridge must not erase the demo precache");
  assert.ok(!rootSw.includes("clientsClaim"), "Root bridge must not take control of demo clients");
} else if (mode === "legacy") {
  assert.equal(manifest.start_url, "/", "Existing installed app must still open root");
  assert.equal(manifest.scope, "/", "Existing installed app scope must remain root");
  assert.ok(sw.includes("api-cache"), "Legacy remote API caching must be preserved");
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  const registration = read("registerSW.js");
  assert.match(registration, /register\('\/sw\.js', \{ scope: '\/' \}\)/);
} else {
  throw new Error("Expected mode 'demo' or 'legacy'");
}

console.log(`${mode} offline build verified: ${dist}`);
