# 一般公開HPの並び替え・一般視聴（2026-11-23、ローカル候補）

## 本番方式（2026-11-24 決定・Claude Code）— 以下の旧方式の記述より優先

- **新しいサービスは作らない。** 一般視聴は既存の PRIVATE Worker の `/listen/`（パスワード不要）で配信する。URL：`https://pip-popper-private.pip-popper-private.workers.dev/listen/`。このアカウントでは新しい Worker を作っても `○○.pip-popper-private.workers.dev` になるため、別 Worker にしても URL 上の利点がなく、管理対象が増えるだけのため。
- **データは既存のR2の公開用の場所だけ**：`public-catalog.json`・`public-audio/<ID>.mp3`・`public-jackets/<ID>.jpg`。`/listen/` には「この3種類しか読めない読み取り口」だけを渡す（`private/worker/src/index.js` の `publicOnly`）。PRIVATE の音源（`audio/`）・曲目（`catalog.json`）・認証（`auth/`）・管理API には届かない。PRIVATE の「整理」は `audio/` だけを消すので公開用の場所に影響しない。
- **費用**：なし（既存の無料枠。R2 使用量は現在145MB／無料枠10GB、公開用の複製を足しても数百MB）。
- **掲載できる曲**：公式サイトですでに公開している曲だけ（`docs/works.json` にあり、音源非公開の指定がないもの）。歌詞・ジャケット・AIの感想は、公式サイトで公開済みのものを、Producer が承認した項目だけ載せる。新曲は公式サイトで公開した後に対象になる。
- **公開カタログがない間は0曲**（ページは「準備中」状態で、PRIVATE のデータは一切出ない）。

### 公開の手順（Producer の承認後）

1. 承認内容を `.manager/public-listening/approvals.json`（Git対象外）に書く：`{"approvedBy":"Producer","approvedAt":"YYYY-MM-DD","songs":[{"id":"manner","lyrics":true,"jacket":true,"impression":false}]}`。
2. `node public-listening/stage.mjs prepare .manager/public-listening/approvals.json` — PRIVATE の R2 から音源を**読み取り**、指紋を曲目と照合して、ローカルに公開候補（`.manager/public-listening/stage-<日時>/`）を作る。本番には書かない。
3. `node public-listening/stage.mjs verify <公開候補フォルダー>` — 模擬環境の `/listen/` で、曲数・再生・ジャケット・歌詞と、PRIVATE に届かないことを確認。
4. PRIVATE Worker をデプロイ（`/listen/` を含む版。`private\worker` で `npx wrangler deploy`）。
5. `node public-listening/stage.mjs upload <公開候補フォルダー> --approved` — 音源・ジャケットを先に、公開カタログを最後に書く（カタログを書くまで何も見えない）。書く前の公開カタログを控えとして保存する。
6. 公式サイトから案内する場合は `content/public-listening.json` を `{"enabled":true,"url":"https://pip-popper-private.pip-popper-private.workers.dev/listen/"}` にして公開（GitHub push）。

### 元に戻す

- 一般視聴だけ止める：`node public-listening/stage.mjs rollback <公開候補フォルダー> --approved`（書く前の公開カタログに戻す。最初の公開なら0曲に戻る）。
- Worker ごと戻す：`npx wrangler rollback <前のVersion ID>`（`/listen/` がなくなる。PRIVATE は従来どおり）。
- 公式サイトの案内を消す：`content/public-listening.json` を `enabled:false` に戻して公開。

### テスト

`node private/dev/test-listen.mjs`（/listen/ の表示・再生・遮断とPRIVATEの従来動作、20項目）、`node public-listening/stage.mjs prepare|verify`（架空音源での確認は一時フォルダーで行い、本番候補には残さない）。

## 現在の状態と仕様

- 公式HPトップの既存楽曲カードに「新着順（既存掲載順）」「あいうえお順」「A〜Z順」。現在の掲載内容と新着欄を変えず、カードだけを表示順に再配置する。公開日の新規推定・配信URLの登録なし。かな順は任意の公開用よみがなを使用し、なければ公開曲名。A〜Zは英字を先に、数字、かな・その他の順。実際のPRIVATE管理用読みは取得しない。
- 現行公式サイトの25曲は既に掲載されているアーカイブとして維持。新規の公式掲載は `publicArchiveApproved: true` と `publicationClass: "general" / "site"` の明示が必要。新規公開歌詞は独立した `lyricsScope: "public" / "both"` が必要。非公開・未設定を公開ソースへ混ぜない。公開済み作品の取り下げは勝手に行わず、別途Producer判断・公開工程で扱う。
- 一般視聴は `public-listening/worker.mjs` の独立Worker候補。PRIVATEとは別のストレージ、別オリジン、別データ、パスワード不要。既存PRIVATE画面のテンプレート・操作JS・音声Range処理だけを共用。PRIVATE認証やR2のバインディングは一切使用しない。一般視聴の独立URLは未設定（`content/public-listening.json`: disabled）。実際の音源は1件も公開承認・登録していない。

## データと保護

専用の非公開R2 bucket（一般視聴Workerからだけ配信）を正式統合時に新設。バインディング名は `PUBLIC_BUCKET`。公開許可済みのコピーのみを入れ、原本やPRIVATE bucketを使わない。カタログキーは `public-catalog.json`。次の架空例は形式説明のみで実ファイルではない。

```json
{
  "version": 1,
  "songs": [
    {
      "id": "example-approved",
      "title": "架空の承認曲",
      "classification": "site",
      "publicAudioApproved": true,
      "audioKey": "public-audio/example-approved.mp3",
      "size": 12345,
      "lyricsScope": "private"
    }
  ]
}
```

`size` は公開コピーの実バイト数。キーは `public-audio/<ID>.mp3`（WAVも対応、試作品で使用）の固定形式。歌詞を配信するには `lyricsScope` が `public` または `both` **かつ** `publicLyricsApproved: true` と公開許可された `lyrics` 本文が必要。ジャケットは `publicJacketApproved: true` と `public-jackets/<ID>.jpg/.png/.webp`、正しいMIMEが必要。よみがな `reading` も公開許可されたものだけ任意で記録する。PRIVATE限定・未設定・未承認・重複ID・不正形式は配信対象外。許可曲であっても公開許可のない歌詞・ジャケット・任意の管理メタデータはHTML・資産応答に含めない。カタログ自体を直接配信する経路は設けない。実カタログには公開対象外の情報を入れない。

新曲登録のAIの感想も独立した範囲：`impressionScope` が `public` または `both` かつ `publicImpressionApproved: true` の場合のみ公開視聴に本文を提供。新規公式HP登録は `impressionScope: public/both` がない感想をビルドで拒否。新曲登録の一般視聴候補は `publicAudioApproved: false`、音源キー未設定のまま非公開ローカル保存する。

管理ツールの第3段階の `.manager/release-status.json` は管理上の記録であり、公開許可や音源承認と同じではない。これを公開Workerや静的ビルドに自動投入しない。Producerが公開対象・歌詞範囲・公開ジャケットを確認してから限定された公開カタログを作る。PRIVATEのファイル・認証・曲順は不変。

## プレビューと検証

`PIP POPPER試作品プレビューを起動.bat` の案内「一般公開HP・一般視聴」からPC / スマホ幅を選択。既存公開済みの公式HP資料を別出力し、一般視聴は架空の公開許可済み3曲のみ。非公開・未設定・承認なし・歌詞非公開・画像非承認の模擬ケースを混ぜて遮断を検証。本番接続・フォーム送信なし。

- `node public-listening/test.mjs`：3切替・公開アーカイブ承認・PRIVATEバインディング未参照・公開曲だけ音声/Range・歌詞/画像許可の独立・未許可の直接要求拒否・管理API/生catalog非配信、合格。
- `PIP POPPER試作品プレビューを起動.bat --check`：公式HPの別出力生成、視聴ページ3曲・未承認音源/画像拒否・既存PRIVATE機能を一括確認、合格。
- `node private/dev/test-library.mjs`、`node manager/test-release-status.mjs`：既存鑑賞・よみがな・歌詞管理、201曲公開状況管理の回帰合格。実ブラウザ操作とGit保存は未確認。実データの視聴曲数は未承認・未登録のため0。

## Claude正式統合時の残工程

1. Producer AI Standardsの正式最新版を独立取得・照合し、PACS-10で単独担当を引継ぎ、HEAD・旧EXE差分・第1〜第3段階差分と今回差分を保護。必要な実ブラウザ・音声・管理ツールHTTP結合を検証。公開サイト生成は別出力で差分を確認。
2. Producerが一般視聴対象、公開音源・歌詞・画像、実際の公開先を明示承認したら、独立した公開用Worker・R2と `PUBLIC_BUCKET` を設計・設定する。`ASSETS` は既存の `site.css`、`private.css`、`private.js`、`stage.jpg`、favicon等の共有デザイン資材だけをコピーし、`run_worker_first` を有効にする。PRIVATE bucket、LOGIN_GUARD、認証秘密はバインドしない。公開用カタログと公開許可済みメディアを用意する（本作業では無し）。
3. 実際の一般視聴用HTTPS URLが確定しProducer承認後、`content/public-listening.json` で enabled/url を設定し、生成・実物検証。公開用Workerデプロイ、R2書込み、GitHub pushはそれぞれProducer承認後のみ。公開用URLを推測で設定しない。

今回の変更ファイル：`build.mjs`、`src/site.css`、`src/works-sort.js`、`content/public-listening.json`、`public-listening/{approval.mjs,worker.mjs,test.mjs,README.md}`、`private/worker/src/{song-order.js,pages.js,audio.js}`（共用処理）、`private/worker/public/assets/private.js`、`manager/prototype-preview.mjs`、`manager/test-manager.mjs`（検証コピーの追記）、`.gitignore`、既存管理記録。本番 `docs/` は未更新、既存未コミット成果は保護。Git commitは権限制限で保留。
