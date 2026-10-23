@echo off
setlocal
title Crear instalador - TKD Fight

if not exist "dist-produccion\ABRIR_TKD.bat" (
    echo [ERROR] No existe dist-produccion.
    echo Primero genera la distribucion con crear-distribucion.bat.
    pause
    exit /b 1
)
if not exist "dist-produccion\sistema\scripts\check-runtime.cjs" (
    echo [ERROR] La distribucion no contiene el chequeo de dependencias.
    echo Regenera dist-produccion con la version actual de crear-distribucion.bat.
    pause
    exit /b 1
)
if not exist "dist-produccion\sistema\bin\node.exe" (
    echo [ERROR] No existe el runtime Node x64 en el staging.
    echo Regenera dist-produccion con crear-distribucion.bat.
    pause
    exit /b 1
)
if not exist "dist-produccion\Prerequisites\vc_redist.x64.exe" (
    echo [ERROR] Falta el redistribuible VC++ x64 en el staging.
    echo Regenera dist-produccion con la version actual de crear-distribucion.bat.
    pause
    exit /b 1
)

pushd "dist-produccion\sistema"
"bin\node.exe" "scripts\check-runtime.cjs" > "%TEMP%\tkdfight-runtime-check.log" 2>&1
set "CHECK_EXIT=%ERRORLEVEL%"
popd
if not "%CHECK_EXIT%"=="0" (
    echo [ERROR] El runtime del staging esta incompleto o no carga.
    type "%TEMP%\tkdfight-runtime-check.log"
    del "%TEMP%\tkdfight-runtime-check.log" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\tkdfight-runtime-check.log" >nul 2>&1

set "ISCC="
for /f "delims=" %%I in ('where ISCC.exe 2^>nul') do if not defined ISCC set "ISCC=%%I"
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"

if not defined ISCC (
    echo [ERROR] Inno Setup 6 no esta instalado.
    echo Instala Inno Setup 6 y vuelve a ejecutar este archivo.
    pause
    exit /b 1
)

"%ISCC%" "installer\TKDFight.iss"
if errorlevel 1 (
    echo [ERROR] No se pudo compilar el instalador.
    pause
    exit /b 1
)

echo [OK] Instalador generado en la carpeta release.
pause