@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动野生 AI 观察室……
start "野生 AI 观察室服务" cmd /k "node server.mjs"
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:4173"
echo.
echo 电脑地址：http://127.0.0.1:4173
echo iPad 地址和访问码会显示在“野生 AI 观察室服务”窗口中。
echo.
echo 关闭名为“野生 AI 观察室服务”的窗口即可停止服务。
pause
