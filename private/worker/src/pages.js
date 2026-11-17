// PIP POPPER PRIVATE — page templates. Same B-3 look as the official site:
// public/assets/site.css is copied from src/site.css by `node private/tools/private.mjs assets`.
const SITE = 'https://pip-popper.github.io/';
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const no = i => String(i + 1).padStart(2, '0');
// Changes when the audio is replaced, so the new audio gets a new address (never an old copy from any cache).
const audioVersion = s => String(s.sha256 ?? s.audioUpdatedAt ?? '').slice(0, 16);
const wordmark = `<span class="wordmark"><span class="wm-pip">PIP</span><span class="wm-popper">POPPER</span></span>`;
const LOCK = `<svg class="pv-lock" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="7" width="11" height="8" rx="1" fill="currentColor"/></svg>`;

const page = (title, extraClass, body, head = '') => `<!doctype html>
<html lang="ja" class="js page-track page-private${extraClass}" data-logo="b">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Shippori+Mincho+B1:wght@500;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<link rel="stylesheet" href="/assets/private.css">${head}
</head>
<body>
<div class="world" aria-hidden="true">
  <div class="world-stage"><div class="stage-plate"></div><div class="beams"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
  <div class="world-haze"></div>
  <div class="world-veil"></div>
  <div class="world-grain"></div>
</div>
${body}
</body>
</html>
`;

export const loginPage = ({ error = '' }) => page('PIP POPPER PRIVATE', ' page-gate', `<main class="pv-gate">
  <p class="kicker">INVITATION ONLY</p>
  <h1 class="pv-title">${wordmark}<span class="pv-word">${LOCK}PRIVATE</span></h1>
  <p class="pv-lead">招待された方のための音源ライブラリです。</p>
  <form class="pv-form" method="post" action="/login">
    <div class="field">
      <label for="pw">パスワード</label>
      <input id="pw" name="password" type="password" maxlength="200" required autocomplete="current-password"${error ? ' aria-invalid="true" aria-describedby="pw-err" autofocus' : ''}>
      <p class="field-error pv-error" id="pw-err" role="alert">${esc(error)}</p>
    </div>
    <button class="send" type="submit"><span>入室する</span> <span aria-hidden="true">→</span></button>
  </form>
  <a class="back" href="${SITE}">← 公式サイトへ戻る</a>
</main>`);

export const libraryPage = ({ songs }) => page('ライブラリ｜PIP POPPER PRIVATE', ' page-library', `<header class="topbar">
  <a class="topbar-brand" href="${SITE}" aria-label="PIP POPPER 公式サイトへ">${wordmark}</a>
  <nav aria-label="PRIVATE">
    <a href="${SITE}">公式サイト</a>
    <form method="post" action="/logout"><button class="pv-logout" type="submit">退室</button></form>
  </nav>
</header>
<main class="pv-library">
  <header class="pv-head">
    <p class="section-label"><span class="label-en">${LOCK}Private Library</span><span class="label-ja">招待者専用ライブラリ</span></p>
    <p class="works-count"><span>${songs.length}</span> 曲</p>
  </header>
  ${songs.length ? `<ol class="pv-list">
    ${songs.map((s, i) => `<li class="pv-item">
      <span class="pv-jacket"><span class="jacket-fallback">${esc(s.title)}</span>${s.cover ? `<img src="${esc(s.cover)}" width="640" height="640" alt="" loading="${i < 4 ? 'eager' : 'lazy'}" decoding="async">` : ''}</span>
      <div class="pv-body">
        <p class="pv-no"><span>${no(i)}</span></p>
        <h2 class="pv-song">${esc(s.title)}</h2>
        <audio class="pv-audio" controls preload="none" src="/audio/${esc(s.id)}?v=${esc(audioVersion(s))}">お使いのブラウザでは再生できません。</audio>
        <a class="pv-dl" href="/audio/${esc(s.id)}?download=1&amp;v=${esc(audioVersion(s))}" download>MP3をダウンロード <span aria-hidden="true">↓</span></a>
      </div>
    </li>`).join('\n    ')}
  </ol>` : '<p class="pv-empty">現在、登録されている音源はありません。</p>'}
  <a class="back" href="${SITE}">← 公式サイトへ戻る</a>
</main>
<footer class="site-foot">
  <a class="foot-brand" href="${SITE}">${wordmark}</a>
  <nav aria-label="フッター"><a href="${SITE}">公式サイト</a></nav>
</footer>
<script src="/assets/private.js" defer></script>`);

export const messagePage = message => page('PIP POPPER PRIVATE', ' page-gate', `<main class="pv-gate">
  <h1 class="pv-title">${wordmark}<span class="pv-word">${LOCK}PRIVATE</span></h1>
  <p class="pv-lead">${esc(message)}</p>
  <a class="back" href="/">← PRIVATE トップへ</a>
</main>`);

// ── Administrator ───────────────────────────────────────────────────
export const adminLoginPage = ({ error = '' }) => page('管理｜PIP POPPER PRIVATE', ' page-gate', `<main class="pv-gate">
  <p class="kicker">ADMINISTRATOR</p>
  <h1 class="pv-title">${wordmark}<span class="pv-word">${LOCK}PRIVATE 管理</span></h1>
  <p class="pv-lead">PIP POPPER PRIVATE の楽曲を管理する画面です。</p>
  <form class="pv-form" method="post" action="/admin/login">
    <div class="field">
      <label for="pw">管理者パスワード</label>
      <input id="pw" name="password" type="password" maxlength="200" required autocomplete="current-password"${error ? ' aria-invalid="true" aria-describedby="pw-err" autofocus' : ''}>
      <p class="field-error pv-error" id="pw-err" role="alert">${esc(error)}</p>
    </div>
    <button class="send" type="submit"><span>管理画面に入る</span> <span aria-hidden="true">→</span></button>
  </form>
  <a class="back" href="/">← 招待者向けPRIVATEへ</a>
</main>`);

// The list is drawn by /assets/admin.js from /admin/api/catalog (titles are inserted as text, never as HTML).
export const adminPage = () => page('管理｜PIP POPPER PRIVATE', ' page-library page-admin', `<header class="topbar">
  <a class="topbar-brand" href="/admin" aria-label="PIP POPPER PRIVATE 管理">${wordmark}</a>
  <nav aria-label="管理">
    <a href="/" target="_blank" rel="noopener">招待者向け画面</a>
    <form method="post" action="/admin/logout"><button class="pv-logout" type="submit">退室</button></form>
  </nav>
</header>
<main class="pv-library ad-main">
  <header class="pv-head">
    <p class="section-label"><span class="label-en">${LOCK}Private Admin</span><span class="label-ja">楽曲の管理</span></p>
    <div class="ad-head-right">
      <p class="works-count"><span id="ad-count">–</span> 曲<small id="ad-size"></small></p>
      <button class="send ad-add" type="button" id="ad-add"><span>＋ 曲を追加</span></button>
    </div>
  </header>
  <p class="ad-status" id="ad-status" role="status" aria-live="polite"></p>
  <ol class="pv-list ad-list" id="ad-list" aria-label="登録済みの曲"></ol>
  <p class="pv-empty" id="ad-empty" hidden>まだ曲がありません。「＋ 曲を追加」から登録できます。</p>
  <section class="ad-removed" id="ad-removed" hidden aria-labelledby="ad-removed-title">
    <h2 id="ad-removed-title">外した曲<small>24時間以内なら元に戻せます。その後、音源はR2から削除されます。</small></h2>
    <ul id="ad-removed-list"></ul>
  </section>
  <p class="ad-note">この画面で変わるのは PRIVATE（R2）の内容だけです。お手元の原本やバックアップのファイルは削除・変更されません。</p>
</main>

<dialog class="ad-dialog" id="dlg-replace" aria-labelledby="dlg-replace-title">
  <form method="dialog">
    <h2 id="dlg-replace-title">音源を差し替え</h2>
    <p class="ad-dlg-song" data-slot="song"></p>
    <table class="ad-compare">
      <thead><tr><th></th><th>今の音源</th><th>新しい音源</th></tr></thead>
      <tbody>
        <tr><th>長さ</th><td data-slot="old-dur"></td><td data-slot="new-dur"></td></tr>
        <tr><th>大きさ</th><td data-slot="old-size"></td><td data-slot="new-size"></td></tr>
        <tr><th>更新</th><td data-slot="old-date"></td><td data-slot="new-name" class="ad-file"></td></tr>
      </tbody>
    </table>
    <p class="ad-label">新しい音源を試聴</p>
    <audio controls data-slot="preview"></audio>
    <p class="ad-safe">差し替えが完了するまで、招待者には今の音源がそのまま再生されます。失敗しても今の音源は残ります。</p>
    <progress data-slot="progress" max="1" value="0" hidden></progress>
    <p class="ad-msg" data-slot="msg" role="alert"></p>
    <div class="ad-buttons">
      <button type="submit" value="cancel" class="ad-cancel" data-slot="cancel">やめる</button>
      <button type="button" class="send ad-go" data-slot="go"><span>差し替える</span> <span aria-hidden="true">→</span></button>
    </div>
  </form>
</dialog>

<dialog class="ad-dialog" id="dlg-add" aria-labelledby="dlg-add-title">
  <form method="dialog">
    <h2 id="dlg-add-title">曲を追加</h2>
    <div class="field">
      <label for="add-work">曲</label>
      <select id="add-work" data-slot="work"></select>
    </div>
    <div class="field" data-slot="title-field" hidden>
      <label for="add-title">曲名</label>
      <input id="add-title" type="text" maxlength="100" data-slot="title" placeholder="公式サイトにない曲の曲名">
    </div>
    <div class="field">
      <label for="add-file">MP3ファイル</label>
      <input id="add-file" type="file" accept="audio/mpeg,.mp3" data-slot="file">
    </div>
    <p class="ad-label" data-slot="info"></p>
    <audio controls data-slot="preview" hidden></audio>
    <progress data-slot="progress" max="1" value="0" hidden></progress>
    <p class="ad-msg" data-slot="msg" role="alert"></p>
    <div class="ad-buttons">
      <button type="submit" value="cancel" class="ad-cancel" data-slot="cancel">やめる</button>
      <button type="button" class="send ad-go" data-slot="go"><span>追加する</span> <span aria-hidden="true">→</span></button>
    </div>
  </form>
</dialog>

<dialog class="ad-dialog ad-danger" id="dlg-remove" aria-labelledby="dlg-remove-title">
  <form method="dialog">
    <h2 id="dlg-remove-title">PRIVATEから外しますか？</h2>
    <div class="ad-remove-song"><span class="ad-thumb" data-slot="thumb"></span><p data-slot="song"></p></div>
    <ul class="ad-remove-notes">
      <li>招待者の一覧からすぐに消え、再生・ダウンロードできなくなります。</li>
      <li>24時間以内なら「外した曲」から元に戻せます。その後、音源はR2から削除されます。</li>
      <li>お手元の原本ファイルは削除されません。</li>
    </ul>
    <p class="ad-msg" data-slot="msg" role="alert"></p>
    <div class="ad-buttons">
      <button type="submit" value="cancel" class="ad-cancel" data-slot="cancel" autofocus>やめる</button>
      <button type="button" class="ad-remove-go" data-slot="go">PRIVATEから外す</button>
    </div>
  </form>
</dialog>
<input type="file" id="ad-replace-file" accept="audio/mpeg,.mp3" hidden>`, `
<link rel="stylesheet" href="/assets/admin.css">
<script src="/assets/admin.js" defer></script>`);
