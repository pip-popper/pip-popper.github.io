# HANDOVER — 担当・進捗・残件（PACS-10）

Claude Code と ChatGPT Work の共通の引継ぎ記録。**書き込むのは「現在の担当」だけ。** 交代するときは下の手順で直列化する。
詳しい作業の経緯（非公開）は `..\PIP POPPER保守マニュアル\AI・担当者向け引継ぎ記録.md`。

## 現在の担当

| 項目 | 内容 |
|---|---|
| 担当AI | Claude Code（Producerの指示でChatGPT Workから交代、2026-11-22） |
| 状態 | PRIVATE一覧改善を本番反映済み（c44a4e36）。Producerの実機確認待ち |
| 正式パス | `C:\PRODUCER SSD\PRODUCER OFFICE\AI作業\PIP POPPER公式サイト\` |
| ブランチ | `main` |
| 開始時HEAD | 3f103e2（ChatGPT Workの未コミット差分＝PRIVATE一覧改善とEXE化を受領） |
| 復元点 | `1a0b059`（管理ツール導入前）。バックアップ bundle は `..\PIP POPPER保守バックアップ\GitHubリポジトリ` |
| 未コミット差分と所有者 | EXE化（ChatGPT Workの成果、未commitのまま保護・未検証の部分あり）：.gitignore の EXE 許可行、README.md、build.mjs、manager/README.md・server.mjs・test-manager.mjs、manager/EXE-VERIFICATION.md・Launcher.cs・build-launcher.ps1・test-launcher.mjs、HANDOVER.md の EXE 記録2件。PRIVATE一覧改善は commit 済み |
| 更新日 | 2026-11-22 |

## 進捗

- 2026-11-22 Producerの承認でPRIVATE一覧改善を本番デプロイ（5639c9c、Version `c44a4e36-7dc8-4c88-9eed-b42a298cb3ad`、復元点 `299d45f8-71aa-4520-b0e1-83b3c1274433`）。更新は private.css・private.js・pages.js のみ。本番の配信物がcommitと一致、入口200・未ログイン音源401・管理画面200・管理API401。R2はデプロイで変更なし（曲目 rev 78・23曲は当日10:09までの管理画面での追加、照合ファイルあり＝管理ツールでの変更済み）。

- 2026-11-22 Claude Code：PRIVATE一覧改善を検証（模擬環境の実ブラウザで PC・タブレット・スマホ幅、架空30曲、実音声の再生・一時停止・位置変更・切替、認証・管理への影響なし）。小修正1件（開いた直後の状態表示）。テスト：一覧・PRIVATE既存61・パスワード53 合格。PRIVATE分だけ commit（EXE化の差分は未commitのまま保護）。本番未反映。

- 2026-11-22 PRIVATE一覧改善：招待者ページだけPC3列／1050px以下2列／379px以下1列。上部に選択曲と既存のネイティブaudioを集約しsticky表示（低い横向き画面では通常配置）。選択・再生中を赤い枠と文字で表示。曲・順序・音源URL・認証・管理処理は不変。変更は private/worker/src/pages.js、public/assets/private.css・private.js、private/dev/test-library.mjs、許可行の.gitignore、本記録とprivate/README.md。既存EXE差分は保護。管理61・パスワード53の模擬テスト合格、50曲と長い曲名のHTML・DOM模擬操作テスト合格。PC・スマホの実描画／実音声の再生・シークは未確認（Edgeのheadless出力取得不可）。既知のHTTP／Git権限制限は再試行せず、未コミット・未push・未デプロイ。Claudeへの残工程はprivate/README.md末尾。担当交代はProducerの指示後にPACS-10で行う。

- 2026-11-22 管理ツール v1（文字情報の編集・保存・プレビュー・公開・取り消し）を実装。`content/site.json` を新設し、`build.mjs` 内の通常編集する文言を移動（生成されるサイトは全167ファイルが変更前と同一）。README・CLAUDE.md・AGENTS.md・本ファイルを整備。自動テスト 44項目合格、検証用の送信先で公開・取り消しを確認。本物の GitHub への公開は未実施（Producerの承認待ち）。

- 2026-11-22 管理ツールの編集対象を整理（自分で直せる＝A／固定・AI依頼＝B）。A に追加：ヒストリー・その他の作品ページの見出しといちばん下の文、メッセージ欄の説明文、音源非公開の曲ページの文（`content/site.json`、生成サイト167ファイル不変）、曲の配信リンク（Spotify・YouTube・Suno・Apple Music、https・対応サイトのみ、非公開曲は対象外）。画面の一覧に「固定（変更はAIに依頼）」、使い方にA／Bの区分を表示、`manager/README.md` に区分表。安全強化：AI等のまだ公開していない保存点があるときは管理ツールから公開しない（一緒に送らない）。自動テスト64項目合格。

- 2026-11-22 初回公開前の最終整備：テストスクリプトを修正（管理ツールがGit登録済みでも「test base」の保存点を作る `--allow-empty`）し、正式リポジトリから 64項目合格。バックアップ `pip-popper.github.io_20261122.bundle` を作成（既存の 20261118 は残す。指紋・復元確認は保守マニュアル側の引継ぎ記録）。公開前の安全確認（読み取り）：3件の commit は docs/・private/ を変えない、公開中の172ファイルと HEAD の docs が全一致、秘密情報なし。

- 2026-11-22 PRIVATEの招待者パスワードを管理ツールから変更する機能をローカル実装（Producer承認の方式：非公開R2に照合値、Cloudflare APIトークンなし）。Worker：`private/worker/src/credential.js` 新設、入室・Cookie確認・管理API（変更・戻す・状態）。管理ツール：「PRIVATE管理」画面。テスト：PRIVATE既存61・パスワード49・管理ツール77 すべて合格。**Cloudflareへのデプロイ・本番R2への書き込み・実際の変更は未実施**（本番反映はProducerの別途承認）。

- 2026-11-22 PRIVATEパスワード機能の最終コードレビュー：重大な問題なし。小規模修正2件（照合ファイルが壊れていても「戻す」で消せる／変更回数の制限を「数えると同時に判定」にして同時要求でも上限を超えない、上限＝1時間10回）。管理ツールのテストが「更新前のPRIVATE」として公開中の版（origin/main）を使うよう修正。テスト：PRIVATE既存61・パスワード53・管理ツール77 すべて合格。最新版バックアップを作成（保守マニュアル側の記録に指紋）。

- 2026-11-22 PRIVATE Worker を本番デプロイ（Producer承認、cc6aa70、Version `299d45f8-71aa-4520-b0e1-83b3c1274433`、復元点 `0be66075-616d-4239-bd39-c977dcc2362b`、`npx wrangler rollback <ID>` で戻せる）。バインディング・移行・秘密の値は変更なし。パスワードなしでできる本番確認（入口・音源の拒否・管理画面・新APIの拒否・R2不変）と管理ツールからの接続（違う管理者パスワード→正しく拒否）は正常。実際のパスワード変更・push は未実施。

- 2026-11-22 管理ツールの「PRIVATE管理」に「パスワードを表示」チェックボックスを追加（新しいパスワード・確認用・管理者パスワードの3つを一緒に表示／伏字。初期は伏字、切り替えても入力は消えない。画面を開き直すと伏字に戻る）。送信・認証・入力の消去は変更なし。画面で切替を確認、管理ツールテスト77合格。

## 既知の事項（公開物）

- `docs/` の172ファイルのうち、`build.mjs` が作るのは167。残り5つは初期（2026-11-14〜16）の画像で、今のページからは参照されていない：`docs/assets/covers/anniversary.png`・`busu-no-hitomi.png`・`job-hunting.png`・`manner.png`（初期の曲ジャケット原寸PNG、表示は現在 jpg）、`docs/assets/pip-popper-logo.png`（初期のロゴ）。URLを直接開けば見られる。削除するかは Producer 判断（公開物の変更になるため未対応）。
- `docs/assets/Anton-OFL.txt`（フォントのライセンス文）：Git には LF で保存されているが、作業フォルダーの `src/Anton-OFL.txt` は CRLF と LF が混在（`core.autocrlf=true` の環境）。`build.mjs` はファイルをそのままコピーするため、別フォルダーに作ると改行だけ違うが、`docs/` に作って Git に入れる時に自動で LF にそろうため、公開されるファイルは変わらない（改行を除いた内容は同一、`node build.mjs` 後の `git status` も変化なし）。

## 残件・承認待ち

0. PRIVATE：Producer が今のパスワードで入室・再生・管理画面を確認 → 準備ができたら管理ツールの「PRIVATE管理」から招待者パスワードを変更。
1. 管理ツール v1：Producer 実機確認（BATのダブルクリック起動、曲名の修正・保存・プレビュー・破棄／取り消し）。
2. 管理ツールからの本番公開：Producer の承認後に1回目を実施して確認（GitHub への送信はこのPCの保存済み資格情報を使う）。
3. 文言の更新判断：トップのヒストリー欄とヒストリーのリード・説明文が「1999年から2001年へ／…PROFESSIONALまで」のまま（現在は2012年まで掲載）。管理ツールの「サイトの文言」で直せる。
4. 今後：管理ツール v2（画像差し替え・曲の追加・並べ替え）→ PRIVATE管理画面の拡張 → 一般公開の再生（調査報告書の段階④〜⑥）。

## 次の一手

Producer が管理ツールを実機で確認 → 本番公開の承認 → 1回目の公開を確認。

## 交代の手順（PACS-10）

1. 交代は Producer の了承を得てから。
2. 前担当：書込みを止める → この表の「状態」を「停止・引渡し可」にし、HEAD・未コミット差分（あれば所有者と内容）・残件を書いて commit → 引渡しを伝える。
3. 後担当：`git status`・`git log -1`・差分をこの表と照合 → 不明な差分や停止未確認があれば書き込まない → 一致すれば「担当AI」「状態＝作業中」「開始時HEAD」を自分の内容に更新して commit してから作業を始める。
4. 同時に書き込まない（ブランチや別フォルダーを使っても同じ）。
