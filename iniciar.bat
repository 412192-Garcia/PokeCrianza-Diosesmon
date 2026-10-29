@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Busca Python: primero "python", después el lanzador "py" de Windows.
set PY=
python --version >nul 2>&1 && set PY=python
if not defined PY py -3 --version >nul 2>&1 && set PY=py -3

if not defined PY (
  echo.
  echo  No encontre Python en esta computadora.
  echo.
  echo  1. Descargalo gratis de https://www.python.org/downloads/
  echo  2. Al instalarlo, marca la casilla "Add python.exe to PATH".
  echo  3. Despues volve a abrir este archivo.
  echo.
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)

echo Abriendo PokeCrianza en el navegador... (no cierres esta ventana mientras lo uses)
%PY% servidor.py
pause
