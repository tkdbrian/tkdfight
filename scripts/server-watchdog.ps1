# ──────────────────────────────────────────────────────────────────────────────
# server-watchdog.ps1
# Mantiene el servidor Node.js corriendo. Si cae, lo reinicia automaticamente.
# Para detenerlo, crear el archivo .server.stop en $WorkDir.
# ──────────────────────────────────────────────────────────────────────────────
param(
    [string]$Exe,       # Ejecutable (ej: "node.exe" o "cmd.exe")
    [string]$Args = "", # Argumentos del proceso
    [string]$WorkDir,   # Directorio de trabajo (raiz de la app)
    [string]$DataDir = "" # DATA_DIR para SQLite (carpeta con tournament.db)
)

$stopFile = Join-Path $WorkDir ".server.stop"
Remove-Item $stopFile -ErrorAction SilentlyContinue

if ($DataDir) {
    $env:DATA_DIR = $DataDir
}

while ($true) {
    if (Test-Path $stopFile) { break }

    $startParams = @{
        FilePath         = $Exe
        WindowStyle      = "Hidden"
        WorkingDirectory = $WorkDir
        PassThru         = $true
    }
    if ($Args -ne "") { $startParams.ArgumentList = $Args }

    $p = Start-Process @startParams

    # Esperar al proceso, chequeando el archivo de parada cada 500ms
    while (-not $p.HasExited) {
        if (Test-Path $stopFile) {
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if (Test-Path $stopFile) { break }

    # Reiniciar despues de 2 segundos si el proceso cayo
    Start-Sleep -Seconds 2
}

Remove-Item $stopFile -ErrorAction SilentlyContinue
