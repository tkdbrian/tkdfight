@echo off
title Crear Distribucion - TKD Fight 2026
color 0B
cls

echo.
echo =====================================================
echo   TKD Fight 2026 - Crear Paquete Distribucion
echo =====================================================
echo.

:: ── Verificar Node.js disponible ─────────────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js no encontrado en el sistema.
    echo         Instala Node.js desde https://nodejs.org y vuelve a intentar.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER% detectado
for /f "tokens=*" %%a in ('node -p "process.arch"') do set NODE_ARCH=%%a
if /I not "%NODE_ARCH%"=="x64" (
    echo [ERROR] El instalador actual requiere Node.js x64; arquitectura detectada: %NODE_ARCH%.
    pause
    exit /b 1
)

:: ── Verificar npm install hecho ───────────────────────────────────────────────
if not exist "node_modules" (
    echo [INFO] Instalando dependencias...
    npm ci --silent
    if errorlevel 1 (
        echo [ERROR] Fallo npm ci
        pause
        exit /b 1
    )
)

:: ── Build frontend (React + Vite) ────────────────────────────────────────────
echo.
echo [1/4] Compilando frontend React...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Fallo la compilacion del frontend
    pause
    exit /b 1
)
echo [OK] Frontend compilado en dist\

:: ── Build server (esbuild - bundled, solo better-sqlite3 externo) ─────────────
echo.
echo [2/4] Compilando servidor...
call npm run build:server:prod
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Fallo la compilacion del servidor
    pause
    exit /b 1
)
echo [OK] Servidor compilado en dist-server\index.mjs

:: ── Crear carpeta de distribucion ────────────────────────────────────────────
echo.
echo [3/4] Creando carpeta de distribucion...
set DIST_DIR=dist-produccion
set SISTEMA=%DIST_DIR%\sistema

if exist "%DIST_DIR%" (
    echo [INFO] Limpiando distribucion anterior...
    rmdir /s /q "%DIST_DIR%"
)

:: ── Estructura: solo ABRIR_TKD.bat visible; todo lo tecnico en sistema\ ───────
mkdir "%DIST_DIR%"
mkdir "%DIST_DIR%\Prerequisites"
mkdir "%SISTEMA%"
mkdir "%SISTEMA%\dist"
mkdir "%SISTEMA%\dist-server"
mkdir "%SISTEMA%\data"
mkdir "%SISTEMA%\data-t1"
mkdir "%SISTEMA%\data-t2"
mkdir "%SISTEMA%\data-t3"
mkdir "%SISTEMA%\data-central"
mkdir "%SISTEMA%\node_modules"
mkdir "%SISTEMA%\scripts"
mkdir "%SISTEMA%\logs"

:: Copiar app React compilada
xcopy /e /i /q "dist" "%SISTEMA%\dist" >nul

:: Copiar servidor compilado
copy "dist-server\index.mjs" "%SISTEMA%\dist-server\index.mjs" >nul

:: Instalar todas las dependencias runtime en el staging aislado.
:: El servidor esbuild mantiene imports npm externos y requiere el grafo completo.
copy /y "package.json" "%SISTEMA%\package.json" >nul
copy /y "package-lock.json" "%SISTEMA%\package-lock.json" >nul
pushd "%SISTEMA%"
call npm ci --omit=dev --no-audit --no-fund
set "NPM_EXIT=%ERRORLEVEL%"
popd
if not "%NPM_EXIT%"=="0" (
    echo [ERROR] No se pudieron instalar las dependencias runtime en el staging.
    echo         Verifica internet, npm y que package-lock.json este actualizado.
    pause
    exit /b 1
)
if not exist "%SISTEMA%\node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
    echo [ERROR] better-sqlite3 no se instalo correctamente.
    pause
    exit /b 1
)
del "%SISTEMA%\package.json" "%SISTEMA%\package-lock.json" >nul 2>&1

:: Copiar ring config inicial a cada cuadrilatero
for %%D in (data data-t1 data-t2 data-t3 data-central) do (
    if exist "%%D\ring.json" copy "%%D\ring.json" "%SISTEMA%\%%D\ring.json" >nul
)

:: Copiar scripts
xcopy /e /i /q "scripts" "%SISTEMA%\scripts" >nul

:: Copiar launcher visible al nivel raiz
copy "ABRIR_TKD.bat" "%DIST_DIR%\ABRIR_TKD.bat" >nul
copy "INSTRUCCIONES_TORNEO.txt" "%DIST_DIR%\INSTRUCCIONES.txt" >nul 2>&1

:: Copiar guia desde una fuente estable, nunca desde el staging que acabamos de limpiar.
if not exist "installer\LEEME_SI_NO_FUNCIONA.txt" (
    echo [ERROR] Falta installer\LEEME_SI_NO_FUNCIONA.txt.
    pause
    exit /b 1
)
copy /y "installer\LEEME_SI_NO_FUNCIONA.txt" "%DIST_DIR%\LEEME_SI_NO_FUNCIONA.txt" >nul
if errorlevel 1 (
    echo [ERROR] No se pudo copiar la guia de solucion de problemas.
    pause
    exit /b 1
)

:: Incluir el runtime x64 de Microsoft para instalaciones offline en equipos limpios.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\descargar-vcredist.ps1" -DestinationPath "%DIST_DIR%\Prerequisites\vc_redist.x64.exe"
if errorlevel 1 (
    echo [ERROR] No se pudo preparar el redistribuible VC++ x64 firmado de Microsoft.
    pause
    exit /b 1
)

:: ── Node.js portable ──────────────────────────────────────────────────────────
echo.
echo [4/5] Verificando Node.js portable...

:: Preferir el node.exe del sistema (mismo que compilo better-sqlite3)
for /f "tokens=*" %%i in ('where node 2^>nul') do (
    if not defined SYSTEM_NODE set SYSTEM_NODE=%%i
)

if defined SYSTEM_NODE (
    echo [OK] Usando node.exe del sistema: %SYSTEM_NODE%
    mkdir "%SISTEMA%\bin" 2>nul
    copy "%SYSTEM_NODE%" "%SISTEMA%\bin\node.exe" >nul
    :: Guardar tambien en bin\ del workspace para builds offline
    if not exist "bin" mkdir "bin"
    copy "%SYSTEM_NODE%" "bin\node.exe" >nul 2>&1
) else if exist "bin\node.exe" (
    echo [OK] Copiando node.exe ya descargado ^(offline^)...
    mkdir "%SISTEMA%\bin"
    copy "bin\node.exe" "%SISTEMA%\bin\node.exe" >nul
) else if exist "%SISTEMA%\bin\node.exe" (
    echo [OK] Node.js portable ya presente en sistema\bin\
) else (
    echo [INFO] Descargando Node.js portable ^(~30MB^)...
    mkdir "%SISTEMA%\bin"
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\descargar-node.ps1" -DestDir "%SISTEMA%\bin"
    if errorlevel 1 (
        echo.
        echo [ERROR] No se pudo descargar Node.js portable.
        echo         Copia un node.exe x64 a bin\ y vuelve a ejecutar.
        echo         Descarga: https://nodejs.org/dist/v22.15.0/node-v22.15.0-win-x64.zip
        pause
        exit /b 1
    ) else (
        echo [OK] Node.js portable instalado.
        if not exist "bin" mkdir "bin"
        copy "%SISTEMA%\bin\node.exe" "bin\node.exe" >nul
    )
)

if not exist "%SISTEMA%\bin\node.exe" (
    echo [ERROR] No existe node.exe en el paquete de distribucion.
    pause
    exit /b 1
)
"%SISTEMA%\bin\node.exe" -p "process.arch" > "%TEMP%\tkd-node-arch.txt" 2>nul
if errorlevel 1 (
    echo [ERROR] No se pudo consultar la arquitectura del Node.js empaquetado.
    del "%TEMP%\tkd-node-arch.txt" >nul 2>&1
    pause
    exit /b 1
)
set /p PACKAGE_NODE_ARCH=<"%TEMP%\tkd-node-arch.txt"
del "%TEMP%\tkd-node-arch.txt" >nul 2>&1
if /I not "%PACKAGE_NODE_ARCH%"=="x64" (
    echo [ERROR] El Node.js del paquete debe ser x64; arquitectura detectada: %PACKAGE_NODE_ARCH%.
    pause
    exit /b 1
)

:: Smoke test aislado: confirma el grafo runtime y el addon SQLite del paquete.
pushd "%SISTEMA%"
"bin\node.exe" "scripts\check-runtime.cjs" > "%TEMP%\tkdfight-runtime-check.log" 2>&1
set "RUNTIME_EXIT=%ERRORLEVEL%"
popd
if not "%RUNTIME_EXIT%"=="0" (
    echo [ERROR] El runtime del paquete no paso la prueba aislada.
    type "%TEMP%\tkdfight-runtime-check.log"
    del "%TEMP%\tkdfight-runtime-check.log" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\tkdfight-runtime-check.log" >nul 2>&1
echo [OK] Runtime x64 y SQLite verificados en el staging.

:: Guardar con BOM el TKD-Manager.ps1 para compatibilidad con PowerShell 5.1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%SISTEMA%\scripts\TKD-Manager.ps1'; $c=[System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8); [System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding $true)); Write-Host '[OK] TKD-Manager.ps1 guardado con BOM'"

:: ── Crear ZIP distribuible ────────────────────────────────────────────────────
echo.
echo [5/5] Creando ZIP distribuible...

set ZIP_NAME=TKD_Fight_3.0.0.zip
if exist "%ZIP_NAME%" del "%ZIP_NAME%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%DIST_DIR%\*' -DestinationPath '%ZIP_NAME%' -Force -ErrorAction Stop"
if errorlevel 1 (
    echo [ERROR] No se pudo crear el ZIP portable.
    pause
    exit /b 1
)
if not exist "%ZIP_NAME%" (
    echo [ERROR] El comando termino, pero no se encontro %ZIP_NAME%.
    pause
    exit /b 1
)
echo [OK] ZIP creado: %ZIP_NAME%

:: ── Resumen final ─────────────────────────────────────────────────────────────
echo.
echo =====================================================
echo   DISTRIBUCION CREADA
echo =====================================================
echo.
echo   Carpeta:  %DIST_DIR%\
echo   ZIP:      %ZIP_NAME%
echo.
echo   El usuario ve SOLO:
echo     ABRIR_TKD.bat       (doble clic para arrancar)
echo     INSTRUCCIONES.txt
echo.
echo   Todo lo tecnico esta en sistema\ (carpeta oculta)
echo.
echo   Para distribuir: compartir %ZIP_NAME% por USB o Drive
echo   Para probar:     doble clic en %DIST_DIR%\ABRIR_TKD.bat
echo.
pause
