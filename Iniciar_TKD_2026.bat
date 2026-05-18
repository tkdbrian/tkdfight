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

REM ── Iniciar servidor ─────────────────────────────────────────────────────────
REM Esperar 2 segundos y abrir el navegador
start /min "" cmd /c "timeout /t 2 >nul && start http://localhost:3001"

REM Iniciar el servidor en primer plano
call npx tsx --tsconfig tsconfig.server.json server/index.ts

pause
