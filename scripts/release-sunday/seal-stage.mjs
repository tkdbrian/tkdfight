#!/usr/bin/env node
// Run once on an isolated RAW build stage, before pack-sunday.mjs.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rewriteIndexRevision, sha256File, validateRawStage, validateStage } from "./pack-core.mjs";

if (process.argv.length !== 6 || process.argv[2] !== "--stage" || process.argv[4] !== "--build-id") {
  throw new Error("Usage: node seal-stage.mjs --stage <isolated-raw-stage> --build-id <id>");
}
const stage = resolve(process.argv[3]);
const buildId = process.argv[5];
validateRawStage(stage, buildId);

const htmlPath = join(stage, "dist", "index.html");
const swPath = join(stage, "dist", "sw.js");
const originalHtml = readFileSync(htmlPath, "utf8");
const originalSw = readFileSync(swPath, "utf8");
const oldRevision = createHash("md5").update(readFileSync(htmlPath)).digest("hex");
const heads = [...originalHtml.matchAll(/<\/head\s*>/gi)];
if (heads.length !== 1) throw new Error("Client HTML must have exactly one closing </head>");
const sealedHtml = originalHtml.replace(/<\/head\s*>/i,
  `  <meta name="tkd-build-id" content="${buildId}">\n</head>`);
const newRevision = createHash("md5").update(sealedHtml, "utf8").digest("hex");
const sealedSw = rewriteIndexRevision(originalSw, oldRevision, newRevision);

writeFileSync(htmlPath, sealedHtml, "utf8");
writeFileSync(swPath, sealedSw, "utf8");
const files = {
  "dist/index.html": sha256File(htmlPath),
  "dist-server/index.mjs": sha256File(join(stage, "dist-server", "index.mjs")),
};
writeFileSync(join(stage, "source-manifest.json"),
  JSON.stringify({ buildId, files }, null, 2) + "\n", "utf8");
validateStage(stage, buildId);
console.log(JSON.stringify({ stage, buildId, indexMd5: newRevision, files }, null, 2));
