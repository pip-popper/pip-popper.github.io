# Windows管理ツールEXE — 2026-11-22

担当は既存ChatGPT Work（Codex）。ProducerがClaudeからの移管を明示承認。開始HEAD 3f103e2、main、未push 8件、開始時差分なし。
Windows正本：体系13.0.0／PACS12.1.1／Gate13.0.0／Environment3.10.3。manifestと3文書のSHA-256一致、今回の指示に適合。

## 正式成果物

- プロジェクト直下：PIP POPPER管理ツール.exe（Windows x64 GUI、7,680バイト）。
- SHA-256：A146FE688000E6460C14FCE1C247F07373743CBF869D20D8837062BDD3C039D5
- manager/runtime/node.exe：Node.js v24.18.0、SHA-256 9A4EB5F1C29C6A2E93852EAD46B999E284A6A5CA8BAB4D4E241D587D025A52DE。
- manager/runtime/git/：Git 2.55.0.windows.5（cmd・mingw64・usr・etc・LICENSE.txt）。本PC既存インストールから複製し、全ディレクトリのファイル数・合計バイト数一致。runtime全体は9,581ファイル、509,048,800バイト。
- EXEとruntimeはローカル成果物としてGit対象外。復旧用BATと既存データは維持。

## 実施した確認

- .NET Frameworkコンパイラでビルド成功。PEヘッダーのGUI subsystem＝2（コンソールを割り当てない）。
- 正式フォルダで、EXE→同梱Node→管理サーバー起動の準備完了を確認。
- 同じEXEの2回目起動は正常終了し、起動済みランチャーへ再表示イベントを送る。
- EXE終了時に標準入力パイプが閉じ、専用Nodeも停止（Node PIDが消失）。
- プロジェクト一式を日本語・空白のある別フォルダへコピーし、システムNode/GitをPATHから外して同じ起動・重複・終了試験に合格。
- 別サーバーで18990を使用中に起動。EXEは空きポートを使い起動できる。
- APIの認証・編集・PRIVATE操作・表示切替のコードは維持。Windows子プロセスにwindowsHideを追加。
- PRIVATE模擬管理テスト61項目、パスワードテスト53項目は合格。本番への変更要求は未実施。
- docs・private・tracks・albums・contentのGit差分なし。既存未push 8件も維持。

## 未完了

- 管理ツールの既存HTTPテストはローカル接続EACCES（実行環境の制限）で0合格・1例外。合格扱いにしない。
- EXE結合テストのHTTP接続も同じ制限。正式画面の編集・プレビュー・PRIVATE画面のチェックボックス・「終了」ボタン経由の正常終了は実機確認が残る。
- 既定ブラウザ表示・黒い画面の実目視は未確認。ブラウザ起動はWindows ShellExecute、Node/Gitの子プロセスは非表示指定。
- .git/index.lockの作成拒否でステージ・commit不可。現HEADは3f103e2のまま。Git履歴の削除・再初期化・権限変更は未実施。
- 保守マニュアル側は書込み許可範囲外のため、今回の詳細は本ファイルとHANDOVER.mdに記録。

再検証の入口：通常権限PowerShellから node manager/test-manager.mjs と node manager/test-launcher.mjs。後者は本番PRIVATEやGitHubへ送信しない。

## 続行指示後の再実行（2026-11-22）

- Producerの移管・実装検証承認の継続を受領。同じWork・main・HEAD 3f103e2と既存差分の所有者を照合。正式標準の体系13.0.0と3文書のVersion／SHA-256を再取得・照合し、指示は承認範囲と適合。
- 管理ツールテストを再実行したが、HTTP接続失敗で0合格・1例外。EXE結合テストも `connect EACCES 127.0.0.1` で失敗。合格には更新しない。
- `git add` を再実行したが、`.git/index.lock` の作成が Permission denied。HEADは維持、commit・pushなし。
- 現在の実行権限設定は sandbox_approval を自動拒否するため、期限切れ承認の再申請経路は利用不可。権限変更や別経路による制限回避は行っていない。
- EXEのSHA-256は上記の正式成果物と一致。`git diff --check` に内容エラーなし。docs・private・tracks・albums・contentにGit差分なし。本番への操作なし。
- `node manager/test-launcher.mjs --lifecycle-only` は正式フォルダと日本語・空白を含む移動先の両方で合格（起動、重複再利用、ランチャー消失時の専用サーバー停止）。HTTPを使わない範囲の再確認結果。
