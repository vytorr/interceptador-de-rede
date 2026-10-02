@echo off
title Instalacao do Monitor de Rede

REM --- Pede permissao de administrador (necessaria para instalar) ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Pedindo permissao de administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

REM --- Roda o instalador ---
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\instalar.ps1"
