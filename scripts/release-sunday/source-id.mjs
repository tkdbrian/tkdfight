#!/usr/bin/env node
// Compute an immutable source fingerprint including untracked release inputs.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const files = [
  "index.html", "vite.config.ts", "package.json", "package-lock.json",
  "scripts/check-runtime.cjs", "scripts/Ensure-VCRedist.ps1",
];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) files.push(file);
  }
}
for (const directory of ["src", "server", "scripts/release-sunday"]) walk(directory);
files.sort();
const hash = createHash("sha256");
for (const file of files) {
  hash.update(file.replaceAll("\\", "/"));
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}
const sourceHash = hash.digest("hex");
const now = new Date().toISOString();
const date = now.slice(0, 10).replaceAll("-", "");
const time = now.slice(11, 19).replaceAll(":", "");
console.log(JSON.stringify({ buildId: `${date}-${sourceHash.slice(0, 10)}-${time}`, sourceHash, sourceFiles: files.length }));
