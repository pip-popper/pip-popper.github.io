# PIP POPPER PRIVATE 段階2：Cloudflare設置手順

パスワード・カード情報・確認コードは、チャットやファイルに書かないでください（Producer本人が画面に直接入力）。

## A. Producerが行う操作（ブラウザ）

1. **アカウント作成**：https://dash.cloudflare.com/sign-up でメールアドレスとパスワードを登録し、届いた確認メールを開く。
2. **2段階認証**：右上の人型アイコン → My Profile → Authentication → Two-Factor Authentication を有効にする（認証アプリ推奨）。
3. **R2の有効化**：左メニュー Storage & databases → R2 → Overview → 画面の案内に沿って R2 の利用を開始（支払い方法の登録が求められます。無料枠内なら請求は0円）。
4. **workers.dev の名前**：左メニュー Workers & Pages を開き、初回に表示される workers.dev のサブドメイン名を決める。
   - PRIVATEのアドレスは `https://pip-popper-private.＜この名前＞.workers.dev/` になり、招待者に伝える公開アドレスになる。
5. **請求の通知（推奨）**：Manage Account → Notifications で、請求・使用量に関する通知を有効にする。

終わったら「Cloudflareの準備完了」と、決めた workers.dev の名前を伝えてください。

## B. Claude Codeが行う操作（承認後）

1. `private/worker` に wrangler 4.156.2（Cloudflare公式ツール）を導入する。
2. `npx wrangler login` を実行する。
   - ブラウザにCloudflareの許可画面が開くので、**Producerが内容を確認して「Allow」を押す**。
3. 非公開のバケット `pip-popper-private` を作成する（公開設定はしない）。
4. Workerを設置し、署名鍵 `SESSION_KEY` をランダムに生成して登録する（値は画面に表示しない）。
5. 最初の1曲を送信する。

## C. Producerが行う操作（ターミナル）：共通パスワードの登録

Claude Codeが用意したターミナルで、次を実行し、表示された入力欄にパスワードを直接入力（12文字以上推奨）。

```
npx wrangler secret put PRIVATE_PASSWORD
```

## D. 動作確認（Claude Code＋Producerの実機）

- パスワードなしで音源のアドレスを直接開いても再生・ダウンロードできない（401）。
- 誤ったパスワードでは入室できない。
- 正しいパスワードで入室し、PC・スマホで試聴・シーク・MP3ダウンロードができる。
- 退室すると再び入室画面になる。

確認後、段階3（公式サイトのヘッダーに「PRIVATE」入口を追加）に進むかを判断する。
