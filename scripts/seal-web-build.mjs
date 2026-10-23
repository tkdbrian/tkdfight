#!/usr/bin/env node
// Web-only artifact sealing. Does not modify portable packaging or runtime guards.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertRegularFile, rewriteIndexRevision } from "./release-sunday/pack-core.mjs";

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
const htmlPath = join(root, "dist", "index.html");
const swPath = join(root, "dist", "sw.js");
const identityPath = join(root, "build-id.json");
for (const file of [htmlPath, swPath, join(root, "dist-server", "index.mjs")]) assertRegularFile(file);
if (existsSync(identityPath)) assertRegularFile(identityPath);
const originalHtml = readFileSync(htmlPath, "utf8");
const originalSw = readFileSync(swPath, "utf8");
if (/<meta\b[^>]*name\s*=\s*["']tkd-build-id["']/i.test(originalHtml)) {
  throw new Error("Web HTML already sealed; rebuild before sealing again");
}
if ([...originalHtml.matchAll(/<\/head\s*>/gi)].length !== 1) throw new Error("Expected exactly one closing head");
const oldRevision = createHash("md5").update(originalHtml).digest("hex");
const html = originalHtml.replace(/<\/head\s*>/i, `  <meta name="tkd-build-id" content="${buildId}">\n</head>`);
const revision = createHash("md5").update(html).digest("hex");
const sw = rewriteIndexRevision(originalSw, oldRevision, revision);
// Assert the final service worker points to the exact bytes about to be written.
rewriteIndexRevision(sw, revision, revision);
// All identity, raw-HTML and PWA validation completes before the first write.
writeFileSync(htmlPath, html, "utf8");
writeFileSync(swPath, sw, "utf8");
writeFileSync(identityPath, JSON.stringify({ buildId, backupSchemaVersion: 1 }, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ buildId, indexMd5: revision }));
