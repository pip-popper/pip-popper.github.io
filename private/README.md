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

- `PRIVATE_PASSWORD`：招待者共通のパスワード。変更すると招待者全員が退室状態になる。
- `ADMIN_PASSWORD`：管理者パスワード（12文字以上、招待者用とは別）。未設定なら管理画面は閉じたまま。
- `SESSION_KEY`：入室Cookieの署名鍵（ランダム値、登録済み）。

## 曲の管理（管理画面 `/admin`）

- **音源を差し替え**：新しいMP3は別名で保存し、ブラウザで計算した指紋（SHA-256）をR2が照合、大きさ・形式も確認してから曲目を切り替える。それまで・失敗時は旧音源のまま。音源のアドレスに版番号が付くので古い音源がキャッシュから再生されることはない。
- **競合防止**：操作は画面が表示していた版（rev）と一致するときだけ反映し、曲目の書き込みもR2の条件付き書き込みで行う。別の画面・端末で先に変更されていたら何も変えずに最新を表示する。
- **不要ファイルの削除**：変更操作の後にだけ実行。24時間を過ぎ、どの曲も使っていない音源だけを削除する（画面を開くだけでは削除しない）。外した曲は23時間以内なら元に戻せる。
- **ログイン制限**：管理者は同じ回線で10分に5回失敗→60分、全体で1時間に20回失敗→60分ロック（招待者の入室には影響しない）。

## 原本とバックアップ

- 原本は `AI作業\PIP POPPER PRIVATE音源\`。管理画面やR2の操作はこのフォルダーに一切触れない。
- `node private/tools/private.mjs backup` で、R2の全曲を `PIP POPPER PRIVATE音源\R2バックアップ\<日時>\` に保存（毎回新しいフォルダー、上書き・削除なし）。
- 以前の `曲目.txt` と `upload` コマンドは管理画面に置き換え済み（管理画面の変更を上書きしないよう送信機能は廃止）。
