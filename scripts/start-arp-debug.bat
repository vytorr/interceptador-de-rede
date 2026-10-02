@echo off
title Monitor de Rede (DEBUG)

REM --- Garante privilegios de administrador ---
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

REM --- Modo debug: mostra todo SNI capturado e as estatisticas do bloqueio ---
cd /d "%~dp0.."
set "MONITOR_DEBUG=1"
node src\main.js
