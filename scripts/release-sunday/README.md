# Sunday clean portable — maintainer handoff

Do **not** run `crear-distribucion.bat` or reuse a current portable directory/ZIP. The
builder never deletes or overwrites an output. Do not run a real package until
root QA explicitly gives GO and all code/build changes are frozen.

## One-click supervised release

The only root launcher is **ABRIR TKD.exe**, compiled on the release PC from
the small C# template using the Windows .NET Framework 4 compiler. Target PCs
need no Visual Studio, SDK, Node installation, Internet, or administrator for
normal use. The unsigned executable can be flagged by Windows reputation or
organizational policy; do not instruct users to disable security. Test the exact
delivered ZIP on the event PCs and obtain approval for the executable if needed.

The wrapper starts the PowerShell STA tray supervisor hidden. Copy only
`Launch-Sunday.ps1`, `OneClick-Core.ps1`, `check-runtime.cjs`, and
`Ensure-VCRedist.ps1` into `sistema/scripts`. Never include old BAT/VBS entries,
start/stop/watchdog helpers, installation configuration, supervisor secret, PID,
browser profile, or a live database. The payload validator enforces this exact
entrypoint surface before the hash manifest and ZIP are created. Any first-run
role, port, profile or instance identity belongs to the new installation only.

The VC++ prerequisite is bundled, signed, and considered only if the included
runtime probe diagnoses a missing requirement. Installing that Microsoft
prerequisite can require administrator approval or a Windows restart; it is not
required on every launch. Runtime success must be verified again afterwards.

Start with an **isolated RAW fresh-build stage** (outside this repository) with only:

```
stage/
  dist/                     # freshly built client, including all its static assets
  dist-server/index.mjs     # freshly built server from the same frozen source
  sistema/build-id.json     # {"buildId":"...","backupSchemaVersion":1}
```

`dist/sw.js` must initially precache the raw `dist/index.html` with its correct
MD5 revision (the normal VitePWA output). Run `seal-stage.mjs` **once**: it
inserts `<meta name="tkd-build-id" content="...">` in index HTML, updates the
service-worker precache revision to the MD5 of the final HTML, and creates
`source-manifest.json` with SHA-256 hashes of `dist/index.html` and
`dist-server/index.mjs`. `pack-sunday.mjs` accepts only that sealed stage and
checks meta, service-worker revision, build ID, and source manifest hashes.
Sealing and packing also reject external startup `<link href>` / `<script src>`
URLs and remote CSS assets so the offline PCs do not depend on Google Fonts or
another network host. The source `index.html` uses the CSS system-font fallback.

The build ID is authoritative for both bundles through `/api/build-id`; QA must
confirm that endpoint returns the stage ID. The builder verifies the source
manifest hashes before **and after** copying. It rejects undeclared stage files,
databases/WAL/SHM/locks/logs, symlinks, missing dependencies, reused output
names, non-Windows-x64 Node, and an invalid Microsoft-signed VC++ installer on
real releases. It copies only bounded runtime dependencies (not the entire
development `node_modules`), bundled Node, scripts, static assets, and VC++.

Run from the repository root in PowerShell, replacing the two example input
paths with the actual frozen stage and approved prerequisite:

```powershell
$stage = 'C:\path with spaces\fresh-stage'
$buildId = (Get-Content -LiteralPath "$stage\sistema\build-id.json" -Raw | ConvertFrom-Json).buildId
$vc = 'C:\path with spaces\vc_redist.x64.exe'
node .\scripts\release-sunday\seal-stage.mjs --stage $stage --build-id $buildId
node .\scripts\release-sunday\pack-sunday.mjs --stage $stage --build-id $buildId --output .\release --runtime . --vc-redist $vc --plan true
# ONLY AFTER GO:
node .\scripts\release-sunday\pack-sunday.mjs --stage $stage --build-id $buildId --output .\release --runtime . --vc-redist $vc
```

Output is `release/Sunday-20261025-<buildId>/`, sibling ZIP, and ZIP `.sha256`
sidecar. `release-manifest.json` lists SHA-256 and byte count for every payload
file (excluding itself to avoid a self-hash cycle). The ZIP verifier opens every
entry and compares its hash to the manifest. Empty role data folders contain no
source DB or test fights. If a package run fails, the unique partial output is
left untouched for diagnosis; choose a new build ID for a new attempt.

Before delivery, root QA must independently inspect ZIP contents, run from a
fresh extraction path with spaces/accents, confirm role/port and no test data,
verify backup/restore, and obtain physical-PC Windows 10/11 x64 offline tests.
No script here alone establishes that a release is ready for the event.
Without a LAN between event PCs, Mesa Central cannot discover or aggregate
other tatamis; each role is an independent local installation and backup scope.

### Required Windows offline acceptance record

Record machine/OS, ZIP SHA-256/buildId, user privilege, elapsed cold/warm launch
time, and outcome. This is a manual physical-PC gate, not implied by unit tests:

- Extract the entire ZIP into a writable path containing spaces and accents;
  disable Internet and open the EXE as a standard user. Select the role once.
  Confirm tray icon, browser, correct build/tatami and an empty tournament.
- Keep old servers on 3001/3101 running; ensure this new blank installation
  selects a free 43101–43130 port. Reopen repeatedly and double-click rapidly:
  one supervisor/server, same port/profile/data, no console dependency.
- Close/reopen the browser, then restart Windows and reopen; role and data
  persist. Do not rename/move a populated installation as an untested recovery.
- Exercise shutdown while free and rejection while loaded, result-pending or
  backing up. Close the tray menu without accidentally stopping the service.
- In isolated fixtures occupy the saved port and simulate stale identity/PID
  and server failure. Other processes must survive; recovery must be bounded,
  with no clock/confirmation or fight-loading action performed automatically.
- Complete RR one/two groups and elimination including draws/extra/golden point;
  edit flags/sanctions and verify results. Export/restore a complete backup to a
  separate compatible empty copy. Keep all test state out of the release ZIP.

If a second Windows PC is unavailable, mark this gate **PENDING** rather than
claiming the portable is tournament-approved.
