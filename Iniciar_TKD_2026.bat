@echo off
title TKD Tournament System 2026
color 0B
cls

echo.
echo ============================================================
echo    TKD TOURNAMENT SYSTEM 2026 - Sistema de Torneos
echo ============================================================
echo.

REM ── Verificar Node.js ────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js no esta instalado o no esta en el PATH.
  echo.
  echo Descargalo desde: https://nodejs.org  (version 18 o superior)
  echo.
  pause
  exit /b 1
)

echo [OK] Node.js encontrado.

REM ── Verificar dependencias ───────────────────────────────────────────────────
if not exist "node_modules" (
  echo.
  echo [INFO] Instalando dependencias (solo la primera vez)...
  call npm install --prefer-offline 2>&1
  if errorlevel 1 (
    echo [ERROR] Fallo la instalacion de dependencias.
    pause
    exit /b 1
  )
)

REM ── Construir frontend si no existe dist/ ────────────────────────────────────
if not exist "dist\index.html" (
  echo.
  echo [INFO] Construyendo interfaz (solo la primera vez)...
  call npm run build 2>&1
  if errorlevel 1 (
    echo [ERROR] Fallo el build del frontend.
    pause
    exit /b 1
  )
)

echo.
echo ============================================================
echo  Iniciando servidor en http://localhost:3001 ...
echo  Presiona Ctrl+C para detener el servidor.
echo ============================================================
echo.

REM ── Iniciar servidor (watchdog: reinicio automatico si cae) ──────────────────
echo [INFO] Iniciando servidor...
echo.

if not defined OPEN_PATH set OPEN_PATH=/
if not defined DATA_DIR set DATA_DIR=%~dp0data
start "" /B powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\server-watchdog.ps1" -Exe "%COMSPEC%" -Args "/c npx tsx --tsconfig tsconfig.server.json server/index.ts" -WorkDir "%~dp0" -DataDir "%DATA_DIR%"

REM ── Esperar a que el servidor arranque (max 8 segundos) ──────────────────────
echo [INFO] Esperando servidor...
set /a WAIT=0
:wait_dev
timeout /t 1 /nobreak >nul
set /a WAIT+=1
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://localhost:3001' -TimeoutSec 1 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %ERRORLEVEL% EQU 0 goto :dev_ready
if %WAIT% LSS 8 goto :wait_dev

:dev_ready
echo [OK] Servidor listo en http://localhost:3001
echo.

REM ── Abrir navegador en modo kiosco ───────────────────────────────────────────
call :open_kiosk_dev "http://localhost:3001%OPEN_PATH%"

REM ── Mantener abierta hasta que el usuario la cierre ──────────────────────────
echo ============================================================
echo   [Presiona cualquier tecla para CERRAR el servidor]
echo   [No cierres esta ventana mientras el torneo este activo]
echo ============================================================
echo.
pause >nul

REM ── Cerrar servidor y watchdog ───────────────────────────────────────────────
echo Cerrando servidor...
echo. > "%~dp0.server.stop"
timeout /t 3 /nobreak >nul
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
del "%~dp0.server.stop" >nul 2>&1
echo [OK] Servidor cerrado.
timeout /t 2 /nobreak >nul
goto :eof

:open_kiosk_dev
setlocal
set KIOSK_URL=%~1
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
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
    if exist "%%~P" (
        start "" "%%~P" --kiosk --no-first-run "%KIOSK_URL%"
        endlocal & exit /b 0
    )
)
start "" "%KIOSK_URL%"
endlocal
exit /b 0
