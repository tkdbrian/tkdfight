import { describe, expect, it } from "vitest";
import {
  assertFreshOutput,
  validatePortablePayload,
  collectRuntimePackages,
  sha256File,
  validateStage,
} from "./pack-core.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, ftruncateSync, closeSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Real packaging needs the separately supplied Windows runtime (not tracked in Git).
// Keep the portable validation tests active on clean clones and Linux CI.
const hasWindowsPackRuntime = process.platform === "win32"
  && existsSync(join(process.cwd(), "bin", "node.exe"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tkd-sunday-fixture-"));
  const stage = join(root, "stage");
  mkdirSync(join(stage, "dist"), { recursive: true });
  mkdirSync(join(stage, "dist-server"));
  mkdirSync(join(stage, "sistema"));
  const html = '<html><head><meta name="tkd-build-id" content="abc123"></head><body>client</body></html>';
  writeFileSync(join(stage, "dist", "index.html"), html);
  const md5 = createHash("md5").update(html).digest("hex");
  writeFileSync(join(stage, "dist", "sw.js"),
    `precacheAndRoute([{url:"index.html",revision:"${md5}"}]);createHandlerBoundToURL("index.html")`);
  writeFileSync(join(stage, "dist-server", "index.mjs"), 'import x from "alpha";');
  writeFileSync(join(stage, "sistema", "build-id.json"), JSON.stringify({ buildId: "abc123", backupSchemaVersion: 1 }));
  const files = {
    "dist/index.html": sha256File(join(stage, "dist", "index.html")),
    "dist-server/index.mjs": sha256File(join(stage, "dist-server", "index.mjs")),
  };
  writeFileSync(join(stage, "source-manifest.json"), JSON.stringify({ buildId: "abc123", files }));
  return { root, stage };
}

describe("Sunday isolated package gates", () => {
  it("allows only one launcher and pristine offline payloads", () => {
    const files = [
      "ABRIR TKD.exe", "LEEME_DOMINGO.txt", "Prerequisites/vc_redist.x64.exe",
      "sistema/dist/index.html", "sistema/dist-server/index.mjs", "sistema/build-id.json",
      "sistema/bin/node.exe", "sistema/scripts/Launch-Sunday.ps1", "sistema/scripts/OneClick-Core.ps1",
      "sistema/scripts/check-runtime.cjs", "sistema/scripts/Ensure-VCRedist.ps1",
      "sistema/node_modules/express/package.json",
    ];
    expect(() => validatePortablePayload(files)).not.toThrow();
    for (const dirty of [
      "ABRIR_TKD.bat", "ABRIR TKD.vbs", "ABRIR TKD.cs", "sistema/scripts/Start-TKDServer.ps1", "sistema/portable-settings.json",
      "sistema/data-t1/tournament.db", "sistema/data-t1/browser-profile/Preferences",
      "sistema/installation.json", "sistema/supervisor-secret.txt", "sistema/.env", "sistema/server.pid",
      "sistema/dist/private.log", "sistema/logs/server.txt", "sistema/.unblocked",
    ]) expect(() => validatePortablePayload([...files, dirty])).toThrow(/forbidden|undeclared/i);
  });

  it("rejects an inconsistent stage before copying", () => {
    const { root, stage } = fixture();
    try {
      expect(validateStage(stage, "abc123").buildId).toBe("abc123");
      writeFileSync(join(stage, "dist", "index.html"), "new client");
      expect(() => validateStage(stage, "abc123")).toThrow(/hash|revision/i);
      expect(() => validateStage(stage, "other")).toThrow(/buildId/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects dirty stage content, symlinks, and occupied output names", () => {
    const { root, stage } = fixture();
    try {
      mkdirSync(join(stage, "data"));
      writeFileSync(join(stage, "data", "tournament.db"), "private");
      expect(() => validateStage(stage, "abc123")).toThrow(/undeclared|forbidden/i);
      rmSync(join(stage, "data"), { recursive: true });
      mkdirSync(join(root, "release"));
      mkdirSync(join(root, "release", "Sunday-20261025-abc123"));
      expect(() => assertFreshOutput(join(root, "release"), "abc123")).toThrow(/exists/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("walks required package dependency closure and fails missing dependency", () => {
    const { root } = fixture();
    try {
      const runtime = join(root, "runtime");
      mkdirSync(join(runtime, "node_modules", "alpha"), { recursive: true });
      mkdirSync(join(runtime, "node_modules", "beta"), { recursive: true });
      writeFileSync(join(runtime, "node_modules", "alpha", "package.json"), JSON.stringify({ name: "alpha", dependencies: { beta: "1" } }));
      writeFileSync(join(runtime, "node_modules", "beta", "package.json"), JSON.stringify({ name: "beta" }));
      expect(collectRuntimePackages('import x from "alpha";', runtime, [])).toEqual([
        "node_modules/alpha", "node_modules/beta",
      ]);
      rmSync(join(runtime, "node_modules", "beta"), { recursive: true });
      expect(() => collectRuntimePackages('import x from "alpha";', runtime, [])).toThrow(/beta/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(!hasWindowsPackRuntime)("preflights an isolated fake stage without creating a package", () => {
    const { root, stage } = fixture();
    try {
      writeFileSync(join(stage, "dist-server", "index.mjs"), 'import express from "express";');
      const files = {
        "dist/index.html": sha256File(join(stage, "dist", "index.html")),
        "dist-server/index.mjs": sha256File(join(stage, "dist-server", "index.mjs")),
      };
      writeFileSync(join(stage, "source-manifest.json"), JSON.stringify({ buildId: "abc123", files }));
      const vc = join(root, "fake-vc.exe");
      const fd = openSync(vc, "w");
      ftruncateSync(fd, 10_000_001);
      closeSync(fd);
      const result = spawnSync(process.execPath, [
        join(process.cwd(), "scripts/release-sunday/pack-sunday.mjs"),
        "--stage", stage, "--build-id", "abc123", "--output", join(root, "out"),
        "--runtime", process.cwd(), "--vc-redist", vc, "--plan", "true",
      ], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).runtimePackages).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("seals a raw PWA stage before hashing and rejects stale service-worker HTML", () => {
    const { root, stage } = fixture();
    try {
      unlinkSync(join(stage, "source-manifest.json"));
      const html = "<html><head><title>TKD</title></head><body></body></html>";
      writeFileSync(join(stage, "dist", "index.html"), html);
      const rawMd5 = createHash("md5").update(html).digest("hex");
      writeFileSync(join(stage, "dist", "sw.js"),
        `precacheAndRoute([{url:"index.html",revision:"${rawMd5}"}]);createHandlerBoundToURL("index.html")`);
      const seal = spawnSync(process.execPath, [
        join(process.cwd(), "scripts/release-sunday/seal-stage.mjs"),
        "--stage", stage, "--build-id", "abc123",
      ], { encoding: "utf8" });
      expect(seal.status, seal.stderr).toBe(0);
      const finalHtml = readFileSync(join(stage, "dist", "index.html"), "utf8");
      const finalMd5 = createHash("md5").update(finalHtml).digest("hex");
      expect(finalHtml).toContain('<meta name="tkd-build-id" content="abc123">');
      expect(readFileSync(join(stage, "dist", "sw.js"), "utf8")).toContain(`revision:"${finalMd5}"`);
      expect(validateStage(stage, "abc123").buildId).toBe("abc123");
      writeFileSync(join(stage, "dist", "sw.js"), `precacheAndRoute([{url:"index.html",revision:"${rawMd5}"}]);createHandlerBoundToURL("index.html")`);
      expect(() => validateStage(stage, "abc123")).toThrow(/service.worker|revision|PWA/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a client meta build ID that differs from server identity", () => {
    const { root, stage } = fixture();
    try {
      const htmlPath = join(stage, "dist", "index.html");
      const html = readFileSync(htmlPath, "utf8").replace("abc123", "wrong123");
      writeFileSync(htmlPath, html);
      const swPath = join(stage, "dist", "sw.js");
      const sw = readFileSync(swPath, "utf8").replace(/revision:"[a-f0-9]{32}"/,
        `revision:"${createHash("md5").update(html).digest("hex")}"`);
      writeFileSync(swPath, sw);
      expect(() => validateStage(stage, "abc123")).toThrow(/client buildId meta/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects external startup links even when the sealed hashes are consistent", () => {
    const { root, stage } = fixture();
    try {
      const htmlPath = join(stage, "dist", "index.html");
      const html = readFileSync(htmlPath, "utf8").replace("</head>",
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>');
      writeFileSync(htmlPath, html);
      const swPath = join(stage, "dist", "sw.js");
      writeFileSync(swPath, readFileSync(swPath, "utf8").replace(/revision:"[a-f0-9]{32}"/,
        `revision:"${createHash("md5").update(html).digest("hex")}"`));
      const files = {
        "dist/index.html": sha256File(htmlPath),
        "dist-server/index.mjs": sha256File(join(stage, "dist-server", "index.mjs")),
      };
      writeFileSync(join(stage, "source-manifest.json"), JSON.stringify({ buildId: "abc123", files }));
      expect(() => validateStage(stage, "abc123")).toThrow(/external|offline/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(!hasWindowsPackRuntime)("archives only a fake stage with verified payload and ZIP hash", async () => {
    const { root, stage } = fixture();
    try {
      writeFileSync(join(stage, "dist-server", "index.mjs"), 'import express from "express";');
      const files = {
        "dist/index.html": sha256File(join(stage, "dist", "index.html")),
        "dist-server/index.mjs": sha256File(join(stage, "dist-server", "index.mjs")),
      };
      writeFileSync(join(stage, "source-manifest.json"), JSON.stringify({ buildId: "abc123", files }));
      const vc = join(root, "fake-vc.exe");
      const fd = openSync(vc, "w");
      ftruncateSync(fd, 10_000_001);
      closeSync(fd);
      const result = await execFileAsync(process.execPath, [
        join(process.cwd(), "scripts/release-sunday/pack-sunday.mjs"),
        "--stage", stage, "--build-id", "abc123", "--output", join(root, "out"),
        "--runtime", process.cwd(), "--vc-redist", vc,
      ], { encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      const packed = JSON.parse(result.stdout);
      expect(existsSync(packed.zip)).toBe(true);
      const manifest = JSON.parse(readFileSync(join(packed.folder, "release-manifest.json"), "utf8"));
      expect(manifest.buildId).toBe("abc123");
      expect(manifest.files["ABRIR TKD.exe"]).toBeDefined();
      expect(readFileSync(join(packed.folder, "ABRIR TKD.exe")).subarray(0, 2).toString("ascii")).toBe("MZ");
      expect(manifest.files["sistema/scripts/OneClick-Core.ps1"]).toBeDefined();
      expect(manifest.files["sistema/scripts/Start-TKDServer.ps1"]).toBeUndefined();
      expect(manifest.files["ABRIR_TKD.bat"]).toBeUndefined();
      expect(manifest.files["ABRIR TKD.vbs"]).toBeUndefined();
      expect(manifest.files["ABRIR TKD.cs"]).toBeUndefined();
      expect(() => validatePortablePayload(Object.keys(manifest.files))).not.toThrow();
      expect(manifest.files["sistema/dist/index.html"].sha256).toBe(files["dist/index.html"]);
      const packedHtml = readFileSync(join(packed.folder, "sistema", "dist", "index.html"), "utf8");
      const packedSw = readFileSync(join(packed.folder, "sistema", "dist", "sw.js"), "utf8");
      expect(packedHtml).toContain('<meta name="tkd-build-id" content="abc123">');
      expect(packedSw).toContain(`revision:"${createHash("md5").update(packedHtml).digest("hex")}"`);
      expect(existsSync(join(packed.folder, "sistema", "data-t1", "tournament.db"))).toBe(false);
      expect(readFileSync(`${packed.zip}.sha256`, "utf8")).toContain(sha256File(packed.zip));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 180_000);
});



