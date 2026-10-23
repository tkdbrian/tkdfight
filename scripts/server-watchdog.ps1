# ──────────────────────────────────────────────────────────────────────────────
# server-watchdog.ps1
# Mantiene el servidor Node.js corriendo. Si cae, lo reinicia automaticamente.
# Para detenerlo, crear el archivo .server.stop en $WorkDir.
# ──────────────────────────────────────────────────────────────────────────────
param(
    [string]$Exe,       # Ejecutable (ej: "node.exe" o "cmd.exe")
    [Alias("Args")][string]$ServerArguments = "", # No usar la variable automatica $Args
    [string]$WorkDir,   # Directorio de trabajo (raiz de la app)
    [string]$DataDir = "" # DATA_DIR para SQLite (carpeta con tournament.db)
)

$ErrorActionPreference = "Stop"

# Fail before touching the stop marker or starting a retry loop. Never repair ambiguous quotes.
function Resolve-WatchdogPath {
    param([string]$Value, [string]$Name, [string]$PathType)
    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value.IndexOfAny([IO.Path]::GetInvalidPathChars()) -ge 0 -or
        $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))') {
        throw "Watchdog: $Name debe ser una ruta absoluta valida, sin comillas incluidas."
    }
    if (-not (Test-Path -LiteralPath $Value -PathType $PathType)) {
        throw "Watchdog: $Name no existe o no tiene el tipo esperado: $Value"
    }
    return (Get-Item -LiteralPath ([IO.Path]::GetFullPath($Value))).FullName
}

$WorkDir = Resolve-WatchdogPath $WorkDir "WorkDir" "Container"
if ([string]::IsNullOrWhiteSpace($Exe)) { throw "Watchdog: Exe es obligatorio." }
if (-not [IO.Path]::IsPathRooted($Exe) -and $Exe -notmatch '[\\/"\x00]') {
    if ([Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Exe)) {
        throw "Watchdog: Exe debe ser un nombre exacto, sin comodines."
    }
    $command = Get-Command -Name $Exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $Exe = $command.Source
}
$Exe = Resolve-WatchdogPath $Exe "Exe" "Leaf"
if ($DataDir) { $DataDir = Resolve-WatchdogPath $DataDir "DataDir" "Container" }

$stopFile = Join-Path $WorkDir ".server.stop"
Remove-Item -LiteralPath $stopFile -ErrorAction SilentlyContinue

if ($DataDir) {
    $env:DATA_DIR = $DataDir
}

while ($true) {
    if (Test-Path -LiteralPath $stopFile) { break }

    $startParams = @{
        FilePath         = $Exe
        WindowStyle      = "Hidden"
        WorkingDirectory = $WorkDir
        PassThru         = $true
    }
    if ($ServerArguments -ne "") { $startParams.ArgumentList = $ServerArguments }

    $p = Start-Process @startParams

    # Esperar al proceso, chequeando el archivo de parada cada 500ms
    while (-not $p.HasExited) {
        if (Test-Path -LiteralPath $stopFile) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if (Test-Path -LiteralPath $stopFile) { break }

    # Reiniciar despues de 2 segundos si el proceso cayo
    Start-Sleep -Seconds 2
}

Remove-Item -LiteralPath $stopFile -ErrorAction SilentlyContinue
