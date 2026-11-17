# PIP POPPER PRIVATE（招待者専用の音源ライブラリ）

公式サイト（GitHub Pages）とは別に、Cloudflare Worker が「入室画面・パスワード確認・音源配信」をまとめて担当する。
音源は非公開の Cloudflare R2 にだけ置き、GitHub には入れない。

| 場所 | 内容 |
|---|---|
| `worker/src/index.js` | 認証（署名付きCookie）と音源配信（試聴の範囲取得・ダウンロード） |
| `worker/src/pages.js` | 入室画面・ライブラリ画面（公式サイトと同じB-3デザイン） |
| `worker/public/assets/` | `private.css` `private.js`。`site.css` `stage.jpg` は公式サイトからコピーする生成物 |
| `worker/wrangler.toml` | Cloudflare設定（パスワード・鍵は書かない） |
| `tools/private.mjs` | 曲目の確認と、R2に置く中身（`.r2/`）の作成 |
| `dev/serve.mjs` | Cloudflareなしで動かすローカル検証用サーバー |

## 秘密の値（GitHub・HTML・チャットに書かない）

- `PRIVATE_PASSWORD`：招待者共通のパスワード。変更すると全員が退室状態になる。
- `SESSION_KEY`：入室Cookieの署名鍵（32文字以上のランダム値）。

どちらも Cloudflare の Worker secret としてだけ登録する。`PRIVATE_PASSWORD` は Cloudflare 管理画面（Workers & Pages → pip-popper-private → Settings → Variables and Secrets、Type: Secret）で Producer が入力する。

## ログイン失敗の制限

同じ回線から10分間に5回パスワードを間違えると、15分間は正しいパスワードでも入室できない（`LoginGuard` = Durable Object、SQLite保存。Workers Free で利用可、超過時は課金ではなくエラー）。IPv6 は /64 単位で数える。

## 曲の追加・削除

1. `AI作業\PIP POPPER PRIVATE音源\` に `<曲ID>.mp3` を置く（曲IDは公式サイトの `tracks\<曲ID>`）。
2. 同じフォルダーの `曲目.txt` に曲IDを1行追加する（削除は行を消す）。上から順に並ぶ。
3. `node private/tools/private.mjs build` で確認とまとめを行い、R2へ送る（送信手順は段階2で追加）。

プログラムの変更は不要。原本は上記フォルダー（R2は配信用の写し）。別の場所にも定期的にバックアップする。

## ローカル検証

```
node private/tools/private.mjs assets
node private/tools/private.mjs build --audio <検証用フォルダー> --out <検証用R2フォルダー>
node private/dev/serve.mjs --vars <秘密の設定ファイル> --r2 <検証用R2フォルダー>
```
