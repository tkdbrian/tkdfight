// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import packageLock from "../../package-lock.json";
import viteConfig from "../../vite.config";

describe("product version", () => {
  it("shows the 3.0.0 release version and keeps portable/install metadata aligned", () => {
    const installer = readFileSync(resolve(process.cwd(), "installer/TKDFight.iss"), "utf8");
    const distribution = readFileSync(resolve(process.cwd(), "crear-distribucion.bat"), "utf8");
    const installerReadme = readFileSync(resolve(process.cwd(), "installer/README.md"), "utf8");
    const define = (viteConfig as { define?: Record<string, string> }).define;

    expect(packageJson.version).toBe("3.0.0");
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(define?.__APP_VERSION__).toBe(JSON.stringify(packageJson.version));
    expect(installer).toContain(`#define AppVersion "${packageJson.version}"`);
    expect(distribution).toContain(`set ZIP_NAME=TKD_Fight_${packageJson.version}.zip`);
    expect(installerReadme).toContain(`TKD_Fight_${packageJson.version}.zip`);
  });
});
