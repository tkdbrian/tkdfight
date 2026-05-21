@echo off
title TKD Tournament 2026
color 0A
cls

echo.
echo  =============================================
echo    TKD TOURNAMENT SYSTEM 2026 - BL System
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

if errorlevel 4 ( set TKD_ROLE=central      & set TKD_SUB=data-central & set TKD_OPEN_PATH=/central & goto :launch )
if errorlevel 3 ( set TKD_ROLE=cuadrilatero3 & set TKD_SUB=data-t3     & set TKD_OPEN_PATH=          & goto :launch )
if errorlevel 2 ( set TKD_ROLE=cuadrilatero2 & set TKD_SUB=data-t2     & set TKD_OPEN_PATH=          & goto :launch )
if errorlevel 1 ( set TKD_ROLE=cuadrilatero1 & set TKD_SUB=data-t1     & set TKD_OPEN_PATH=          & goto :launch )
goto :eof

:launch
:: Detectar si existe la carpeta "sistema" (distribucion) o no (desarrollo)
if exist "%~dp0sistema\" (
    set TKD_ROOT=%~dp0sistema
) else (
    set TKD_ROOT=%~dp0
)

:: Marcar la carpeta sistema como oculta en la primera ejecucion
if exist "%~dp0sistema\" attrib +H "%~dp0sistema" >nul 2>&1

:: Pasar datos al manager via variables de entorno (evita problemas de quotes con rutas con espacios)
set TKD_DATA=%TKD_ROOT%\%TKD_SUB%

:: Lanzar TKD-Manager.ps1 oculto y cerrar esta ventana
:: Usar -Command "& 'ruta'" en lugar de -File para manejar rutas con espacios
start "" /B powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& '%TKD_ROOT%\scripts\TKD-Manager.ps1'"
exit
