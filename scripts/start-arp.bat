@echo off
REM Abre o Monitor de Rede (eleva a admin e mantem a janela aberta via abrir.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0abrir.ps1"
