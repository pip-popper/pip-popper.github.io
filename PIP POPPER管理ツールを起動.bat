>nul 2>&1 rem (this line absorbs the UTF-8 BOM so that cmd does not print an error)
@echo off
chcp 65001 >nul
rem PIP POPPER 管理ツール（Version 1）を起動する。ダブルクリックで使う。
cd /d "%~dp0"
title PIP POPPER 管理ツール
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。保守マニュアル 第9章の「別のパソコンで行う場合」を参照してください。
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo Git が見つかりません。保守マニュアル 第9章の「別のパソコンで行う場合」を参照してください。
  pause
  exit /b 1
)
echo PIP POPPER 管理ツールを起動しています...
node "manager\server.mjs"
echo.
echo 管理ツールを終了しました。この画面は何かキーを押すと閉じます。
pause
