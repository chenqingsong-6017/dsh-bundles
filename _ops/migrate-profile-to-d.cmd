@echo off
chcp 65001 >nul
echo ============================================
echo  DSH profile 迁移到 D 盘
echo  运行前请完全退出 DSH（含右下角托盘图标）
echo ============================================
echo.
pause
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-profile-to-d.ps1"
echo.
pause