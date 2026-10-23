param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [Parameter(Mandatory = $true)][string]$LogDir,
    [string]$Port = "3001"
)

$ErrorActionPreference = "Stop"
$NodeExe = Join-Path $RootDir "bin\node.exe"
$ServerFile = Join-Path $RootDir "dist-server\index.mjs"

foreach ($path in @($NodeExe, $ServerFile)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Archivo necesario no encontrado: $path"
    }
}

New-Item -ItemType Directory -Path $DataDir, $LogDir -Force | Out-Null
$env:DATA_DIR = $DataDir
$env:PORT = $Port
$env:NODE_ENV = "production"
$env:ALLOWED_ORIGINS = "*"

$stdoutPath = Join-Path $LogDir "server-stdout.log"
$stderrPath = Join-Path $LogDir "server-stderr.log"
$pidPath = Join-Path $LogDir "server.pid"
$process = Start-Process `
    -FilePath $NodeExe `
    -ArgumentList ('"' + $ServerFile + '"') `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ASCII