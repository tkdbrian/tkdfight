param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$LogDir,
    [Parameter(Mandatory = $true)][int]$ListeningPid,
    [Parameter(Mandatory = $true)][ValidateSet("T1", "T2", "T3", "MC")][string]$ExpectedAlias,
    [ValidateRange(1, 65535)][int]$Port = 3001
)

# Read-only: a busy port is reusable only by this exact launcher and selected role.
function Test-TKDServer {
    [OutputType([bool])]
    param(
        [string]$RootDir,
        [string]$DataDir,
        [string]$LogDir,
        [int]$ListeningPid,
        [string]$ExpectedAlias,
        [int]$Port = 3001
    )

    try {
        $pidPath = Join-Path $LogDir "server.pid"
        $ringPath = Join-Path $DataDir "ring.json"
        if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $ringPath -PathType Leaf)) { return $false }

        $recordedPid = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw -ErrorAction Stop).Trim(), [ref]$recordedPid) -or
            $recordedPid -ne $ListeningPid -or $ListeningPid -le 0) { return $false }

        $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
        if ($listeners.Count -eq 0 -or @($listeners | Where-Object { $_.OwningProcess -ne $ListeningPid }).Count -gt 0) {
            return $false
        }

        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ListeningPid" -ErrorAction Stop
        if (-not $process -or -not $process.ExecutablePath -or -not $process.CommandLine) { return $false }
        $expectedExe = [IO.Path]::GetFullPath((Join-Path $RootDir "bin\node.exe"))
        $expectedServer = [IO.Path]::GetFullPath((Join-Path $RootDir "dist-server\index.mjs"))
        $actualExe = [IO.Path]::GetFullPath($process.ExecutablePath)
        if (-not $actualExe.Equals($expectedExe, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        # Start-TKDServer passes exactly these two arguments; suffix/prefix matches are not trusted.
        $commandPattern = '^\s*"?' + [regex]::Escape($expectedExe) + '"?\s+"?' +
            [regex]::Escape($expectedServer) + '"?\s*$'
        if (-not [regex]::IsMatch($process.CommandLine, $commandPattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)) {
            return $false
        }

        $ring = Get-Content -LiteralPath $ringPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if (-not [string]::Equals($ring.alias, $ExpectedAlias, [StringComparison]::Ordinal) -or
            [string]::IsNullOrWhiteSpace($ring.name)) { return $false }
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -ErrorAction Stop
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/ring/status" -TimeoutSec 3 -ErrorAction Stop
        if ($health.ok -isnot [bool] -or -not $health.ok -or
            $status.online -isnot [bool] -or -not $status.online -or
            -not [string]::Equals($status.alias, $ExpectedAlias, [StringComparison]::Ordinal) -or
            -not [string]::Equals($status.name, $ring.name, [StringComparison]::Ordinal) -or
            $status.port -ne $Port) { return $false }
        return $true
    } catch {
        return $false
    }
}

# Dot-sourcing exposes the pure decision entry point for mocked, no-service tests.
if ($MyInvocation.InvocationName -ne ".") {
    if (Test-TKDServer @PSBoundParameters) {
        Write-Output "TKD_SERVER_READY"
        exit 0
    }
    exit 1
}
