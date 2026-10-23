@echo off
cd /d D:/Documents/Claude Code\MCode
node out\remote-server.mjs --host 0.0.0.0 --port 7900 --token mcode-fold-2026 --data-dir "C:/Users/Wyatt/AppData/Roaming/mcode" >> "%~dp0gateway.log" 2>&1
