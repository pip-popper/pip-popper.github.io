# PIP POPPER PRIVATE（招待者専用の音源ライブラリ）

公式サイト（GitHub Pages）とは別に、Cloudflare Worker が「入室画面・パスワード確認・音源配信・管理画面」をまとめて担当する。
音源は非公開の Cloudflare R2 にだけ置き、GitHub には入れない。

| 場所 | 内容 |
|---|---|
| `worker/src/index.js` | 入口（招待者の入室・音源配信のルート） |
| `worker/src/admin.js` | 管理画面 `/admin` と管理API（追加・差し替え・並べ替え・外す・戻す） |
| `worker/src/catalog.js` | 曲目 `catalog.json` の安全な更新（競合防止・差し替えの切り替え・不要ファイルの整理） |
| `worker/src/audio.js` | 音源配信（シーク用の範囲取得・ダウンロード・保存禁止） |
| `worker/src/common.js` | 署名・応答・ログイン失敗の制限（Durable Object） |
| `worker/src/pages.js` | 画面（公式サイトと同じB-3デザイン） |
| `worker/public/assets/` | `private.*`（招待者）・`admin.*`（管理）。`site.css` `stage.jpg` は公式サイトからコピーする生成物 |
| `tools/private.mjs` | `assets`（デザインのコピー）・`backup`（R2の全曲を新しいフォルダーへ保存） |
| `dev/` | Cloudflareなしで動かす模擬環境・自動テスト（`node private/dev/test-admin.mjs`） |

## 秘密の値（GitHub・HTML・チャットに書かない）

Cloudflare 管理画面（Workers & Pages → pip-popper-private → Settings → Variables and Secrets、Type: Secret）で登録する。

- `PRIVATE_PASSWORD`：招待者共通のパスワード。変更すると招待者全員が退室状態になる。管理ツールでパスワードを変えた後は使われず、「戻す」ときの予備になる（下の「招待者のパスワード」）。
- `ADMIN_PASSWORD`：管理者パスワード（12文字以上、招待者用とは別）。未設定なら管理画面は閉じたまま。
- `SESSION_KEY`：入室Cookieの署名鍵（ランダム値、登録済み）。

## 招待者のパスワード（管理ツールから変更、2026-11-22）

- 初期状態（R2に下記ファイルがない間）：`PRIVATE_PASSWORD`（シークレット）で照合。これまでと同じ。
- 管理ツールの「PRIVATE管理」で変更すると、非公開R2の `auth/private-password.json` に**照合値だけ**を保存（`HMAC-SHA256(SESSION_KEY, "pw-hash:" + 乱数salt + ":" + パスワード)`、パスワードそのものは保存しない）。以後はこちらで照合し、`PRIVATE_PASSWORD` は使わない。
- 即時反映：入室時と毎回のCookie確認でこのファイルを読む（キャッシュなし）。変更ごとに新しい乱数IDを作り、それをCookieの版にするため、変更前のCookieは直ちに無効。
- 読めない・壊れているときは誰も入れない（古いパスワードに勝手に戻らない）。
- API（管理Cookie＋同一サイト＋`X-PP-Admin`、さらに本文の管理者パスワードを毎回再確認）：`GET /admin/api/private-password`（状態のみ）、`POST /admin/api/private-password`（`newPassword`、8〜200文字）、`POST /admin/api/private-password/restore`（`confirm: "旧パスワードに戻す"`、ファイルを消して `PRIVATE_PASSWORD` に戻す）。試行は全体で1時間10回まで（超えると60分ロック）、管理者パスワードの誤りは管理者ログインのロックにも数える。
- 注意：`SESSION_KEY` を変えると保存済みの照合値は使えなくなる（入室不可）。その場合はダッシュボードのR2で `auth/private-password.json` を削除すると `PRIVATE_PASSWORD` に戻る。自動整理は `audio/` だけ、音源配信は曲目に載ったファイルだけなので、このファイルが配信・削除されることはない。
- テスト：`node private/dev/test-password.mjs`（模擬環境）。

## 曲の管理（管理画面 `/admin`）

- **音源を差し替え**：新しいMP3は別名で保存し、ブラウザで計算した指紋（SHA-256）をR2が照合、大きさ・形式も確認してから曲目を切り替える。それまで・失敗時は旧音源のまま。音源のアドレスに版番号が付くので古い音源がキャッシュから再生されることはない。
- **競合防止**：操作は画面が表示していた版（rev）と一致するときだけ反映し、曲目の書き込みもR2の条件付き書き込みで行う。別の画面・端末で先に変更されていたら何も変えずに最新を表示する。
- **不要ファイルの削除**：変更操作の後にだけ実行。24時間を過ぎ、どの曲も使っていない音源だけを削除する（画面を開くだけでは削除しない）。外した曲は23時間以内なら元に戻せる。
- **ログイン制限**：管理者は同じ回線で10分に5回失敗→60分、全体で1時間に20回失敗→60分ロック（招待者の入室には影響しない）。

## 原本とバックアップ

- 原本は `AI作業\PIP POPPER PRIVATE音源\`。管理画面やR2の操作はこのフォルダーに一切触れない。
- `node private/tools/private.mjs backup` で、R2の全曲を `PIP POPPER PRIVATE音源\R2バックアップ\<日時>\` に保存（毎回新しいフォルダー、上書き・削除なし）。
- 以前の `曲目.txt` と `upload` コマンドは管理画面に置き換え済み（管理画面の変更を上書きしないよう送信機能は廃止）。

## 招待者ライブラリのコンパクト表示（2026-11-22、ローカル未反映）

- 担当：既存ChatGPT Work。正式標準体系13.0.0のVersion・hashを照合し、今回の画面改善指示と適合。開始HEAD 3f103e2、未push8件とEXE化の既存未コミット差分を保護。
- 従来：各曲に大きなジャケットとaudioを縦一列に表示しており、21曲以上ではスクロール量が大きい。
- 変更：招待者一覧だけ3列（1050px超）／2列（380〜1050px）／1列（379px以下）。600px以下はサムネイルを省き曲名と操作を優先。タイトルは省略せず折り返す。操作は44px以上。
- 上部の選択曲プレーヤーをスクロール中も保持。高さ500px以下は通常配置にして一覧の操作領域を確保。初期は1曲目を選択するだけで自動再生しない。曲ボタンは選択して再生、ネイティブaudioで一時停止・再開・シークする。別曲を選ぶと前曲を一時停止し、元のaudio要素をカードへ戻す。同じ要素を使い音源URL・再生位置を維持する。選択曲は赤枠、実際の再生中だけ「● 再生中」。終了・一時停止・エラーは上部に表示。
- JavaScriptが無効な場合は各カードのaudioとダウンロードリンクを維持。管理画面・入室画面へ一覧専用CSSを適用しない。音源配信・認証・Cookie・R2・曲目・管理ツールは修正なし。
- 変更ソース：worker/src/pages.js、worker/public/assets/private.css、worker/public/assets/private.js。検証：dev/test-library.mjs（.gitignoreへ許可行追加）。記録：本節とHANDOVER.md。
- 検証済み：node --check（上記JS・テンプレート）、node private/dev/test-library.mjs、node private/dev/test-admin.mjs（61項目）、node private/dev/test-password.mjs（53項目）。後者の故障ケースのError出力は想定内で、最終判定はすべて合格。50曲のHTML、長い曲名・特殊文字のescape、順序・ダウンロード維持、DOM模擬環境で選択・単独再生・pause/resume・位置保持・終了・エラーを確認。
- 未確認：実ブラウザでの列数・折返し・sticky・タッチ操作、実音声の再生とシーク。Edgeのheadlessでfileプレビューを試したがDOM出力を取得できず、実描画合格とはしない。.manager/private-layout-review/library.html に架空50曲の確認用HTML（外部フォント・音源は含めない）。
- Git：このWorkの.gitは読取り専用、ローカル通信制限も既知のため失敗する操作は反復せず、未コミット。EXEのSHA-256は A146FE688000E6460C14FCE1C247F07373743CBF869D20D8837062BDD3C039D5 のまま。push・デプロイ・本番R2操作なし。
- Claude引継ぎ：Producerの担当交代指示後、正式標準とHANDOVER・差分を照合。上記模擬テストを必要範囲で確認し、PC1440／タブレット768／スマホ390・360px、21／30／50曲と長い曲名を表示検査。既存PRIVATEへ現在のパスワードで入れること、2曲切替・一時停止・再開・シーク・ダウンロード・管理画面を確認。既存EXE差分を混ぜずPRIVATE改善分をローカルGit保存する（.gitignoreとHANDOVERはEXE差分もあるので部分ステージ）。Cloudflare本番反映は今回の承認外。別途Producer承認後だけデプロイする。
- Claude検証（2026-11-22）：模擬環境（架空30曲・長い曲名・30秒の試験音）を実ブラウザで表示。1440px＝3列、768px・390px・844×390（横向き）＝2列、375px・360px＝1列、横スクロールなし、曲名のはみ出しなし、ボタン44px以上。スクロール中も上部プレーヤーが見える（横向きの低い画面では固定しない）。実際の音声で、曲ボタンでの再生・一時停止・再開・再生位置の変更（Range 206）・別の曲への切替（前の曲は止まりカードへ戻る、同時再生は1曲だけ）・終了表示を確認。ログインなしの音源・招待者からの管理APIは401、管理画面に一覧用の表示は混ざらない。修正：開いた直後の表示を「停止中・一時停止」→「選択中（再生ボタンで再生）」、一時停止は「一時停止中」。

