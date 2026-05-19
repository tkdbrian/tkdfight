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

:: ── Iniciar servidor (watchdog: reinicio automatico si cae) ──────────────────
echo [INFO] Iniciando servidor en puerto 3001 (modo watchdog)...
echo.

if not defined DATA_DIR set DATA_DIR=%~dp0data
start "" /B powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\server-watchdog.ps1" -Exe "%NODE_EXE%" -Args "%~dp0dist-server\index.mjs" -WorkDir "%~dp0" -DataDir "%DATA_DIR%"

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

call :open_kiosk "http://localhost:3001"

echo   [Presiona cualquier tecla para CERRAR el servidor]
echo   [No cierres esta ventana mientras el torneo este activo]
echo.
pause >nul

:: ── Cerrar servidor y watchdog al salir ──────────────────────────────────────
echo Cerrando servidor...
:: Señalar al watchdog que se detenga (evita que reinicie el servidor)
echo. > "%~dp0.server.stop"
timeout /t 3 /nobreak >nul
:: Por las dudas, matar cualquier proceso en puerto 3001
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
del "%~dp0.server.stop" >nul 2>&1
echo [OK] Servidor cerrado. Hasta la proxima!
timeout /t 2 /nobreak >nul
goto :eof

:: ── Funcion: abrir navegador en modo kiosco ──────────────────────────────────
:open_kiosk
setlocal
set KIOSK_URL=%~1
:: Intentar Chrome en kiosco (sin barras, pantalla completa)
for %%P in (
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if exist "%%~P" (
        start "" "%%~P" --kiosk --no-first-run --disable-extensions --disable-translate "%KIOSK_URL%"
        endlocal & exit /b 0
    )
)
:: Intentar Edge en kiosco
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
    if exist "%%~P" (
        start "" "%%~P" --kiosk --no-first-run "%KIOSK_URL%"
        endlocal & exit /b 0
    )
)
:: Fallback: navegador predeterminado (sin kiosco)
start "" "%KIOSK_URL%"
endlocal
exit /b 0
