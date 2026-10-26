#!/usr/bin/env node
// Fresh-only offline release packager. Never reads a live portable or copies a database.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  assertFreshOutput, assertRegularFile, collectRuntimePackages, listRegularFiles,
  sha256File, validateStage, validatePortablePayload, portableTemplateCopies, portableRuntimeScripts,
} from "./pack-core.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const required = ["stage", "build-id", "output", "runtime", "vc-redist"];
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, "");
  const value = process.argv[i + 1];
  if (!key || !value || ![...required, "plan", "release-prefix"].includes(key) || args.has(key)) {
    throw new Error(`Bad argument: ${process.argv[i] ?? "(missing)"}`);
  }
  args.set(key, value);
}
for (const key of required) if (!args.has(key)) throw new Error(`Missing --${key}`);

const stage = resolve(args.get("stage"));
const runtime = resolve(args.get("runtime"));
const output = resolve(args.get("output"));
const vcRedist = resolve(args.get("vc-redist"));
const buildId = args.get("build-id");
const stageInfo = validateStage(stage, buildId);
const destinations = assertFreshOutput(output, buildId, args.get("release-prefix"));
const approvedRelease = resolve(repoRoot, "release");
const tempRoot = realpathSync(tmpdir());
if (output !== approvedRelease && !output.startsWith(`${tempRoot}${sep}`)) {
  throw new Error(`Output must be the project release directory or an isolated temp fixture: ${output}`);
}
if (existsSync(output) && (lstatSync(output).isSymbolicLink() || realpathSync(output) !== output)) {
  throw new Error(`Output directory must not be redirected by a symlink/junction: ${output}`);
}
const nodeExe = join(runtime, "bin", "node.exe");
assertRegularFile(nodeExe);
const architecture = spawnSync(nodeExe, ["-p", "process.platform + ' ' + process.arch"], { encoding: "utf8" });
if (architecture.status !== 0 || architecture.stdout.trim() !== "win32 x64") {
  throw new Error(`Bundled Node must be Windows x64: ${architecture.stdout} ${architecture.stderr}`);
}
assertRegularFile(vcRedist);
if (statSync(vcRedist).size < 10_000_000) throw new Error("VC++ prerequisite is unexpectedly small");
if (output === approvedRelease) {
  const signature = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    join(scriptDir, "Test-VCRedistSignature.ps1"), "-FilePath", vcRedist], { encoding: "utf8" });
  if (signature.status !== 0) throw new Error("VC++ offline prerequisite is not validly signed by Microsoft");
}
if (output === stage || output.startsWith(`${stage}${sep}`) || output === runtime) {
  throw new Error(`Output root must not be stage or runtime root: ${output}`);
}
const serverSource = readFileSync(join(stage, "dist-server", "index.mjs"), "utf8");
const packages = collectRuntimePackages(serverSource, runtime);
for (const file of portableRuntimeScripts) assertRegularFile(join(repoRoot, "scripts", file));
for (const [file] of portableTemplateCopies) assertRegularFile(join(scriptDir, "template", file));
const launcherSource = join(scriptDir, "template", "ABRIR TKD.cs");
assertRegularFile(launcherSource);
// Compilation happens on the release machine only, against the .NET Framework
// included by Windows. No SDK/compiler/VS is required on a tournament PC.
const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
const csc = ["Framework64", "Framework"].map((framework) =>
  join(windowsRoot, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"))
  .find((candidate) => existsSync(candidate));
if (!csc) throw new Error("Windows .NET Framework C# compiler missing on release machine");
assertRegularFile(csc);
if (args.get("plan") === "true") {
  console.log(JSON.stringify({ buildId, stage, output: destinations.folder, runtimePackages: packages.length, stageFiles: stageInfo.files.length }, null, 2));
  process.exit(0);
}

function copy(source, target) {
  assertRegularFile(source);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  if (sha256File(source) !== sha256File(target)) throw new Error(`Copy hash mismatch: ${source}`);
}

// No cleanup on failure: partial output is quarantined by its unique name for inspection.
mkdirSync(output, { recursive: true });
mkdirSync(destinations.folder);
const pkg = destinations.folder;
const system = join(pkg, "sistema");
const launcher = join(pkg, "ABRIR TKD.exe");
const compilation = spawnSync(csc, ["/nologo", "/target:winexe", "/platform:anycpu", "/optimize+",
  "/reference:System.Windows.Forms.dll", `/out:${launcher}`, launcherSource], { encoding: "utf8" });
if (compilation.status !== 0) throw new Error(`Launcher compilation failed: ${compilation.stdout}\n${compilation.stderr}`);
assertRegularFile(launcher);
if (readFileSync(launcher).subarray(0, 2).toString("ascii") !== "MZ") throw new Error("Compiled launcher is not a Windows executable");
for (const rel of stageInfo.files.filter((file) => file.startsWith("dist/"))) {
  copy(join(stage, rel), join(system, rel));
}
for (const rel of ["dist-server/index.mjs", "sistema/build-id.json"]) {
  copy(join(stage, rel), rel.startsWith("sistema/") ? join(pkg, rel) : join(system, rel));
}
const sourceManifest = JSON.parse(readFileSync(join(stage, "source-manifest.json"), "utf8"));
for (const rel of ["dist/index.html", "dist-server/index.mjs"]) {
  if (sha256File(join(system, rel)) !== sourceManifest.files[rel]) {
    throw new Error(`Staged build changed during packaging: ${rel}`);
  }
}
copy(nodeExe, join(system, "bin", "node.exe"));
copy(vcRedist, join(pkg, "Prerequisites", "vc_redist.x64.exe"));
for (const [source, target] of portableTemplateCopies) {
  copy(join(scriptDir, "template", source), join(pkg, target));
}
for (const file of portableRuntimeScripts) copy(join(repoRoot, "scripts", file), join(system, "scripts", file));
for (const rel of packages) {
  const source = join(runtime, rel);
  const target = join(system, rel);
  cpSync(source, target, {
    recursive: true, dereference: false, errorOnExist: true, force: false,
    filter: (current) => {
      const within = relative(source, current).replaceAll("\\", "/");
      return !within.startsWith("node_modules/") && within !== "node_modules";
    },
  });
  for (const file of listRegularFiles(source).filter((name) => !name.startsWith("node_modules/"))) {
    if (sha256File(join(source, file)) !== sha256File(join(target, file))) {
      throw new Error(`Package copy hash mismatch: ${rel}/${file}`);
    }
  }
}
const probe = spawnSync(join(system, "bin", "node.exe"), [join(system, "scripts", "check-runtime.cjs")], {
  cwd: system, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
});
if (probe.status !== 0 || !probe.stdout.includes("RUNTIME_OK")) {
  throw new Error(`Packaged runtime probe failed: ${probe.stdout}\n${probe.stderr}`);
}
for (const role of ["data-t1", "data-t2", "data-t3", "data-central"]) {
  mkdirSync(join(system, role));
}

// All package payload files are enumerated; only the manifest itself is excluded
// because a file cannot contain its own SHA-256 without circularity.
const files = listRegularFiles(pkg);
validatePortablePayload(files);
const manifest = {
  format: "tkd-sunday-offline-v1",
  buildId,
  backupSchemaVersion: 1,
  createdUtc: new Date().toISOString(),
  sourceManifestSha256: sha256File(join(stage, "source-manifest.json")),
  files: Object.fromEntries(files.map((rel) => [rel, { sha256: sha256File(join(pkg, rel)), bytes: statSync(join(pkg, rel)).size }])),
};
writeFileSync(join(pkg, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
const zipTool = join(scriptDir, "Write-SundayZip.ps1");
const zip = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", zipTool,
  "-Folder", pkg, "-ZipPath", destinations.zip], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
if (zip.status !== 0) throw new Error(`ZIP failed: ${zip.stdout}\n${zip.stderr}`);
const zipHash = sha256File(destinations.zip);
writeFileSync(destinations.sidecar, `${zipHash}  ${destinations.name}.zip\n`, "utf8");
console.log(JSON.stringify({ folder: pkg, zip: destinations.zip, zipSha256: zipHash, files: files.length, packages: packages.length }, null, 2));

