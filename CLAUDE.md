# PIP POPPER公式サイト - AI作業の入口（Claude Code／ChatGPT Work 共通）
# Version: 管理ツール v1（2026-11-22）

この内容は `CLAUDE.md`（Claude Code）と `AGENTS.md`（ChatGPT Work）で同じ。片方を変えたらもう片方も同じに変える。

## 位置づけ

PIP POPPER（ピップポッパー）の公式サイト（GitHub Pages）と、招待者専用の音源ライブラリ PRIVATE（Cloudflare）。
親フォルダの共通ルール（`../CLAUDE.md` = Producer Project AI Instruction）に従う。優先順位は `../CLAUDE.md` の「Priority」。

## 作業前に必ず

1. Producer AI Standards の正式最新版を取得・照合する：`C:\PRODUCER SSD\PRODUCER OFFICE\AI作業\Producer AI Standards\standards\START_HERE.md`（manifest・3文書のVersion・SHA-256、GATE-06A）。
2. `HANDOVER.md` の担当欄・残件と `git status`・HEAD を照合する。**書き込むのは担当欄の担当だけ**（同時書込み禁止、交代は PACS-10）。
3. 非公開の運用記録（このリポジトリの外）：`..\PIP POPPER保守マニュアル\`（保守マニュアル、`AI・担当者向け引継ぎ記録.md`、調査報告書）。

## 共通標準の参照先

- `../PAS（Producer Architecture Standard）/`（どれが共通かは README で確認）
- 適用：Launcher Script Standard（起動BAT）、User Data Protection Standard（確認・失敗時保護）、Implementation Policy。
- 適用しない：Finance DB 専用文書、Window State／File Dialog（ブラウザ画面のため該当なし）。
- デザイン：公式サイトの採用デザイン（B-3、`src/`）。管理ツール・PRIVATE管理画面も同じ色調を使う。新しいデザインを独自に選ばない。

## プロジェクト目的

PIP POPPERの作品（歌詞・ジャケット・制作秘話）を長く残す公式アーカイブ。Producer本人がAIなしで日常運営できることを目標にする。

## 技術構成

- 公式サイト：Node.js（`build.mjs`）が JSON データから静的HTMLを `docs/` に生成 → GitHub `pip-popper/pip-popper.github.io` の `main` `/docs` を GitHub Pages で公開。画像変換は Python（Pillow）。
- PRIVATE：Cloudflare Worker（`private/worker/`）＋非公開R2＋Durable Object。詳細は `private/README.md`。
- 管理ツール v1：`manager/`（Node.js、依存なし、127.0.0.1 だけで動くローカルサーバー＋ブラウザ画面）。詳細は `manager/README.md`。

## 固定仕様（変更禁止・守ること）

- 公式サイト（GitHub）に音源を置かない（`build.mjs` が停止する。`track.json` の `audio` は null）。
- 人物はイニシャル表記（H・T・G・TD など）。実名・旧活動名・本人写真を公開しない。リポジトリは公開なので、コード・データ・commit にも書かない。
- GitHubへの push・本番公開は Producer の「公開を承認」の後だけ（管理ツールでProducer本人が押す公開は本人の操作）。
- 採用済みのアルバム特設デザイン・画像は、指示なしに作り直さない。
- 秘密の値（PRIVATE_PASSWORD・ADMIN_PASSWORD・SESSION_KEY）は Cloudflare にだけ置く。どこにも書かない。
- PRIVATE の本番構成・パスワードは、明示の指示なしに変更しない。招待者パスワードは管理ツールから変えられる（照合値は非公開R2の `auth/private-password.json`、`private/README.md`）。

## 起動方法

- 管理ツール：`PIP POPPER管理ツールを起動.bat` をダブルクリック。
- サイトの再生成：`node build.mjs`（出力 `docs/`）。確認用の別出力：`node build.mjs --out <フォルダー>`。

## テスト方法

- 管理ツール：`node manager/test-manager.mjs`（一時フォルダーに検証用の送信先を作って保存・プレビュー・公開・取り消し・拒否条件を確認。本物のGitHubには触れない）。
- サイト：`node build.mjs --out <一時フォルダー>` で変更前後を `diff -r` し、意図した差分だけか確認。表示確認は `preview/history-review/shoot.mjs`（Edgeのヘッドレス撮影）。
- PRIVATE：`node private/dev/test-admin.mjs`・`node private/dev/test-password.mjs`（模擬環境）。
- 作業で開いた画面・プロセスの後片付けと終了確認は Producer AI Standards の GATE-07・GATE-10。

## 重要なファイル・パス

- `tracks/<曲ID>/track.json` ・ `cover.png` — 曲（曲名・歌詞・紹介文・掲載順）
- `albums/albums.json` ・ `albums/<ID>/` — HISTORY と その他の作品（作品ごとの文章・曲目・画像）
- `content/site.json` — サイトの短い文言（トップの一文、ヒストリー・その他の作品のリード、About）
- `src/*.css` — デザイン（作品別テーマは `src/history.css`）
- `build.mjs` — 生成プログラム（データ検証もここ）
- `manager/` — 管理ツール v1、`PIP POPPER管理ツールを起動.bat`
- `private/` — PRIVATE（Cloudflare Worker）
- `.gitignore` は**許可した物だけをGitに入れる方式**。新しいファイルを追加したら必ず許可行を足す。
- `.manager/` — 管理ツールのプレビュー・保存前の控え・ログ（Git対象外）

## PAS適用状況

- Launcher Script Standard：`PIP POPPER管理ツールを起動.bat`（UTF-8 BOM・CRLF・chcp 65001・`%~dp0`・失敗時 pause）。BOMで1行目が誤認識される現象への対策として、1行目にBOM吸収用の無害な行を置いている（2026-11-22 実機確認）。
- User Data Protection Standard：破棄・公開は対象と件数を示した確認ダイアログ（既定はキャンセル）、保存前の内容を `.manager/backup` に保存、失敗時は元のデータを保持、エラー文に内部パスを出さない。
