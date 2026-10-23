param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$LogDir
)

$ErrorActionPreference = "Stop"
$pidPath = Join-Path $LogDir "server.pid"
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    exit 0
}

$serverPid = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$serverPid)) {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    exit 0
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
if ($process) {
    $expectedExe = [IO.Path]::GetFullPath((Join-Path $RootDir "bin\node.exe"))
    $expectedServer = [IO.Path]::GetFullPath((Join-Path $RootDir "dist-server\index.mjs"))
    $actualExe = if ($process.ExecutablePath) { [IO.Path]::GetFullPath($process.ExecutablePath) } else { "" }
    if (-not $actualExe.Equals($expectedExe, [StringComparison]::OrdinalIgnoreCase) -or
        -not $process.CommandLine -or
        $process.CommandLine.IndexOf($expectedServer, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "El PID $serverPid ya no corresponde a esta instancia de TKD Fight; no se detuvo ningun proceso."
    }

    Stop-Process -Id $serverPid -Force
}

Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue