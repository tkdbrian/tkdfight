// @vitest-environment node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const helper = resolve("scripts/seal-web-build.mjs");
const commit = "a".repeat(40);
function md5(value: string): string { return createHash("md5").update(value).digest("hex"); }
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tkd-web-build-test-"));
  roots.push(root);
  mkdirSync(join(root, "dist")); mkdirSync(join(root, "dist-server"));
  const html = "<html><head><title>TKD</title></head><body></body></html>";
  writeFileSync(join(root, "dist/index.html"), html);
  writeFileSync(join(root, "dist/sw.js"), `precacheAndRoute([{url:"index.html",revision:"${md5(html)}"}]);createHandlerBoundToURL("index.html")`);
  writeFileSync(join(root, "dist-server/index.mjs"), "// bundled server\n");
  return root;
}
function seal(root: string, revision = commit): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [helper, "--root", root], {
    cwd: root, encoding: "utf8", env: { ...process.env, RENDER_GIT_COMMIT: revision },
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("seals matching web/server identities and updates the exact PWA index revision", () => {
  const root = fixture(); const beforeServer = readFileSync(join(root, "dist-server/index.mjs"), "utf8");
  const result = seal(root); expect(result.status, String(result.stderr)).toBe(0);
  const identity: { buildId: string; backupSchemaVersion: number } = JSON.parse(readFileSync(join(root, "build-id.json"), "utf8"));
  expect(Object.keys(identity).sort()).toEqual(["backupSchemaVersion", "buildId"]);
  expect(identity.backupSchemaVersion).toBe(1);
  expect(identity.buildId).toMatch(/^web-aaaaaaaaaaaa-\d{8}T\d{9}Z$/);
  const html = readFileSync(join(root, "dist/index.html"), "utf8");
  expect(html).toContain(`<meta name="tkd-build-id" content="${identity.buildId}">`);
  expect(readFileSync(join(root, "dist/sw.js"), "utf8")).toContain(`revision:"${md5(html)}"`);
  expect(readFileSync(join(root, "dist-server/index.mjs"), "utf8")).toBe(beforeServer);
});

it.each(["invalid-commit", "stale-sw", "missing-bundle", "already-sealed", "ambiguous-head"])("rejects %s before writing any identity or changing HTML", (kind) => {
  const root = fixture();
  if (kind === "stale-sw") writeFileSync(join(root, "dist/sw.js"), 'precacheAndRoute([{url:"index.html",revision:"' + "0".repeat(32) + '"}]);createHandlerBoundToURL("index.html")');
  if (kind === "missing-bundle") rmSync(join(root, "dist-server/index.mjs"));
  if (kind === "already-sealed") writeFileSync(join(root, "dist/index.html"), '<head><meta name="tkd-build-id" content="old"></head>');
  if (kind === "ambiguous-head") writeFileSync(join(root, "dist/index.html"), "<head></head><head></head>");
  const before = readFileSync(join(root, "dist/index.html"), "utf8");
  const result = seal(root, kind === "invalid-commit" ? "<invalid>" : commit);
  expect(result.status).not.toBe(0);
  expect(String(result.stderr)).toMatch(/Invalid commit|PWA|regular file|already sealed|closing head/);
  expect(readFileSync(join(root, "dist/index.html"), "utf8")).toBe(before);
  expect(existsSync(join(root, "build-id.json"))).toBe(false);
});
