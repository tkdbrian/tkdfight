// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import packageLock from "../../package-lock.json";
import viteConfig from "../../vite.config";

describe("product version", () => {
  it("runs the locked esbuild CLI directly on Windows and Linux instead of parsing its binary with Node", () => {
    for (const script of ["build:server", "build:server:prod"] as const) {
      expect(packageJson.scripts[script]).toBe(
        "esbuild server/index.ts --bundle --platform=node --packages=external --format=esm --outfile=dist-server/index.mjs"
      );
    }
  });
  it("shows the 4.0.2 release version and keeps source metadata aligned", () => {
    const define = (viteConfig as { define?: Record<string, string> }).define;

    expect(packageJson.version).toBe("4.0.2");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(define?.__APP_VERSION__).toBe(JSON.stringify(packageJson.version));
  });

  it("fingerprints the maintained one-click sources without obsolete launcher dependencies", () => {
    const fingerprint = readFileSync(resolve(process.cwd(), "scripts/release-sunday/source-id.mjs"), "utf8");
    expect(fingerprint).toContain('"scripts/release-sunday"');
    expect(fingerprint).toContain('"scripts/check-runtime.cjs"');
    expect(fingerprint).toContain('"scripts/Ensure-VCRedist.ps1"');
    for (const legacy of ["Start-TKDServer.ps1", "Stop-TKDServer.ps1", "Test-TKDServer.ps1"]) {
      expect(fingerprint).not.toContain(legacy);
    }
  });
});
