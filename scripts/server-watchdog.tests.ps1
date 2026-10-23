$ErrorActionPreference = "Stop"
$watchdog = Join-Path $PSScriptRoot "server-watchdog.ps1"
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $env:TEMP ("tkd-watchdog-tests-" + [guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$passed = 0
$failures = @()

function Assert-True($condition, [string]$message) {
    if (-not $condition) { throw $message }
}

# All process operations are mocks. The real watchdog runs only against disposable files.
function Start-Process {
    [CmdletBinding()]
    param($FilePath, $ArgumentList, $WindowStyle, $WorkingDirectory, [switch]$PassThru)
    $global:tkdWatchdogStarts += ,@{ Exe = $FilePath; Arguments = $ArgumentList; WorkDir = $WorkingDirectory }
    if ($global:tkdWatchdogStarts.Count -gt 1) { throw "Bounded harness: watchdog failed to honor stop file" }
    if ($global:tkdWatchdogFailStart) { Write-Error "Injected start failure"; return }
    return [pscustomobject]@{ HasExited = (-not $global:tkdWatchdogRunning); Id = 4242 }
}
function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    $global:tkdWatchdogStoppedId = $Id
}
function Start-Sleep {
    param($Seconds, $Milliseconds)
    $global:tkdWatchdogSleeps++
    if ($global:tkdWatchdogSleeps -gt 3) { throw "Bounded harness: stop marker was ignored" }
    [IO.File]::WriteAllText((Join-Path $global:tkdWatchdogWorkDir ".server.stop"), "stop")
}
function Remove-Item {
    [CmdletBinding()]
    param([Alias("Path")][string]$LiteralPath)
    $global:tkdWatchdogRemovals++
    if ($LiteralPath -ceq (Join-Path $global:tkdWatchdogWorkDir ".server.stop")) {
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -ErrorAction SilentlyContinue
    }
}
function New-Fixture([string]$name) {
    $path = Join-Path $fixture $name
    [IO.Directory]::CreateDirectory($path) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $path "data")) | Out-Null
    [IO.File]::WriteAllText((Join-Path $path "fake.exe"), "not an executable")
    return $path
}
function Invoke-WatchdogCase($parameters, [string]$expectedWorkDir) {
    $global:tkdWatchdogStarts = @()
    $global:tkdWatchdogRemovals = 0
    $global:tkdWatchdogSleeps = 0
    $global:tkdWatchdogWorkDir = $expectedWorkDir
    & $watchdog @parameters
}
function Test-Case([string]$name, [scriptblock]$body) {
    try { & $body; $script:passed++; Write-Output "PASS $name" }
    catch { $script:failures += "$name`: $($_.Exception.Message)"; Write-Output "FAIL $name`: $($_.Exception.Message)" }
}

$normal = New-Fixture "space path"
$normalParameters = @{ Exe = (Join-Path $normal "fake.exe"); WorkDir = $normal; DataDir = (Join-Path $normal "data") }
Test-Case "legacy Args alias preserves child arguments" {
    Invoke-WatchdogCase ($normalParameters + @{ Args = "dist-server/index.mjs" }) $normal
    Assert-True ($global:tkdWatchdogStarts.Count -eq 1) "Expected exactly one mocked launch"
    Assert-True ($global:tkdWatchdogStarts[0].Arguments -ceq "dist-server/index.mjs") "Args was lost to automatic variable"
}
Test-Case "literal special-character paths and normalized workdir" {
    $special = New-Fixture ("spaces [one] O'Brien & " + [char]0x00f1)
    Invoke-WatchdogCase @{ Exe = (Join-Path $special "fake.exe"); WorkDir = ($special + "\."); DataDir = (Join-Path $special "data"); ServerArguments = '"dist-server/path with spaces.mjs"' } $special
    Assert-True ($global:tkdWatchdogStarts[0].WorkDir -ceq $special) "WorkDir was not normalized"
    Assert-True ($global:tkdWatchdogStarts[0].Arguments -ceq '"dist-server/path with spaces.mjs"') "Arguments were altered"
    Assert-True ($env:DATA_DIR -ceq (Join-Path $special "data")) "DATA_DIR was altered"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $special ".server.stop"))) "Stop marker was not removed"
}
Test-Case "executable name resolves via PATH" {
    Invoke-WatchdogCase @{ Exe = "powershell.exe"; WorkDir = $normal } $normal
    Assert-True ([IO.Path]::IsPathRooted($global:tkdWatchdogStarts[0].Exe)) "Executable was not resolved"
}
Test-Case "stop marker terminates only the tracked child" {
    $special = New-Fixture "running [child]"
    $global:tkdWatchdogRunning = $true
    $global:tkdWatchdogStoppedId = 0
    try { Invoke-WatchdogCase @{ Exe = (Join-Path $special "fake.exe"); WorkDir = $special } $special }
    finally { $global:tkdWatchdogRunning = $false }
    Assert-True ($global:tkdWatchdogStarts.Count -eq 1) "Stop request restarted child"
    Assert-True ($global:tkdWatchdogStoppedId -eq 4242) "Did not stop exactly tracked child"
}
foreach ($invalid in @(
    @{ Name = "missing workdir"; Key = "WorkDir"; Value = (Join-Path $fixture "absent") },
    @{ Name = "empty workdir"; Key = "WorkDir"; Value = "" },
    @{ Name = "relative workdir"; Key = "WorkDir"; Value = "." },
    @{ Name = "drive-relative workdir"; Key = "WorkDir"; Value = "C:relative" },
    @{ Name = "root-relative workdir"; Key = "WorkDir"; Value = "\Windows" },
    @{ Name = "quoted workdir"; Key = "WorkDir"; Value = ('"' + $normal + '"') },
    @{ Name = "swallowed CLI tokens"; Key = "WorkDir"; Value = ($normal + '" -DataDir C:\wrong') },
    @{ Name = "missing executable"; Key = "Exe"; Value = (Join-Path $fixture "missing.exe") },
    @{ Name = "empty executable"; Key = "Exe"; Value = "" },
    @{ Name = "directory executable"; Key = "Exe"; Value = $normal },
    @{ Name = "wildcard executable"; Key = "Exe"; Value = "powershell*" },
    @{ Name = "quoted executable"; Key = "Exe"; Value = ('"' + $normalParameters.Exe + '"') },
    @{ Name = "missing datadir"; Key = "DataDir"; Value = (Join-Path $fixture "missing-data") },
    @{ Name = "quoted datadir"; Key = "DataDir"; Value = ('"' + $normalParameters.DataDir + '"') }
)) {
    Test-Case $invalid.Name {
        $parameters = $normalParameters.Clone()
        $parameters[$invalid.Key] = $invalid.Value
        $caught = $false
        try { Invoke-WatchdogCase $parameters $normal } catch { $caught = $true }
        Assert-True $caught "Invalid configuration was accepted"
        Assert-True ($global:tkdWatchdogStarts.Count -eq 0) "Invalid configuration reached process launch"
        Assert-True ($global:tkdWatchdogRemovals -eq 0) "Invalid configuration modified stop marker"
    }
}
Test-Case "process failure exits without retry loop" {
    $ErrorActionPreference = "Continue"
    $global:tkdWatchdogFailStart = $true
    $caught = $false
    try { Invoke-WatchdogCase $normalParameters $normal } catch { $caught = $true }
    finally { $global:tkdWatchdogFailStart = $false }
    Assert-True $caught "Start failure did not terminate"
    Assert-True ($global:tkdWatchdogStarts.Count -eq 1) "Start failure was retried"
}

# Native Windows argument parsing only: no child process or application is launched.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TkdWatchdogCommandLine {
  [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s, out int argc);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
  public static string[] Parse(string s) { int n; var p=CommandLineToArgvW(s,out n); if(p==IntPtr.Zero) throw new Exception("parse failed"); try { var a=new string[n]; for(int i=0;i<n;i++) a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return a; } finally { LocalFree(p); } }
}
"@
foreach ($launcher in @("INICIAR.bat", "Iniciar_TKD_2026.bat")) {
    Test-Case "$launcher native command-line boundaries" {
        $line = Get-Content -LiteralPath (Join-Path $repo $launcher) -Encoding UTF8 | Where-Object { $_ -match '^start .*server-watchdog' }
        Assert-True ($line.Count -eq 1) "Expected one watchdog launch line"
        $rootWithSlash = $normal + "\"
        $line = $line.Replace("%~dp0", $rootWithSlash).Replace("%NODE_EXE%", $normalParameters.Exe).Replace("%COMSPEC%", $normalParameters.Exe).Replace("%DATA_DIR%", $normalParameters.DataDir)
        $argv = [TkdWatchdogCommandLine]::Parse($line.Substring($line.IndexOf("powershell ")))
        $workIndex = [Array]::IndexOf($argv, "-WorkDir")
        $dataIndex = [Array]::IndexOf($argv, "-DataDir")
        Assert-True ($dataIndex -eq ($workIndex + 2)) "WorkDir swallowed DataDir tokens"
        Assert-True ($argv[$dataIndex + 1] -ceq $normalParameters.DataDir) "DataDir was split or altered"
        Assert-True ([IO.Path]::GetFullPath($argv[$workIndex + 1]) -ceq $normal) "WorkDir was split or altered"
        $argIndex = [Array]::IndexOf($argv, "-ServerArguments")
        Assert-True ($argIndex -ge 0) "Launcher still uses automatic Args variable"
        $expected = if ($launcher -eq "INICIAR.bat") { "dist-server/index.mjs" } else { "/c npx tsx --tsconfig tsconfig.server.json server/index.ts" }
        Assert-True ($argv[$argIndex + 1] -ceq $expected) "Child arguments would split paths containing spaces"
    }
}
if ($failures.Count) { throw ("WATCHDOG_TESTS_FAILED $($failures.Count): " + ($failures -join "; ")) }
Write-Output "WATCHDOG_TESTS_OK $passed/21 (mock processes only; fixture $fixture)"
