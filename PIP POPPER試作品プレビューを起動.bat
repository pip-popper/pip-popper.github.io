>nul 2>&1 rem (this line absorbs the UTF-8 BOM)
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title PIP POPPER 試作品プレビュー
if not exist "manager\runtime\node.exe" (
  echo 同梱のNode.jsが見つかりません。保守担当に確認してください。
  if /I not "%~1"=="--check" pause
  exit /b 1
)
if /I "%~1"=="--check" (
  "manager\runtime\node.exe" "manager\prototype-preview.mjs" --check
  if errorlevel 1 exit /b 1
  exit /b 0
)
echo PIP POPPER 試作品を起動しています（本番接続なし）...
"manager\runtime\node.exe" "manager\prototype-preview.mjs"
if errorlevel 1 (
  echo 試作品を起動できませんでした。
  pause
  exit /b 1
)
echo.
echo 試作品を終了しました。この画面は何かキーを押すと閉じます。
pause
