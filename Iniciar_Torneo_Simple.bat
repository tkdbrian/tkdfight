@echo off
title Torneo Simple - Sin servidor - TKD Tournament
cls

echo.
echo =======================================================
echo    🥋 SISTEMA ROUND ROBIN TAEKWONDO - PORTABLE v1.0.0
echo =======================================================
echo.
echo 📱 MODO OFFLINE - Sin internet requerido
echo 💾 Backup automático - Datos seguros
echo ⚡ Optimizado para competencias profesionales
echo.
echo =======================================================
echo.
echo 🚀 Iniciando sistema de torneos...
echo.

REM Verificar si existe el archivo index.html
if not exist "index.html" (
    echo ❌ ERROR: No se encuentra el archivo index.html
    echo    Verificar que todos los archivos estén en la misma carpeta
    echo.
    pause
    exit /b 1
)

REM Intentar abrir con Chrome primero (recomendado)
where chrome >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo 🌐 Abriendo con Google Chrome...
    start chrome "index.html"
    goto :success
)

REM Si no hay Chrome, intentar con Firefox
where firefox >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo 🌐 Abriendo con Firefox...
    start firefox "index.html"
    goto :success
)

REM Si no hay navegadores específicos, usar el por defecto
echo 🌐 Abriendo con navegador por defecto...
start "" "index.html"

:success
echo.
echo ✅ Sistema iniciado correctamente
echo.
echo 📋 RECORDATORIOS IMPORTANTES:
echo    • Sistema 100%% offline - no requiere internet
echo    • Backup automático cada 30 segundos
echo    • Datos seguros en este dispositivo
echo    • Compatible con 3-8 competidores
echo.
echo 🆘 Si hay problemas:
echo    • Verificar que JavaScript esté habilitado
echo    • Intentar con navegador actualizado
echo    • Contactar soporte técnico
echo.
echo 📚 Documentación:
echo    • LEEME.txt - Guía básica
echo    • INSTRUCCIONES_TORNEO.txt - Guía para jueces
echo.

timeout /t 5 /nobreak >nul
echo ¡Listo para competir! 🏆
echo.
pause