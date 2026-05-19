@echo off
title Crear Distribucion - TKD Tournament 2026
color 0B
cls

echo.
echo =====================================================
echo   TKD Tournament 2026 - Crear Paquete Distribucion
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

:: ── Verificar npm install hecho ───────────────────────────────────────────────
if not exist "node_modules" (
    echo [INFO] Instalando dependencias...
    npm ci --silent
    if %ERRORLEVEL% NEQ 0 (
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

if exist "%DIST_DIR%" (
    echo [INFO] Limpiando distribucion anterior...
    rmdir /s /q "%DIST_DIR%"
)
mkdir "%DIST_DIR%"
mkdir "%DIST_DIR%\dist"
mkdir "%DIST_DIR%\dist-server"
mkdir "%DIST_DIR%\data"
mkdir "%DIST_DIR%\node_modules"

:: Copiar app React compilada
xcopy /e /i /q "dist" "%DIST_DIR%\dist" >nul

:: Copiar servidor compilado
copy "dist-server\index.mjs" "%DIST_DIR%\dist-server\index.mjs" >nul

:: Copiar better-sqlite3 (modulo nativo - no se puede bundlear)
xcopy /e /i /q "node_modules\better-sqlite3" "%DIST_DIR%\node_modules\better-sqlite3" >nul

:: Copiar datos iniciales (ring config)
if exist "data\ring.json" copy "data\ring.json" "%DIST_DIR%\data\ring.json" >nul

:: Copiar launchers de produccion
copy "INICIAR.bat" "%DIST_DIR%\INICIAR.bat" >nul 2>&1
copy "INSTRUCCIONES_TORNEO.txt" "%DIST_DIR%\INSTRUCCIONES_TORNEO.txt" >nul 2>&1
copy "LEEME.txt" "%DIST_DIR%\LEEME.txt" >nul 2>&1

:: Copiar scripts (watchdog y utilidades)
if not exist "%DIST_DIR%\scripts" mkdir "%DIST_DIR%\scripts"
xcopy /e /i /q "scripts" "%DIST_DIR%\scripts" >nul

:: ── Descargar Node.js portable si no existe ───────────────────────────────────
echo.
echo [4/4] Verificando Node.js portable...

if exist "%DIST_DIR%\bin\node.exe" (
    echo [OK] Node.js portable ya presente
) else (
    echo [INFO] Descargando Node.js portable ^(~30MB^)...
    mkdir "%DIST_DIR%\bin"
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\descargar-node.ps1" -DestDir "%DIST_DIR%\bin"
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo [ATENCION] No se pudo descargar Node.js automaticamente.
        echo            Alternativa: copia manualmente node.exe a %DIST_DIR%\bin\
        echo            Descarga desde: https://nodejs.org/dist/v22.15.0/node-v22.15.0-win-x64.zip
        echo            ^(solo necesitas node.exe del zip^)
    ) else (
        echo [OK] Node.js portable instalado en %DIST_DIR%\bin\
    )
)

:: ── Resumen final ─────────────────────────────────────────────────────────────
echo.
echo =====================================================
echo   DISTRIBUCION CREADA: %DIST_DIR%\
echo =====================================================
echo.
echo   Contenido:
echo   - dist\              (app React compilada)
echo   - dist-server\       (servidor compilado)
echo   - node_modules\      (solo better-sqlite3)
echo   - data\              (base de datos SQLite)
echo   - bin\node.exe       (Node.js portable)
echo   - scripts\           (watchdog y utilidades)
echo   - INICIAR.bat        (lanzador de produccion)
echo.
echo   Para distribuir: copiar la carpeta "%DIST_DIR%" completa
echo   Para probar: entrar a "%DIST_DIR%" y doble clic en INICIAR.bat
echo.
pause
