# PIP POPPER公式サイト

PIP POPPER（ピップポッパー）の公式サイトと、招待者専用の音源ライブラリ PRIVATE の正式ソース。

- 公開URL：https://pip-popper.github.io/
- 正式な作業フォルダー（正本）：`C:\PRODUCER SSD\PRODUCER OFFICE\AI作業\PIP POPPER公式サイト\`
- GitHub：`pip-popper/pip-popper.github.io`（`main` ブランチの `/docs` を GitHub Pages で公開。公開リポジトリ）
- AIで作業するとき：`CLAUDE.md`（Claude Code）／`AGENTS.md`（ChatGPT Work）→ `HANDOVER.md`（担当・進捗・残件）

## 日常の更新（Producer）

| やりたいこと | 方法 |
|---|---|
| 曲名・歌詞・紹介文・制作秘話・サイトの文言を直す／取り消す | **管理ツール**：`PIP POPPER管理ツール.exe` をダブルクリック（`manager/README.md`、EXE検証状況は `manager/EXE-VERIFICATION.md`） |
| PRIVATEの曲の追加・差し替え・並べ替え・外す | PRIVATE管理画面 `/admin`（`private/README.md`、保守マニュアル5-1） |
| パスワード変更・バックアップ・復旧 | 保守マニュアル（`..\PIP POPPER保守マニュアル\`、リポジトリ外） |
| 新しい曲・アルバムの追加、デザイン変更 | 現在はAI等の作業（管理ツール v2 で曲の追加を予定） |

## 構成

| 場所 | 内容 |
|---|---|
| `tracks/<曲ID>/track.json`・`cover.png` | 曲（曲名・歌詞・紹介文・制作背景・掲載順 `listOrder`・音源の公開区分）。表示用画像は `python tools/make-web-images.py` |
| `albums/albums.json`・`albums/<ID>/` | HISTORY（本体）と その他の作品（`"section": "other"`）。作品ごとの文章・曲目・画像。表示用画像は `python tools/make-album-images.py` |
| `content/site.json` | サイトの短い文言（トップの一文・ヒストリー欄の文、ヒストリー／その他の作品のリードと説明文、About） |
| `src/` | デザイン（`site.css` 共通、`history.css` HISTORY と作品別テーマ、ほか） |
| `build.mjs` | データを検証して `docs/` にサイトを生成（`--out <フォルダー>` で別の場所へ） |
| `docs/` | 公開されるサイト（生成物。手で直さない） |
| `manager/` | 管理ツール v1（ローカル専用） |
| `private/` | PRIVATE（Cloudflare Worker。秘密の値はCloudflareだけ） |
| `preview/` | 表示確認用の撮影スクリプト等（Git対象外） |

`.gitignore` は許可した物だけをGitに入れる方式。新しいファイルを追加したら許可行を足すこと。

## 生成・確認・公開（コマンドで行う場合）

```
node build.mjs                      # docs/ を作り直す
node build.mjs --out <フォルダー>     # 公開物を変えずに別の場所へ作る（確認用）
git add <変更したデータ> docs
git commit -m "..."
git push origin main                # 1〜3分で公開（Producerの承認後だけ）
```

元に戻す：管理ツールの「公開履歴・取り消し」、または Git の履歴（`git revert`）。バックアップ（bundle）は `..\PIP POPPER保守バックアップ\`。

## 守ること

公式サイトに音源を置かない／人物はイニシャル表記／公開はProducerの承認後／秘密の値はCloudflareだけ。詳細は `CLAUDE.md`。
