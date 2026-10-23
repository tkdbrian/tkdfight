// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import packageLock from "../../package-lock.json";
import viteConfig from "../../vite.config";

describe("product version", () => {
  it("shows the 3.0.0 release version and keeps source metadata aligned", () => {
    const define = (viteConfig as { define?: Record<string, string> }).define;

    expect(packageJson.version).toBe("3.0.0");
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
