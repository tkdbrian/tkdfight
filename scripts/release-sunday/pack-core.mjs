import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function assertRegularFile(file) {
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
    throw new Error(`Required regular file missing: ${file}`);
  }
}

function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    const full = join(root, rel);
    if (entry.isSymbolicLink()) throw new Error(`Symlink forbidden: ${full}`);
    if (entry.isDirectory()) files.push(...listFiles(root, rel));
    else if (entry.isFile()) files.push(rel.replaceAll("\\", "/"));
    else throw new Error(`Non-file entry forbidden: ${full}`);
  }
  return files;
}

function inspectStage(stage, expectedBuildId, sealed) {
  const root = resolve(stage);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`Stage missing: ${root}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{3,79}$/.test(expectedBuildId)) {
    throw new Error("Invalid buildId");
  }
  const files = listFiles(root);
  for (const file of files) {
    const declared = (sealed && file === "source-manifest.json") || file === "sistema/build-id.json"
      || file === "dist-server/index.mjs" || file.startsWith("dist/");
    if (!declared || /(^|\/)(data|logs?|backups?|snapshots?|\.unblocked)(\/|$)/i.test(file)
      || /(?:\.db(?:-wal|-shm)?|\.sqlite(?:3)?|\.lock|\.log)$/i.test(file)) {
      throw new Error(`Undeclared or forbidden stage file: ${file}`);
    }
  }
  const requiredFiles = ["dist/index.html", "dist/sw.js", "dist-server/index.mjs", "sistema/build-id.json"];
  if (sealed) requiredFiles.push("source-manifest.json");
  for (const required of requiredFiles) {
    if (!files.includes(required)) throw new Error(`Required stage file missing: ${required}`);
  }
  const id = JSON.parse(readFileSync(join(root, "sistema", "build-id.json"), "utf8"));
  if (id.buildId !== expectedBuildId || id.backupSchemaVersion !== 1
    || Object.keys(id).sort().join(",") !== "backupSchemaVersion,buildId") {
    throw new Error("buildId or backup schema mismatch in stage");
  }
  assertOfflineStartupAssets(root, files);
  return { root, files, buildId: expectedBuildId };
}

function assertOfflineStartupAssets(root, files) {
  const html = readFileSync(join(root, "dist", "index.html"), "utf8");
  for (const match of html.matchAll(/<(?:link|script)\b[^>]*>/gi)) {
    if (/\b(?:href|src)\s*=\s*(?:["']?https?:\/\/|["']?\/\/)/i.test(match[0])) {
      throw new Error(`External startup asset forbidden offline: ${match[0]}`);
    }
  }
  for (const file of files.filter((name) => name.startsWith("dist/") && name.endsWith(".css"))) {
    const css = readFileSync(join(root, file), "utf8");
    if (/(?:@import\s+(?:url\()?|url\()\s*["']?(?:https?:)?\/\//i.test(css)) {
      throw new Error(`External CSS startup asset forbidden offline: ${file}`);
    }
  }
}

function indexRevision(sw) {
  const pattern = /url\s*:\s*["']index\.html["']\s*,\s*revision\s*:\s*["']([a-f0-9]{32})["']/g;
  const matches = [...sw.matchAll(pattern)];
  if (matches.length !== 1 || !sw.includes('createHandlerBoundToURL("index.html")')) {
    throw new Error("PWA service-worker must precache and navigate to exactly one index.html");
  }
  return matches[0][1];
}

function assertPwaRevision(root) {
  const html = readFileSync(join(root, "dist", "index.html"), "utf8");
  const sw = readFileSync(join(root, "dist", "sw.js"), "utf8");
  const actual = createHash("md5").update(readFileSync(join(root, "dist", "index.html"))).digest("hex");
  if (indexRevision(sw) !== actual) throw new Error("PWA service-worker index revision is stale");
  return html;
}

export function validateRawStage(stage, expectedBuildId) {
  const result = inspectStage(stage, expectedBuildId, false);
  const html = assertPwaRevision(result.root);
  if (/<meta\b[^>]*name\s*=\s*["']tkd-build-id["']/i.test(html)) {
    throw new Error("Raw stage already contains a build ID meta; do not reseal");
  }
  return result;
}

export function validateStage(stage, expectedBuildId) {
  const result = inspectStage(stage, expectedBuildId, true);
  const { root, files } = result;
  const html = assertPwaRevision(root);
  const meta = [...html.matchAll(/<meta\s+name=["']tkd-build-id["']\s+content=["']([^"']+)["']\s*\/?\s*>/gi)];
  if (meta.length !== 1 || meta[0][1] !== expectedBuildId) {
    throw new Error("Client buildId meta missing or mismatched");
  }
  const manifest = JSON.parse(readFileSync(join(root, "source-manifest.json"), "utf8"));
  if (manifest.buildId !== expectedBuildId) throw new Error("buildId mismatch in source manifest");
  const expected = ["dist/index.html", "dist-server/index.mjs"];
  if (!manifest.files || Object.keys(manifest.files).sort().join(",") !== expected.sort().join(",")) {
    throw new Error("Source manifest must list exactly the client and server entrypoints");
  }
  for (const rel of expected) {
    if (sha256File(join(root, rel)) !== manifest.files[rel]) {
      throw new Error(`Source hash mismatch: ${rel}`);
    }
  }
  return result;
}

export function rewriteIndexRevision(sw, oldRevision, newRevision) {
  if (indexRevision(sw) !== oldRevision) throw new Error("PWA service-worker old revision mismatch");
  return sw.replace(/(url\s*:\s*["']index\.html["']\s*,\s*revision\s*:\s*["'])[a-f0-9]{32}(["'])/,
    (_match, prefix, suffix) => `${prefix}${newRevision}${suffix}`);
}

export function assertFreshOutput(outputRoot, buildId, releasePrefix = "Sunday-20261025") {
  const root = resolve(outputRoot);
  // A single path component only: never allow a CLI-provided name to escape outputRoot.
  if (typeof releasePrefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releasePrefix)
    || releasePrefix.includes("..") || releasePrefix.endsWith(".")) {
    throw new Error("Invalid release prefix");
  }
  if (typeof buildId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{3,79}$/.test(buildId)) {
    throw new Error("Invalid buildId");
  }
  const name = `${releasePrefix}-${buildId}`;
  const folder = join(root, name);
  const zip = `${folder}.zip`;
  const sidecar = `${zip}.sha256`;
  for (const path of [folder, zip, sidecar]) {
    if (existsSync(path)) throw new Error(`Output already exists; never overwrite: ${path}`);
  }
  return { root, name, folder, zip, sidecar };
}

function barePackageName(specifier) {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

function findPackage(runtimeRoot, fromDir, name) {
  const root = resolve(runtimeRoot);
  let dir = resolve(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      const full = resolve(candidate);
      const rel = relative(root, full);
      if (rel.startsWith(`..${sep}`) || rel === ".." || lstatSync(full).isSymbolicLink()) {
        throw new Error(`Package escapes runtime root: ${name}`);
      }
      return { full, rel: rel.replaceAll("\\", "/") };
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir || relative(root, parent).startsWith("..")) break;
    dir = parent;
  }
  throw new Error(`Unresolved runtime dependency: ${name} from ${fromDir}`);
}

export function collectRuntimePackages(serverSource, runtimeRoot, probeModules = ["better-sqlite3", "express", "express-rate-limit", "helmet", "pino", "qrcode", "socket.io", "zod"]) {
  const root = resolve(runtimeRoot);
  const imports = [...serverSource.matchAll(/\b(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)]
    .map((match) => barePackageName(match[1])).filter(Boolean);
  const queue = [...new Set([...imports, ...probeModules])].map((name) => ({ name, from: root }));
  const seen = new Map();
  for (let i = 0; i < queue.length; i += 1) {
    const { name, from } = queue[i];
    const pkg = findPackage(root, from, name);
    if (seen.has(pkg.rel)) continue;
    const stat = lstatSync(pkg.full);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid package: ${pkg.full}`);
    const meta = JSON.parse(readFileSync(join(pkg.full, "package.json"), "utf8"));
    if (meta.name !== name) throw new Error(`Dependency identity mismatch: ${name}`);
    listFiles(pkg.full);
    seen.set(pkg.rel, pkg.full);
    for (const dependency of Object.keys(meta.dependencies ?? {})) {
      queue.push({ name: dependency, from: pkg.full });
    }
    for (const dependency of Object.keys(meta.optionalDependencies ?? {})) {
      try { findPackage(root, pkg.full, dependency); queue.push({ name: dependency, from: pkg.full }); }
      catch { /* A platform-irrelevant optional dependency may be absent. */ }
    }
    for (const [dependency, range] of Object.entries(meta.peerDependencies ?? {})) {
      if (meta.peerDependenciesMeta?.[dependency]?.optional) continue;
      if (range) queue.push({ name: dependency, from: pkg.full });
    }
  }
  return [...seen.keys()].sort();
}

export function listRegularFiles(root) {
  return listFiles(resolve(root));
}

// Exact executable surface: no legacy launcher, instance settings or user state
// can enter a blank release even if a future copy step accidentally broadens.
export const portableTemplateCopies = [
  ["LEEME_DOMINGO.txt", "LEEME_DOMINGO.txt"],
  ["Launch-Sunday.ps1", "sistema/scripts/Launch-Sunday.ps1"],
  ["OneClick-Core.ps1", "sistema/scripts/OneClick-Core.ps1"],
];
export const portableRuntimeScripts = ["check-runtime.cjs", "Ensure-VCRedist.ps1"];

export function validatePortablePayload(files) {
  const exact = new Set([
    ...portableTemplateCopies.map(([, target]) => target),
    ...portableRuntimeScripts.map((name) => `sistema/scripts/${name}`),
    "ABRIR TKD.exe",
    "Prerequisites/vc_redist.x64.exe", "sistema/bin/node.exe",
    "sistema/build-id.json", "sistema/dist-server/index.mjs",
  ]);
  for (const file of files) {
    const allowed = exact.has(file) || file.startsWith("sistema/dist/")
      || file.startsWith("sistema/node_modules/");
    if (!allowed || file.includes("\\") || file.split("/").some((part) => part === ".." || part === ".")
      || /(^|\/)(?:browser-profile|\.env(?:\..*)?|\.unblocked|supervisor-secret[^/]*)(\/|$)/i.test(file)
      || /(?:\.db(?:-wal|-shm)?|\.sqlite(?:3)?|\.lock|\.log|\.pid)$/i.test(file)) {
      throw new Error(`Undeclared or forbidden packaged file: ${file}`);
    }
  }
  for (const required of exact) {
    if (!files.includes(required)) throw new Error(`Required packaged file missing: ${required}`);
  }
  if (!files.includes("sistema/dist/index.html")) throw new Error("Required packaged client missing");
  return files;
}
