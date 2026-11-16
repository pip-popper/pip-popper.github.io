// PIP POPPER official site generator (B-3 IMMERSIVE LIVE design).
// Reads tracks/*/track.json and writes the static site.
//   node build.mjs                 → docs/ (GitHub Pages)
//   node build.mjs --out <folder>  → any folder, for checking before publishing
// Before building, display images must exist: python tools/make-web-images.py
// Audio policy: this script never copies audio from tracks/. Only audio already published in
// docs/assets/audio/ (Manner) keeps its player. Songs are introduced; listening goes to external links.
import { readFile, readdir, writeFile, access, mkdir, stat, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const outArg = option('--out');
const out = outArg ? new URL(`file:///${(outArg.match(/^[A-Za-z]:/) ? outArg : fileURLToPath(root) + '/' + outArg).replace(/\\/g, '/')}/`) : new URL('docs/', root);
const published = new URL('docs/', root);
const exists = url => access(url).then(() => true, () => false);
const write = async (path, text) => { const u = new URL(path, out); await mkdir(new URL('./', u), { recursive: true }); await writeFile(u, text, 'utf8'); };

// ── Data ─────────────────────────────────────────────────────────────
const trackDir = new URL('tracks/', root);
const ids = (await readdir(trackDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);

// First time each track.json entered Git history = the date it was listed on the site.
function gitListedAt(id) {
  try {
    const first = execFileSync('git', ['log', '--diff-filter=A', '--reverse', '--format=%aI', '--', `tracks/${id}/track.json`],
      { cwd: fileURLToPath(root), encoding: 'utf8' }).trim().split('\n')[0];
    return first || null;
  } catch { return null; }
}

const SERVICES = {
  spotify: { label: 'Spotifyで聴く', hosts: ['open.spotify.com', 'spotify.link'] },
  suno: { label: 'Sunoで聴く', hosts: ['suno.com', 'www.suno.com', 'app.suno.ai', 'suno.ai'] },
  youtube: { label: 'YouTubeで観る', hosts: ['www.youtube.com', 'youtube.com', 'youtu.be', 'music.youtube.com'] },
  'apple-music': { label: 'Apple Musicで聴く', hosts: ['music.apple.com'] },
  other: { label: null, hosts: null }
};
const serviceOf = host => Object.entries(SERVICES).find(([, s]) => s.hosts?.includes(host))?.[0] ?? 'other';
function cleanLinks(id, list) {
  return list.map(item => {
    let url;
    try { url = new URL(item.url); } catch { throw new Error(`外部リンクのURLが無効です: ${id}`); }
    if (url.protocol !== 'https:') throw new Error(`外部リンクは https のみ登録できます: ${id}`);
    const service = item.service ?? serviceOf(url.hostname);
    const def = SERVICES[service];
    if (!def) throw new Error(`未対応の公開先です: ${id} ${service}`);
    if (def.hosts && !def.hosts.includes(url.hostname)) throw new Error(`公開先とURLが一致しません: ${id} ${service} ${url.hostname}`);
    const label = def.label ?? item.label;
    if (!label) throw new Error(`other の外部リンクには label が必要です: ${id}`);
    return { service, url: url.href, label };
  });
}

const songs = [];
for (const id of ids) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`曲IDは英小文字・数字・ハイフンのみ: ${id}`);
  const data = JSON.parse(await readFile(new URL(`${id}/track.json`, trackDir), 'utf8'));
  if (!data.title || !data.lyrics) throw new Error(`曲名または歌詞がありません: ${id}`);
  if (data.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.releaseDate)) throw new Error(`公開日の形式が無効です: ${id}`);
  for (const size of ['web', '640']) if (!await exists(new URL(`${id}/cover-${size}.jpg`, trackDir)))
    throw new Error(`表示用ジャケットがありません: tracks/${id}/cover-${size}.jpg（python tools/make-web-images.py を実行）`);
  const linkInput = [...(data.links ?? [])];
  if (data.streamingUrl) linkInput.push({ url: data.streamingUrl });
  const ext = data.audio ? data.audio.slice(data.audio.lastIndexOf('.')).toLowerCase() : null;
  const legacyAudio = ext && await exists(new URL(`assets/audio/${id}${ext}`, published)) ? `${id}${ext}` : null;
  const localAt = async () => { const t = (await stat(new URL(`${id}/track.json`, trackDir))).mtime;
    return new Date(t.getTime() - t.getTimezoneOffset() * 6e4).toISOString().slice(0, 19) + '+09:00'; };
  const gitAt = gitListedAt(id);
  const listedAt = data.releaseDate ?? data.listedAt ?? gitAt ?? await localAt();
  songs.push({ ...data, id, links: cleanLinks(id, linkInput), lyricsLabel: data.lyricsLabel ?? 'Lyrics', legacyAudio, listedAt });
}
// Newest listing first; listOrder breaks ties (higher = registered later).
songs.sort((a, b) => (b.listedAt ?? '').localeCompare(a.listedAt ?? '') || (b.listOrder ?? 0) - (a.listOrder ?? 0) || a.id.localeCompare(b.id));
const latest = songs[0];

// ── Paths (r = relative path from the current page to the site root) ──
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const trackUrl = (r, id) => `${r}tracks/${id}/index.html`;
const homeUrl = r => `${r}index.html`;
const aboutUrl = r => `${r}about/index.html`;
const coverUrl = (r, id, small) => `${r}assets/covers/${id}${small ? '-640' : ''}.jpg`;

// ── Titles: break only between phrases, never inside a word ─────────
const PARTICLES = new Set(['の', 'に', 'を', 'は', 'が', 'と', 'で', 'も', 'へ', 'や', 'から', 'まで', 'より']);
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
const charEm = c => /[　-鿿＀-￯]/.test(c) ? 1 : /[A-Z]/.test(c) ? .74 : /[a-z]/.test(c) ? .56 : /[0-9]/.test(c) ? .6 : /[-‐]/.test(c) ? .42 : .5;
function titleParts(title) {
  const segs = [...segmenter.segment(title)].map(x => x.segment);
  const chunks = []; let cur = '';
  const close = () => { if (cur) chunks.push(cur); cur = ''; };
  segs.forEach((seg, i) => {
    const next = segs[i + 1] ?? '';
    if (/^\s+$/.test(seg)) { close(); chunks.push(' '); return; }
    cur += seg;
    const punct = /^[、。！？!?・…]+$/.test(seg) && !/^[、。！？!?・…]+$/.test(next);
    const hyphenAfterWord = seg === '-' && /[A-Za-z]$/.test(cur.slice(0, -1));
    if (PARTICLES.has(seg) || punct || hyphenAfterWord) close();
  });
  close();
  const fit = Math.max(...chunks.filter(c => c !== ' ').map(w => [...w].reduce((n, c) => n + charEm(c) + .02, 0)));
  return { html: chunks.map(c => c === ' ' ? ' ' : `<span class="tw">${esc(c)}</span>`).join('<wbr>'), fit: fit.toFixed(2) };
}
const titleTag = (tag, title, attrs = '') => { const t = titleParts(title); return `<${tag}${attrs} style="--fit:${t.fit}">${t.html}</${tag}>`; };
const no = i => String(i + 1).padStart(2, '0');

// ── Shared parts ─────────────────────────────────────────────────────
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Shippori+Mincho+B1:wght@500;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">`;
const DESCRIPTION = 'PIP POPPER 公式サイト。楽曲と歌詞、作品紹介を掲載しています。';
const wordmark = (tag, attrs = '') => `<${tag} class="wordmark"${attrs}><span class="wm-pip">PIP</span><span class="wm-popper">POPPER</span></${tag}>`;
const head = (r, title, extraClass = '') => `<!doctype html>
<html lang="ja" class="no-js${extraClass}" data-logo="b">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${esc(DESCRIPTION)}">
${FONTS}
<link rel="stylesheet" href="${r}assets/site.css">
<script>document.documentElement.classList.replace('no-js', 'js');</script>
</head>
<body>`;
const world = glows => `<div class="world" aria-hidden="true">
  <div class="world-stage"><div class="stage-plate"></div><div class="beams"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
  <div class="world-haze"></div>
  <div class="world-veil"></div>
  <div class="world-ambient">${glows}</div>
  <div class="world-grain"></div>
</div>`;
// On the top page (r === '') section links stay in-page; elsewhere they go to the top page.
const sec = (r, hash) => r === null ? `#${hash}` : `${homeUrl(r)}#${hash}`;
const topbar = (r, onHome) => `<header class="topbar">
  <a class="topbar-brand" href="${onHome ? '#top' : homeUrl(r)}" aria-label="PIP POPPER トップ">${wordmark('span')}</a>
  <nav aria-label="サイト内">
    <a class="nav-latest" href="${onHome ? '#latest' : sec(r, 'latest')}">最新楽曲</a>
    <a href="${onHome ? '#works' : sec(r, 'works')}">楽曲一覧</a>
    <a href="${aboutUrl(r)}">アーティスト紹介</a>
    <a href="${onHome ? '#message' : sec(r, 'message')}">メッセージ</a>
  </nav>
</header>`;
const footer = (r, onHome) => `<footer class="site-foot">
  <a class="foot-brand" href="${onHome ? '#top' : homeUrl(r)}">${wordmark('span')}</a>
  <nav aria-label="フッター">
    <a href="${onHome ? '#works' : sec(r, 'works')}">楽曲一覧</a>
    <a href="${aboutUrl(r)}">アーティスト紹介</a>
    <a href="${onHome ? '#message' : sec(r, 'message')}">メッセージ</a>
  </nav>
</footer>`;
const sharedScript = `<script>
(() => {
  const root = document.documentElement;
  const opening = document.querySelector('.opening');
  const lit = [...document.querySelectorAll('[data-light]')];
  const glows = [...document.querySelectorAll('.glow')];
  const pending = new Set(document.querySelectorAll('.reveal'));
  let active = null, queued = false;
  function update() {
    queued = false;
    const vh = innerHeight, y = scrollY;
    if (opening) {
      const travel = Math.max(1, opening.offsetHeight - vh);
      root.style.setProperty('--open', Math.min(1, Math.max(0, y / travel)).toFixed(4));
      root.style.setProperty('--after', Math.min(1, Math.max(0, (y - travel) / vh)).toFixed(4));
    }
    let next = glows.length === 1 ? glows[0].dataset.key : '';
    for (const el of lit) { const b = el.getBoundingClientRect(); if (b.top < vh * .65 && b.bottom > vh * .35) next = el.dataset.light; }
    if (next !== active) { active = next; for (const g of glows) g.classList.toggle('on', g.dataset.key === active); }
    for (const el of pending) if (el.getBoundingClientRect().top < vh * .92) { el.classList.add('is-in'); pending.delete(el); }
  }
  const request = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  addEventListener('scroll', request, { passive: true });
  addEventListener('resize', request);
  update();
})();
</script>`;
const jacket = (r, song, { eager = false, small = false, alt = '' } = {}) => `<span class="jacket-fallback">${esc(song.title)}</span>
        <img src="${coverUrl(r, song.id, small)}" width="${small ? 640 : 1254}" height="${small ? 640 : 1254}" alt="${esc(alt)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" onerror="this.style.display='none'">`;

// ── Message form (Formspree) ─────────────────────────────────────────
// Only the form ID appears in the page; the receiving address is set in the Formspree dashboard
// and is never written here. Spam is filtered by Formspree (no hidden trap field: browser auto-fill
// could trip it and lose a real message).
const MESSAGE = {
  formId: 'xyewevlq',       // Formspree form "PIP POPPER Message" (Producer registered 2026-11-17)
  subject: 'PIP POPPER公式サイトにメッセージが届きました',
};
if (!/^[A-Za-z0-9]{6,12}$/.test(MESSAGE.formId)) throw new Error('Formspree form ID looks wrong');
const messageSection = `<section class="message" id="message" aria-labelledby="message-title">
    <header class="message-head reveal">
      <p class="section-label"><span class="label-en">Message</span><span class="label-ja" id="message-title"><span class="tw">PIP POPPERに</span><wbr><span class="tw">メッセージ</span></span></p>
      <p class="message-lead">曲の感想、サイトの感想、ちょっとした一言など、何でもお気軽にどうぞ。<br>いただいたメッセージは本人が読みます。サイト上には公開されません。</p>
    </header>
    <form class="message-form reveal" id="message-form" novalidate data-endpoint="https://formspree.io/f/${MESSAGE.formId}">
      <div class="field">
        <label for="m-name">お名前・ニックネーム<span class="opt">任意</span></label>
        <input id="m-name" name="name" type="text" maxlength="50" autocomplete="nickname" placeholder="匿名や、知り合いの方はヒントだけでもOK">
      </div>
      <div class="field">
        <label for="m-body">メッセージ<span class="req">必須</span></label>
        <textarea id="m-body" name="message" rows="7" maxlength="3000" required aria-describedby="m-body-err m-body-count" placeholder="ご自由にどうぞ"></textarea>
        <div class="field-foot"><p class="field-error" id="m-body-err" aria-live="polite"></p><p class="count" id="m-body-count">0 / 3000</p></div>
      </div>
      <div class="field">
        <label for="m-mail">返信先メールアドレス<span class="opt">任意</span></label>
        <input id="m-mail" name="email" type="email" maxlength="254" autocomplete="email" inputmode="email" aria-describedby="m-mail-err" placeholder="返信を希望される方のみ">
        <p class="field-error" id="m-mail-err" aria-live="polite"></p>
      </div>
      <div class="message-actions">
        <button class="send" type="submit"><span class="send-label">送信する</span> <span aria-hidden="true">→</span></button>
        <p class="message-status" id="message-status" role="status" aria-live="polite"></p>
      </div>
      <p class="message-note">ご感想、ご意見、応援、苦情、何でも歓迎。<br>悪口を書くなら、徹底的にお願いします（笑）。</p>
    </form>
  </section>`;
const messageScript = `<script>
(() => {
  const form = document.getElementById('message-form');
  if (!form) return;
  const body = form.elements.message, mail = form.elements.email, name = form.elements.name;
  const status = document.getElementById('message-status');
  const button = form.querySelector('.send'), label = form.querySelector('.send-label');
  const count = document.getElementById('m-body-count');
  const started = Date.now();
  let sending = false, justSent = false;
  const EMAIL = /^[^\\s@]+@[^\\s@.]+(\\.[^\\s@.]+)+$/;
  const setError = (input, id, text) => { document.getElementById(id).textContent = text; input.setAttribute('aria-invalid', text ? 'true' : 'false'); };
  const show = (kind, text) => { status.className = 'message-status is-' + kind; status.textContent = text; };
  form.addEventListener('input', () => { justSent = false; });
  body.addEventListener('input', () => { count.textContent = body.value.length + ' / 3000'; if (body.value.trim()) setError(body, 'm-body-err', ''); });
  mail.addEventListener('input', () => { if (!mail.value.trim() || EMAIL.test(mail.value.trim())) setError(mail, 'm-mail-err', ''); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    const text = body.value.trim(), address = mail.value.trim(), who = name.value.trim();
    if (justSent && !text && !address && !who) return;
    let ok = true;
    if (!text) { setError(body, 'm-body-err', 'メッセージを入力してください。'); ok = false; }
    if (address && !EMAIL.test(address)) { setError(mail, 'm-mail-err', 'メールアドレスの形式を確認してください（例：name@example.com）。'); ok = false; }
    if (!ok) { show('error', '入力内容を確認してください。'); (text ? mail : body).focus(); return; }
    const wait = 2500 - (Date.now() - started);
    sending = true; button.disabled = true; label.textContent = '送信中…'; show('busy', '送信しています…');
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const payload = { subject: ${JSON.stringify(MESSAGE.subject)},
      'お名前・ニックネーム': who || '（未記入）', 'メッセージ': text, '返信先': address || '返信先なし' };
    if (address) payload.email = address;      // Formspree uses the 'email' field as the Reply-To
    try {
      const res = await fetch(form.dataset.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
      const json = await res.json().catch(() => ({}));
      const detail = Array.isArray(json.errors) ? json.errors.map(e => e.message).filter(Boolean).join(' / ') : (json.error || '');
      if (!res.ok || json.errors) throw Object.assign(new Error('send failed'), { detail: detail || 'HTTP ' + res.status });
      form.reset(); count.textContent = '0 / 3000'; justSent = true;
      show('done', 'メッセージを送信しました。ありがとうございます。' + (address ? '返信は入力いただいたアドレスにお送りします。' : ''));
    } catch (error) {
      show('error', '送信できませんでした。時間をおいてもう一度お試しください。入力内容はそのまま残っています。' + (error.detail ? '（詳細：' + error.detail + '）' : ''));
    } finally {
      sending = false; button.disabled = false; label.textContent = '送信する';
    }
  });
})();
</script>`;

// ── Lyrics: stored text shown as-is; wraps only at the lyric's own spaces/punctuation ──
const lyricsHtml = text => text.trim().split(/\n\s*\n/).map(stanza => `<div class="ly-stanza">${stanza.split('\n').map(line => {
  const parts = line.replace(/\s+$/, '').split(/([ 　]+)/);
  const chunks = p => p.match(/[^！？!?…、。～]*[！？!?…、。～]+|[^！？!?…、。～]+/g).map(c => `<span class="ly-ph">${esc(c)}</span>`).join('<wbr>');
  return `<span class="ly-line">${parts.map(p => /^[ 　]+$/.test(p) ? `<span class="ly-gap">${p}</span>` : p ? chunks(p) : '').join('')}</span>`;
}).join('')}</div>`).join('');

const listen = (r, song) => {
  const links = song.links.map(l => `<a class="listen-link" data-service="${l.service}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} <span aria-hidden="true">↗</span></a>`).join('');
  const audio = song.legacyAudio ? `<audio class="listen-audio" controls preload="metadata" src="${r}assets/audio/${esc(song.legacyAudio)}">お使いのブラウザでは再生できません。</audio>` : '';
  return links || audio ? `<div class="listen">${links}${audio}</div>` : '';
};

// ── Top page ─────────────────────────────────────────────────────────
{
  const r = '';
  const cards = songs.map((s, i) => `<li class="work reveal" style="--i:${i}">
      <a class="work-link" href="${trackUrl(r, s.id)}">
        <span class="work-jacket">${jacket(r, s, { eager: i < 4, small: true })}</span>
        <span class="work-meta"><span class="work-no">${no(i)}</span>${s === latest ? '<span class="work-new">LATEST</span>' : ''}</span>
        <span class="work-title" style="--fit:${titleParts(s.title).fit}">${titleParts(s.title).html}</span>
        ${s.aiImpression ? `<span class="work-note">${esc(s.aiImpression)}</span>` : ''}
      </a>
    </li>`).join('\n    ');
  await write('index.html', `${head(r, 'PIP POPPER｜OFFICIAL MUSIC SITE', ' page-home')}
<a class="skip" href="#latest">最新楽曲へ移動</a>
${world(`<div class="glow" data-key="${latest.id}" style="--cover:url('${coverUrl(r, latest.id, true)}')"></div>`)}
<p class="rail" aria-hidden="true"><span>PIP POPPER</span><span>OFFICIAL MUSIC SITE</span></p>
${topbar(r, true)}
<main>
  <section class="opening" id="top" aria-labelledby="site-title">
    <div class="opening-pin">
      <div class="opening-title">
        <p class="kicker">OFFICIAL MUSIC SITE</p>
        ${wordmark('h1', ' id="site-title"')}
      </div>
      <div class="crowd" aria-hidden="true"></div>
      <a class="cue" href="#latest"><span>SCROLL</span><i aria-hidden="true"></i></a>
    </div>
  </section>

  <section class="statement" aria-label="PIP POPPERについて">
    <p class="reveal"><span>選んだ一曲を、いまの音で。</span><span>歌詞と物語ごと、届ける。</span></p>
  </section>

  <section class="latest" id="latest" data-light="${latest.id}" aria-labelledby="latest-title">
    <p class="section-label reveal"><span class="label-en">Latest Release</span><span class="label-ja">最新楽曲</span></p>
    <div class="latest-body">
      <a class="latest-jacket reveal" href="${trackUrl(r, latest.id)}" tabindex="-1" aria-hidden="true">${jacket(r, latest, { eager: true })}</a>
      <div class="latest-info reveal">
        <h2 id="latest-title" style="--fit:${titleParts(latest.title).fit}"><a href="${trackUrl(r, latest.id)}">${titleParts(latest.title).html}</a></h2>
        ${latest.artist ? `<p class="latest-artist">${esc(latest.artist)}</p>` : ''}
        ${latest.aiImpression ? `<p class="latest-note"><span class="note-label">AIの感想</span>${esc(latest.aiImpression)}</p>` : ''}
        <a class="more" href="${trackUrl(r, latest.id)}">作品ページへ <span aria-hidden="true">→</span></a>
      </div>
    </div>
  </section>

  <section class="works" id="works" aria-labelledby="works-title">
    <header class="works-head reveal">
      <p class="section-label"><span class="label-en">Works</span><span class="label-ja" id="works-title">楽曲一覧</span></p>
      <p class="works-count"><span>${songs.length}</span> 曲を掲載中</p>
    </header>
    <ol class="work-grid">
    ${cards}
    </ol>
  </section>
  ${messageSection}
</main>
${footer(r, true)}
${sharedScript}
${messageScript}
</body>
</html>
`);
}

// ── Track pages: tracks/<id>/index.html ──────────────────────────────
for (const [i, s] of songs.entries()) {
  const r = '../../';
  const step = (other, label) => other ? `<a href="${trackUrl(r, other.id)}"><small>${label}</small><span>${esc(other.title)}</span></a>` : '<span></span>';
  await write(`tracks/${s.id}/index.html`, `${head(r, `${esc(s.title)}｜PIP POPPER`, ' page-track')}
<a class="skip" href="#text">${esc(s.lyricsLabel)}へ移動</a>
${world(`<div class="glow on" data-key="${s.id}" style="--cover:url('${coverUrl(r, s.id, true)}')"></div>`)}
${topbar(r, false)}
<main class="track">
  <a class="back" href="${sec(r, 'works')}">← 楽曲一覧</a>
  <section class="track-hero" aria-labelledby="track-title">
    <div class="track-jacket">${jacket(r, s, { eager: true, alt: `${s.title}のジャケット` })}</div>
    <div class="track-head">
      <p class="track-no"><span>${no(i)}</span>${s === latest ? ' LATEST' : ''}</p>
      ${titleTag('h1', s.title, ' id="track-title"')}
      ${s.artist ? `<p class="track-artist">${esc(s.artist)}</p>` : ''}
      ${listen(r, s)}
    </div>
  </section>
  ${s.aiImpression ? `<section class="block impression reveal" aria-labelledby="ai-title">
    <h2 class="block-head" id="ai-title"><span class="label-en">AI Impression</span><span class="label-ja">AIの感想</span></h2>
    <p class="impression-text">${esc(s.aiImpression)}</p>
  </section>` : ''}
  ${s.background ? `<section class="block story reveal" aria-labelledby="story-title">
    <h2 class="block-head" id="story-title"><span class="label-en">Background</span><span class="label-ja">制作背景</span></h2>
    <p class="story-text">${esc(s.background)}</p>
  </section>` : ''}
  <section class="block text reveal" id="text" aria-labelledby="text-title">
    <h2 class="block-head" id="text-title"><span class="label-en">${esc(s.lyricsLabel)}</span></h2>
    <div class="lyrics-text" lang="ja">${lyricsHtml(s.lyrics)}</div>
  </section>
  <nav class="steps" aria-label="ほかの楽曲">${step(songs[i - 1], '← 新しい曲')}${step(songs[i + 1], '前の曲 →')}</nav>
</main>
${footer(r, false)}
${sharedScript}
</body>
</html>
`);
}

// ── Old works URL (tracks/index.html) → the works list on the top page ──
await write('tracks/index.html', `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>楽曲一覧｜PIP POPPER</title>
<meta http-equiv="refresh" content="0; url=../index.html#works">
<link rel="canonical" href="../index.html#works">
<style>body{margin:0;background:#060708;color:#f4f0ea;font:16px/1.8 "Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;display:grid;place-items:center;min-height:100vh}a{color:inherit}</style>
</head>
<body><p>楽曲一覧はトップページに移りました。<a href="../index.html#works">楽曲一覧へ</a></p></body>
</html>
`);

// ── About page: about/index.html ─────────────────────────────────────
// Producer-approved text (unchanged from the previous site).
const ABOUT = [
  '日々の経験や社会への疑問、皮肉やユーモアを、歌詞と音楽にしています。',
  '作品の原点は、本人が書いた歌詞と楽曲です。過去に作った曲も、AIなど現代の制作手段を使いながら再制作しています。',
  'このサイトは、自分の頭から生まれた作品を、できるだけ長く世の中に残すための公式アーカイブです。',
];
{
  const r = '../';
  await write('about/index.html', `${head(r, 'アーティスト紹介｜PIP POPPER', ' page-track page-about')}
<a class="skip" href="#about">本文へ移動</a>
${world('')}
${topbar(r, false)}
<main class="about-page" id="about">
  <section class="about-hero" aria-labelledby="about-title">
    <p class="section-label reveal"><span class="label-en">About</span><span class="label-ja" id="about-title">アーティスト紹介</span></p>
    <p class="about-mark reveal" aria-hidden="true">${wordmark('span')}</p>
  </section>
  <section class="about-body reveal" aria-label="PIP POPPERについて">
    ${ABOUT.map((t, i) => `<p class="${i === 0 ? 'about-lead' : 'about-text'}">${esc(t)}</p>`).join('\n    ')}
    <div class="about-actions">
      <a class="more" href="${sec(r, 'works')}">楽曲一覧を見る <span aria-hidden="true">→</span></a>
      <a class="more" href="${sec(r, 'message')}">メッセージを送る <span aria-hidden="true">→</span></a>
    </div>
  </section>
</main>
${footer(r, false)}
${sharedScript}
</body>
</html>
`);
}

// ── Assets ───────────────────────────────────────────────────────────
await mkdir(new URL('assets/covers/', out), { recursive: true });
await copyFile(new URL('src/site.css', root), new URL('assets/site.css', out));
await copyFile(new URL('src/stage.jpg', root), new URL('assets/stage.jpg', out));
for (const s of songs) {
  await copyFile(new URL(`${s.id}/cover-web.jpg`, trackDir), new URL(`assets/covers/${s.id}.jpg`, out));
  await copyFile(new URL(`${s.id}/cover-640.jpg`, trackDir), new URL(`assets/covers/${s.id}-640.jpg`, out));
  if (s.legacyAudio && out.href !== published.href) {   // checking build: reuse the already-published file
    await mkdir(new URL('assets/audio/', out), { recursive: true });
    await copyFile(new URL(`assets/audio/${s.legacyAudio}`, published), new URL(`assets/audio/${s.legacyAudio}`, out));
  }
}
if (!await exists(new URL('.nojekyll', out))) await writeFile(new URL('.nojekyll', out), '');
console.log(`Built ${songs.length} songs into ${fileURLToPath(out)} — latest: ${latest.title}; audio kept: ${songs.filter(s => s.legacyAudio).map(s => s.id).join(', ') || 'none'}`);
