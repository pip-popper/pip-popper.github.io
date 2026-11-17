// PIP POPPER PRIVATE — page templates. Same B-3 look as the official site:
// public/assets/site.css is copied from src/site.css by `node private/tools/private.mjs assets`.
const SITE = 'https://pip-popper.github.io/';
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const no = i => String(i + 1).padStart(2, '0');
const wordmark = `<span class="wordmark"><span class="wm-pip">PIP</span><span class="wm-popper">POPPER</span></span>`;
const LOCK = `<svg class="pv-lock" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="7" width="11" height="8" rx="1" fill="currentColor"/></svg>`;

const page = (title, extraClass, body) => `<!doctype html>
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
<link rel="stylesheet" href="/assets/private.css">
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
        <audio class="pv-audio" controls preload="none" src="/audio/${esc(s.id)}">お使いのブラウザでは再生できません。</audio>
        <a class="pv-dl" href="/audio/${esc(s.id)}?download=1" download>MP3をダウンロード <span aria-hidden="true">↓</span></a>
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
