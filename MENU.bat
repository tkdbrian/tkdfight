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

if errorlevel 4 (
    title TKD Tournament 2026 - Mesa Central
    set OPEN_PATH=/central
    goto :iniciar
)
if errorlevel 3 (
    title TKD Tournament 2026 - Cuadrilatero 3
    goto :iniciar
)
if errorlevel 2 (
    title TKD Tournament 2026 - Cuadrilatero 2
    goto :iniciar
)
if errorlevel 1 (
    title TKD Tournament 2026 - Cuadrilatero 1
    goto :iniciar
)

:iniciar
call "%~dp0INICIAR.bat"
