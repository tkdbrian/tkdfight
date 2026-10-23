$ErrorActionPreference = "Stop"
$root = "C:\tkd-launcher-test"
$arguments = @{
    RootDir = $root
    DataDir = "$root\data-t1"
    LogDir = "$root\logs"
    ListeningPid = 4242
    ExpectedAlias = "T1"
    Port = 3001
}
. (Join-Path $PSScriptRoot "Test-TKDServer.ps1") @arguments

# Mock OS/HTTP/files: these tests never start/stop processes or access application data.
function Test-Path {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$PathType)
    return $script:scenario -ne "missing-file"
}
function Get-Content {
    [CmdletBinding()]
    param([string]$LiteralPath, [switch]$Raw, [string]$Encoding)
    if ($LiteralPath.EndsWith("server.pid")) {
        if ($script:scenario -eq "invalid-pid") { return "not-a-pid" }
        if ($script:scenario -eq "wrong-pid") { return "9999" }
        return "4242"
    }
    $alias = if ($script:scenario -eq "wrong-config-role") { "T2" } else { $script:alias }
    return (@{ alias = $alias; name = "Selected ring" } | ConvertTo-Json)
}
function Get-NetTCPConnection {
    [CmdletBinding()]
    param([int]$LocalPort, [string]$State)
    if ($script:scenario -eq "no-listener") { return }
    if ($script:scenario -eq "foreign-listener") { return [pscustomobject]@{ OwningProcess = 9999 } }
    return [pscustomobject]@{ OwningProcess = 4242 }
}
function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($script:scenario -eq "missing-process") { return }
    $exe = if ($script:scenario -eq "foreign-exe") { "C:\another-app\node.exe" } else { "$root\bin\node.exe" }
    $server = "$root\dist-server\index.mjs"
    if ($script:scenario -eq "server-suffix") { $server += ".foreign" }
    $command = '"' + $exe + '" "' + $server + '"'
    if ($script:scenario -eq "extra-command") { $command += " --another-role" }
    return [pscustomobject]@{ ExecutablePath = $exe; CommandLine = $command }
}
function Invoke-RestMethod {
    [CmdletBinding()]
    param([string]$Uri, [int]$TimeoutSec)
    if ($script:scenario -eq "http-error") { throw "offline" }
    if ($Uri.EndsWith("/health")) { return [pscustomobject]@{ ok = ($script:scenario -ne "unhealthy") } }
    return [pscustomobject]@{
        alias = $(if ($script:scenario -eq "wrong-http-role") { "T2" } else { $script:alias })
        name = $(if ($script:scenario -eq "wrong-name") { "Another ring" } else { "Selected ring" })
        online = ($script:scenario -ne "offline-ring")
        port = $(if ($script:scenario -eq "wrong-http-port") { 3317 } else { 3001 })
    }
}

$passed = 0
foreach ($alias in @("T1", "T2", "T3", "MC")) {
    $script:alias = $alias
    $script:scenario = "trusted"
    $arguments.ExpectedAlias = $alias
    if (-not (Test-TKDServer @arguments)) { throw "Trusted $alias was rejected" }
    $passed++
}
$script:alias = "T1"
$arguments.ExpectedAlias = "T1"
foreach ($scenario in @("missing-file", "invalid-pid", "wrong-pid", "no-listener",
    "foreign-listener", "missing-process", "foreign-exe", "server-suffix", "extra-command",
    "wrong-config-role", "http-error", "unhealthy", "wrong-http-role", "wrong-name",
    "offline-ring", "wrong-http-port")) {
    $script:scenario = $scenario
    if (Test-TKDServer @arguments) { throw "Untrusted $scenario was accepted" }
    $passed++
}
Write-Output "TKD_SERVER_TESTS_OK $passed/20"
