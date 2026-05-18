param(
    [string]$DestDir = ".\dist-produccion\bin"
)

# Node.js LTS version para Windows x64
$NODE_VERSION = "22.15.0"
$NODE_URL = "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip"
$ZIP_TEMP = "$env:TEMP\node-portable.zip"
$EXTRACT_TEMP = "$env:TEMP\node-portable-extract"

Write-Host "   Descargando Node.js v$NODE_VERSION portable..."
Write-Host "   URL: $NODE_URL"

try {
    # Limpiar temporales previos
    if (Test-Path $ZIP_TEMP) { Remove-Item $ZIP_TEMP -Force }
    if (Test-Path $EXTRACT_TEMP) { Remove-Item $EXTRACT_TEMP -Recurse -Force }

    # Descargar el zip
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $NODE_URL -OutFile $ZIP_TEMP -UseBasicParsing
    Write-Host "   [OK] Descarga completada"

    # Extraer
    Expand-Archive -Path $ZIP_TEMP -DestinationPath $EXTRACT_TEMP -Force
    Write-Host "   [OK] Extraido"

    # Copiar solo node.exe al destino
    $NodeExePath = "$EXTRACT_TEMP\node-v$NODE_VERSION-win-x64\node.exe"
    if (-not (Test-Path $NodeExePath)) {
        Write-Host "   [ERROR] No se encontro node.exe en el zip"
        exit 1
    }

    if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir | Out-Null }
    Copy-Item -Path $NodeExePath -Destination "$DestDir\node.exe" -Force
    Write-Host "   [OK] node.exe copiado a $DestDir"

    # Limpiar temporales
    Remove-Item $ZIP_TEMP -Force -ErrorAction SilentlyContinue
    Remove-Item $EXTRACT_TEMP -Recurse -Force -ErrorAction SilentlyContinue

    exit 0
}
catch {
    Write-Host "   [ERROR] $_"
    exit 1
}
