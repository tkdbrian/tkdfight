@echo off
setlocal EnableDelayedExpansion
title TKD Fight 3.0.0
color 0A
cls

echo.
echo  =============================================
echo    TKD FIGHT 3.0.0 - BL System
echo  =============================================
echo.
echo    Cual es el rol de esta computadora?
echo.
echo    [1]  Cuadrilatero 1
echo    [2]  Cuadrilatero 2
echo    [3]  Cuadrilatero 3
echo    [4]  Mesa Central
echo.
echo  =============================================
echo.
choice /c 1234 /n /m "   Presiona el numero (1-4): "

if errorlevel 4 ( set "TKD_ROLE=Mesa Central"   & set "TKD_SUB=data-central" & set "TKD_ALIAS=MC" & set "TKD_OPEN_PATH=/central" & goto :launch )
if errorlevel 3 ( set "TKD_ROLE=Cuadrilatero 3" & set "TKD_SUB=data-t3"      & set "TKD_ALIAS=T3" & set "TKD_OPEN_PATH="         & goto :launch )
if errorlevel 2 ( set "TKD_ROLE=Cuadrilatero 2" & set "TKD_SUB=data-t2"      & set "TKD_ALIAS=T2" & set "TKD_OPEN_PATH="         & goto :launch )
if errorlevel 1 ( call "%~dp0TKD_Fight_3.0.0\ABRIR_TKD.bat" 1 & goto :eof )
goto :eof

:launch
:: Detectar carpeta sistema (distribucion) o no (desarrollo)
if exist "%~dp0sistema\" (
    set "TKD_ROOT=%~dp0sistema"
) else (
    set "TKD_ROOT=%~dp0"
)
if "%TKD_ROOT:~-1%"=="\" set "TKD_ROOT=%TKD_ROOT:~0,-1%"

cls
echo.
echo  =============================================
echo    TKD - !TKD_ROLE!
echo  =============================================
echo.

:: ── PASO 1: Desbloquear archivos (Mark-of-the-Web) ──────────────────────────
if exist "%~dp0installed.marker" (
    echo [1/5] Instalacion detectada.
) else if not exist "%TKD_ROOT%\.unblocked" (
    echo [1/5] Desbloqueando archivos descargados de internet...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%TKD_ROOT%' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue; New-Item -Path '%TKD_ROOT%\.unblocked' -ItemType File -Force | Out-Null" >nul 2>&1
    echo       OK
) else (
    echo [1/5] Archivos ya desbloqueados.
)

:: ── PASO 2: Verificar archivos criticos ──────────────────────────────────────
echo [2/5] Verificando archivos...
set "MISSING="
if not exist "%TKD_ROOT%\scripts\Ensure-VCRedist.ps1" set "MISSING=!MISSING! scripts\Ensure-VCRedist.ps1"
if not exist "%TKD_ROOT%\bin\node.exe"                                                  set "MISSING=!MISSING! bin\node.exe"
if not exist "%TKD_ROOT%\dist-server\index.mjs"                                         set "MISSING=!MISSING! dist-server\index.mjs"
if not exist "%TKD_ROOT%\dist\index.html"                                               set "MISSING=!MISSING! dist\index.html"
if not exist "%TKD_ROOT%\scripts\check-runtime.cjs"                                      set "MISSING=!MISSING! scripts\check-runtime.cjs"
if not exist "%TKD_ROOT%\scripts\Start-TKDServer.ps1"                                   set "MISSING=!MISSING! scripts\Start-TKDServer.ps1"
if not exist "%TKD_ROOT%\scripts\Stop-TKDServer.ps1"                                    set "MISSING=!MISSING! scripts\Stop-TKDServer.ps1"
if not exist "%TKD_ROOT%\scripts\Test-TKDServer.ps1"                                    set "MISSING=!MISSING! scripts\Test-TKDServer.ps1"
if defined MISSING (
    color 0C
    echo.
    echo  =============================================
    echo    ERROR: archivos faltantes:!MISSING!
    echo.
    echo    La carpeta "TKD Fight" esta incompleta.
    echo    Volve a extraer el ZIP completo y reintenta.
    echo  =============================================
    pause
    exit /b 1
)
echo       OK

:: ── PASO 3: Liberar puerto 3001 si esta en uso ───────────────────────────────
echo [3/6] Comprobando Microsoft Visual C++ Redistributable x64...
powershell -NoProfile -ExecutionPolicy Bypass -File "%TKD_ROOT%\scripts\Ensure-VCRedist.ps1" -InstallerPath "%~dp0Prerequisites\vc_redist.x64.exe" > "%TEMP%\tkd-vcredist.log" 2>&1
set "VC_CODE=!ERRORLEVEL!"
if not "!VC_CODE!"=="0" (
    color 0C
    echo.
    echo  No se pudo preparar Microsoft Visual C++ Redistributable x64.
    type "%TEMP%\tkd-vcredist.log"
    echo.
    echo  Si se instalo pero pide reiniciar, reinicia Windows y vuelve a abrir TKD Fight.
    del "%TEMP%\tkd-vcredist.log" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\tkd-vcredist.log" >nul 2>&1
echo       OK

:: Resolver rutas antes de comprobar si esta misma instancia ya esta abierta.
set "TKD_DATA_ROOT=%TKD_ROOT%"
if exist "%~dp0installed.marker" set "TKD_DATA_ROOT=%ProgramData%\TKD Fight"
set "DATA_DIR=%TKD_DATA_ROOT%\%TKD_SUB%"
set "LOG_DIR=%TKD_DATA_ROOT%\logs"
set "PORT=3001"

echo [4/6] Comprobando puerto 3001...
set "PORT_PID="
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3001 " ^| findstr /I "LISTENING"') do set "PORT_PID=%%a"
if defined PORT_PID (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%TKD_ROOT%\scripts\Test-TKDServer.ps1" -RootDir "%TKD_ROOT%" -DataDir "%DATA_DIR%" -LogDir "%LOG_DIR%" -ListeningPid "!PORT_PID!" -ExpectedAlias "!TKD_ALIAS!" -Port "%PORT%" >nul 2>&1
    if not errorlevel 1 goto :existing_server
    color 0C
    echo.
    echo  El puerto 3001 ya esta ocupado por el proceso !PORT_PID!.
    echo  TKD Fight no cerrara otras aplicaciones automaticamente.
    echo  No se verifico esta instancia y rol. No se abrira un servidor ajeno.
    echo  Verifica el rol elegido; no cierres un torneo activo para liberar el puerto.
    pause
    exit /b 1
)
echo       Disponible

:: ── PASO 4: Verificar Node, SQLite y dependencias del servidor ────────────────
echo [5/6] Probando Node, SQLite y modulos del servidor...
pushd "%TKD_ROOT%"
"%TKD_ROOT%\bin\node.exe" "%TKD_ROOT%\scripts\check-runtime.cjs" > "%TEMP%\tkd-check.out" 2>&1
set "CHECK_CODE=!ERRORLEVEL!"
popd

if !CHECK_CODE! NEQ 0 (
    color 0C
    echo.
    echo  =============================================
    echo    ERROR: SQLite o un modulo del servidor no pudo iniciar.
    echo  =============================================
    echo.
    type "%TEMP%\tkd-check.out"
    echo.
    echo  El prerrequisito VC++ se verifico antes de esta prueba.
    echo  Guarda el mensaje y consulta LEEME_SI_NO_FUNCIONA.txt.
    echo  No borres las carpetas de datos del torneo.
    echo.
    del "%TEMP%\tkd-check.out" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\tkd-check.out" >nul 2>&1
echo       OK

:: ── PASO 5: Arrancar servidor ─────────────────────────────────────────────────
echo [6/6] Iniciando servidor en puerto 3001...
echo.

set "NODE_ENV=production"
set "ALLOWED_ORIGINS=*"

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%" >nul 2>&1
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

set "LOG_OUT=%LOG_DIR%\server-stdout.log"
set "LOG_ERR=%LOG_DIR%\server-stderr.log"
del "%LOG_OUT%" >nul 2>&1
del "%LOG_ERR%" >nul 2>&1

:: Lanzar Node directamente y guardar el PID para cerrar solo esta instancia.
powershell -NoProfile -ExecutionPolicy Bypass -File "%TKD_ROOT%\scripts\Start-TKDServer.ps1" -RootDir "%TKD_ROOT%" -DataDir "%DATA_DIR%" -LogDir "%LOG_DIR%" -Port "%PORT%"
if errorlevel 1 (
    echo [ERROR] No se pudo iniciar el proceso del servidor.
    pause
    exit /b 1
)

:: Esperar hasta 30 segundos a que el server responda
echo Esperando que el servidor arranque (hasta 30 segundos)...
set /a WAIT=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a WAIT+=1
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>&1
if !ERRORLEVEL! EQU 0 goto :server_ok
if !WAIT! LSS 30 goto :wait_loop

:: ── Server no arranco ─────────────────────────────────────────────────────────
color 0C
cls
echo.
echo  =============================================
echo    ERROR: el servidor no respondio en 30 seg
echo  =============================================
echo.
echo  STDERR del servidor:
echo  -----------------------------------------------
type "%LOG_ERR%" 2>nul
echo  -----------------------------------------------
echo  STDOUT del servidor:
echo  -----------------------------------------------
type "%LOG_OUT%" 2>nul
echo  -----------------------------------------------
echo.
echo  Sacale foto a este mensaje y mandaselo a soporte.
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%TKD_ROOT%\scripts\Stop-TKDServer.ps1" -RootDir "%TKD_ROOT%" -LogDir "%LOG_DIR%"
exit /b 1

:existing_server
color 0A
echo.
echo  TKD Fight - !TKD_ROLE! ya esta funcionando. Abriendo el navegador...
echo  No se reinicio ni se cerrara el servidor existente.
set "APP_URL=http://localhost:%PORT%!TKD_OPEN_PATH!"
echo.
echo  Si no aparece la ventana, copia esta direccion en tu navegador:
echo    !APP_URL!
echo  Jueces: http://localhost:%PORT%/judge   TV: http://localhost:%PORT%/tv
call :open_browser "!APP_URL!"
exit /b 0

:server_ok
:: ── Obtener IP local ──────────────────────────────────────────────────────────
set "LOCAL_IP="
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4"') do (
    if not defined LOCAL_IP set "LOCAL_IP=%%i"
)
set "LOCAL_IP=!LOCAL_IP: =!"
if not defined LOCAL_IP set "LOCAL_IP=localhost"

cls
color 0A
echo.
echo  =============================================
echo    TKD - !TKD_ROLE!  [CORRIENDO]
echo  =============================================
echo.
echo   Esta PC (organizador / mesa):
echo     http://localhost:3001!TKD_OPEN_PATH!
echo.
echo   Jueces (desde celulares en la misma WiFi):
echo     http://!LOCAL_IP!:3001/judge
echo.
echo   Pantalla TV:
echo     http://!LOCAL_IP!:3001/tv
echo.
echo   Mesa Central:
echo     http://!LOCAL_IP!:3001/central
echo.
echo  =============================================
echo.
echo   NO CERRAR ESTA VENTANA mientras el torneo este activo.
echo.

set "APP_URL=http://localhost:3001!TKD_OPEN_PATH!"
call :open_browser "!APP_URL!"

echo   [Presiona una tecla para CERRAR el servidor y salir]
pause >nul

echo.
echo Cerrando servidor...
powershell -NoProfile -ExecutionPolicy Bypass -File "%TKD_ROOT%\scripts\Stop-TKDServer.ps1" -RootDir "%TKD_ROOT%" -LogDir "%LOG_DIR%"
echo OK. Hasta la proxima!
timeout /t 2 /nobreak >nul
exit /b 0

:open_browser
set "URL=%~1"
for %%P in (
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
    if exist "%%~P" (
        start "" "%%~P" --kiosk --no-first-run --disable-extensions --disable-translate "%URL%"
        exit /b 0
    )
)
for %%P in (
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
    if exist "%%~P" (
        start "" "%%~P" --kiosk --no-first-run "%URL%"
        exit /b 0
    )
)
start "" "%URL%"
exit /b 0

