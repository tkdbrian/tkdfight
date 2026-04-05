@echo off
title Torneo con Jueces en Red - TKD Tournament
color 0A

echo ============================================
echo   TKD Tournament 2026 - BL System
echo   Iniciando servidor de scoring...
echo ============================================
echo.

:: Matar cualquier instancia previa del servidor en puerto 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001"') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Iniciar el servidor en background
start "TKD Server" /MIN cmd /c "node_modules\.bin\tsx server\index.ts"

:: Esperar a que el servidor arranque
timeout /t 2 /nobreak >nul

:: Abrir el torneo en el navegador predeterminado
start "" "index.html"

echo [OK] Servidor iniciado en http://localhost:3001
echo [OK] Jueces conectarse a: http://TU_IP:3001/judge
echo.
echo Presiona cualquier tecla para cerrar este panel...
echo (El servidor seguira corriendo en segundo plano)
pause >nul
