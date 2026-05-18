@echo off
title TKD Tournament 2026 - Iniciando...
color 0A
cls

echo.
echo ==============================================
echo   TKD Tournament System 2026 - BL System
echo ==============================================
echo.

:: ── Detectar node.exe (portable o sistema) ────────────────────────────────────
set NODE_EXE=

:: Primero buscar node.exe portable en la carpeta bin\
if exist "%~dp0bin\node.exe" (
    set NODE_EXE=%~dp0bin\node.exe
    echo [OK] Usando Node.js portable
    goto :node_found
)

:: Si no hay portable, verificar Node.js instalado en el sistema
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set NODE_EXE=node
    for /f "tokens=*" %%v in ('node --version') do echo [OK] Usando Node.js del sistema %%v
    goto :node_found
)

:: Sin Node.js no se puede continuar
color 0C
echo [ERROR] No se encontro Node.js.
echo.
echo   Opciones:
echo   1. Descargar node.exe portable y copiarlo a la carpeta "bin\"
echo      Descarga: https://nodejs.org/dist/v22.15.0/node-v22.15.0-win-x64.zip
echo      (solo necesitas node.exe del zip)
echo.
echo   2. Instalar Node.js desde https://nodejs.org
echo.
pause
exit /b 1

:node_found

:: ── Liberar el puerto 3001 si estaba en uso ───────────────────────────────────
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: ── Verificar archivos criticos ───────────────────────────────────────────────
if not exist "%~dp0dist-server\index.mjs" (
    color 0C
    echo [ERROR] Archivo del servidor no encontrado: dist-server\index.mjs
    echo         Esta carpeta parece incompleta. Usa "crear-distribucion.bat" para regenerarla.
    pause
    exit /b 1
)

if not exist "%~dp0dist\index.html" (
    color 0C
    echo [ERROR] Archivos del frontend no encontrados: dist\index.html
    echo         Esta carpeta parece incompleta. Usa "crear-distribucion.bat" para regenerarla.
    pause
    exit /b 1
)

:: ── Crear carpeta data si no existe ──────────────────────────────────────────
if not exist "%~dp0data" mkdir "%~dp0data"

:: ── Iniciar servidor ─────────────────────────────────────────────────────────
echo [INFO] Iniciando servidor en puerto 3001...
echo.

start "TKD Server" /MIN "%NODE_EXE%" "%~dp0dist-server\index.mjs"

:: Esperar a que el servidor arranque (max 5 segundos)
set /a WAIT=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a WAIT+=1

:: Verificar si el servidor ya responde
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:3001' -TimeoutSec 1 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :server_ready

if %WAIT% LSS 5 goto :wait_loop

:server_ready
:: ── Obtener IP local para mostrar a los jueces ───────────────────────────────
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4"') do (
    set LOCAL_IP=%%i
    goto :ip_found
)
:ip_found
set LOCAL_IP=%LOCAL_IP: =%

:: ── Abrir en el navegador ─────────────────────────────────────────────────────
echo ==============================================
echo   SISTEMA LISTO
echo ==============================================
echo.
echo   Organizador / Mesa:
echo     http://localhost:3001
echo.
echo   Jueces (desde su celular, misma red WiFi):
echo     http://%LOCAL_IP%:3001/judge
echo.
echo   Pantalla TV:
echo     http://%LOCAL_IP%:3001/tv
echo.
echo   Mesa Central:
echo     http://%LOCAL_IP%:3001/central
echo.
echo ==============================================
echo.

start "" "http://localhost:3001"

echo   [Presiona cualquier tecla para CERRAR el servidor]
echo   [No cierres esta ventana mientras el torneo este activo]
echo.
pause >nul

:: ── Cerrar servidor al salir ──────────────────────────────────────────────────
echo Cerrando servidor...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo [OK] Servidor cerrado. Hasta la proxima!
timeout /t 2 /nobreak >nul
