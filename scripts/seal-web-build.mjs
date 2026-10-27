#!/usr/bin/env node
// Web-only artifact sealing. Does not modify portable packaging or runtime guards.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertRegularFile, rewriteIndexRevision } from "./release-sunday/pack-core.mjs";

// The demo worker is scoped to /demo but its navigation fallback must be the
// root /index.html. Keep the portable sealer's stricter legacy fallback intact.
function rewriteDemoIndexRevision(sw, oldRevision, newRevision) {
  const demoFallback = 'createHandlerBoundToURL("/index.html")';
  const legacyFallback = 'createHandlerBoundToURL("index.html")';
  if (sw.split(demoFallback).length !== 2 || sw.includes(legacyFallback)) {
    throw new Error("Demo PWA must navigate to exactly one root /index.html fallback");
  }
  return rewriteIndexRevision(sw.replace(demoFallback, legacyFallback), oldRevision, newRevision)
    .replace(legacyFallback, demoFallback);
}

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--root" || !args[1])) {
  throw new Error("Usage: node scripts/seal-web-build.mjs [--root <built-web-root>]");
}
const root = resolve(args[1] ?? process.cwd());
const commit = process.env.RENDER_GIT_COMMIT ?? execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: process.cwd(), encoding: "utf8", windowsHide: true,
}).trim();
if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error("Invalid commit identity");
const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
const buildId = `web-${commit.slice(0, 12).toLowerCase()}-${timestamp}`;
const browserDemoBuild = process.env.TKD_BROWSER_DEMO_BUILD === "1";
const htmlPath = join(root, "dist", "index.html");
const swPath = join(root, "dist", browserDemoBuild ? "demo-sw.js" : "sw.js");
const rootSwPath = join(root, "dist", "sw.js");
const identityPath = join(root, "build-id.json");
for (const file of [htmlPath, swPath, join(root, "dist-server", "index.mjs")]) assertRegularFile(file);
if (browserDemoBuild) {
  const rootManifestPath = join(root, "dist", "manifest.webmanifest");
  const demoManifestPath = join(root, "dist", "demo.webmanifest");
  for (const file of [rootSwPath, rootManifestPath, demoManifestPath]) assertRegularFile(file);
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  const demoManifest = JSON.parse(readFileSync(demoManifestPath, "utf8"));
  if (rootManifest.start_url !== "/" || rootManifest.scope !== "/" || rootManifest.orientation !== "landscape"
      || demoManifest.start_url !== "/demo/" || demoManifest.scope !== "/demo/" || demoManifest.orientation !== "any"
      || existsSync(join(root, "dist", "registerSW.js"))) {
    throw new Error("Demo/root PWA manifest or registration isolation mismatch");
  }
}
if (existsSync(identityPath)) assertRegularFile(identityPath);
const originalHtml = readFileSync(htmlPath, "utf8");
const originalSw = readFileSync(swPath, "utf8");
const originalRootSw = browserDemoBuild ? readFileSync(rootSwPath, "utf8") : null;
if (browserDemoBuild && (!originalHtml.includes('id="tkd-demo-canonical"')
    || !originalHtml.includes('id="tkd-demo-legacy-bridge"')
    || !originalHtml.includes("dataset.tkdDemoBridge='1'")
    || !originalHtml.includes('id="tkd-worker-registration"')
    || !originalHtml.includes("navigator.serviceWorker.register('/sw.js',{scope:'/'})")
    || !originalHtml.includes("demo.webmanifest")
    || !originalSw.includes("tkd-browser-demo")
    || !originalRootSw?.includes("api-cache")
    || !originalRootSw.includes("demo(?:")
    || originalRootSw.includes("cleanupOutdatedCaches")
    || originalRootSw.includes("clientsClaim"))) {
  throw new Error("Demo/root PWA worker isolation mismatch");
}
if (/<meta\b[^>]*name\s*=\s*["']tkd-build-id["']/i.test(originalHtml)) {
  throw new Error("Web HTML already sealed; rebuild before sealing again");
}
if ([...originalHtml.matchAll(/<\/head\s*>/gi)].length !== 1) throw new Error("Expected exactly one closing head");
const oldRevision = createHash("md5").update(originalHtml).digest("hex");
const html = originalHtml.replace(/<\/head\s*>/i, `  <meta name="tkd-build-id" content="${buildId}">\n</head>`);
const revision = createHash("md5").update(html).digest("hex");
const sw = browserDemoBuild
  ? rewriteDemoIndexRevision(originalSw, oldRevision, revision)
  : rewriteIndexRevision(originalSw, oldRevision, revision);
const rootSw = originalRootSw === null ? null : rewriteIndexRevision(originalRootSw, oldRevision, revision);
// Assert the final service worker points to the exact bytes about to be written.
if (browserDemoBuild) rewriteDemoIndexRevision(sw, revision, revision);
else rewriteIndexRevision(sw, revision, revision);
if (rootSw !== null) rewriteIndexRevision(rootSw, revision, revision);
// All identity, raw-HTML and PWA validation completes before the first write.
writeFileSync(htmlPath, html, "utf8");
writeFileSync(swPath, sw, "utf8");
if (rootSw !== null) writeFileSync(rootSwPath, rootSw, "utf8");
writeFileSync(identityPath, JSON.stringify({ buildId, backupSchemaVersion: 1 }, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ buildId, indexMd5: revision }));
