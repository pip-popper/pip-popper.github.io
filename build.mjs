// PIP POPPER official site generator (B-3 IMMERSIVE LIVE design).
// Reads tracks/*/track.json and writes the static site.
//   node build.mjs                 → docs/ (GitHub Pages)
//   node build.mjs --out <folder>  → any folder, for checking before publishing
// Before building, display images must exist: python tools/make-web-images.py
// Audio policy: the official site never holds or plays audio (GitHub Pages is public). Songs are introduced;
// listening goes to external links or to PIP POPPER PRIVATE (private Cloudflare R2). track.json "audio" must be null.
import { readFile, readdir, writeFile, access, mkdir, stat, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sortedSongs } from './private/worker/src/song-order.js';
import { assertArchiveApproval } from './public-listening/approval.mjs';
import { displayText } from './private/worker/src/display-text.js';

const root = new URL('./', import.meta.url);
const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const outArg = option('--out');
const out = outArg ? new URL(`file:///${(outArg.match(/^[A-Za-z]:/) ? outArg : fileURLToPath(root) + '/' + outArg).replace(/\\/g, '/')}/`) : new URL('docs/', root);
const published = new URL('docs/', root);
const listeningConfig = JSON.parse(await readFile(new URL('content/public-listening.json',root),'utf8'));
const listeningUrl = option('--public-listening-url') ?? (listeningConfig.enabled===true?listeningConfig.url:null);
if (listeningConfig.enabled===true && !listeningUrl) throw new Error('一般視聴の承認済みURLを設定してください。');
if (listeningUrl && !(outArg && listeningUrl === '/listen/')) {
  const target = new URL(listeningUrl);
  // the listening page lives at /listen/ of the PRIVATE Worker (no password there); any other path on that host is refused
  const privateHost = target.hostname === 'pip-popper-private.pip-popper-private.workers.dev';
  if (target.protocol !== 'https:' || target.username || target.password || (privateHost && target.pathname !== '/listen/')) throw new Error('一般視聴には承認済みのHTTPS URL（PRIVATE Worker の /listen/）を指定してください。');
}
const exists = url => access(url).then(() => true, () => false);
const write = async (path, text) => { const u = new URL(path, out); await mkdir(new URL('./', u), { recursive: true }); await writeFile(u, text, 'utf8'); };

// ── Data ─────────────────────────────────────────────────────────────
const trackDir = new URL('tracks/', root);
const ids = (await readdir(trackDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);

// First time each track.json entered Git history = the date it was listed on the site.
function gitListedAt(id) {
  try {
    const first = execFileSync('git', ['-c', `safe.directory=${fileURLToPath(root).replace(/\\/g, '/').replace(/\/$/, '')}`, 'log', '--diff-filter=A', '--reverse', '--format=%aI', '--', `tracks/${id}/track.json`],
      { cwd: fileURLToPath(root), windowsHide: true, encoding: 'utf8' }).trim().split('\n')[0];
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
const hiddenSongs = new Set();
// Existing archive entries are already public; new entries need explicit approval.
// The private manager records and R2 catalog are never read by this builder.
const priorArchive = new Set(JSON.parse(await readFile(new URL('works.json', published),'utf8')).map(s=>s.id));
// a song that was published before and then 掲載停止 is not in works.json any more: Git's history of its page says it was public
const wasPublished = id => { try { return !!execFileSync('git', ['-c', `safe.directory=${fileURLToPath(root).replace(/\\/g, '/').replace(/\/$/, '')}`, 'log', '-1', '--format=%H', '--', `docs/tracks/${id}/index.html`], { cwd: fileURLToPath(root), windowsHide: true, encoding: 'utf8' }).trim(); } catch { return false; } };
for (const id of ids) if (!priorArchive.has(id) && wasPublished(id)) priorArchive.add(id);
for (const id of ids) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`曲IDは英小文字・数字・ハイフンのみ: ${id}`);
  const data = JSON.parse(await readFile(new URL(`${id}/track.json`, trackDir), 'utf8'));
  // "hidden": true = 掲載停止 (set from the manager). The data stays; the page is not published (and removed below).
  if (data.hidden === true) { hiddenSongs.add(id); continue; }
  assertArchiveApproval(id,data,priorArchive);
  if (!data.title) throw new Error(`曲名がありません: ${id}`);
  if (data.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.releaseDate)) throw new Error(`公開日の形式が無効です: ${id}`);
  for (const size of ['web', '640']) if (!await exists(new URL(`${id}/cover-${size}.jpg`, trackDir)))
    throw new Error(`表示用ジャケットがありません: tracks/${id}/cover-${size}.jpg（python tools/make-web-images.py を実行）`);
  const linkInput = [...(data.links ?? [])];
  if (data.streamingUrl) linkInput.push({ url: data.streamingUrl });
  if (data.audio) throw new Error(`公式サイトには音源を置きません（track.json の audio は null にする）: ${id}`);
  // audioRelease: 'public' (default) = player/links as before; 'private' = no player or links, shows the private note.
  const audioRelease = data.audioRelease ?? 'public';
  if (!['public', 'private'].includes(audioRelease)) throw new Error(`audioRelease は public または private: ${id}`);
  if (audioRelease === 'private' && (data.audio || linkInput.length)) throw new Error(`音源非公開の曲に音源・配信リンクが登録されています: ${id}`);
  const localAt = async () => { const t = (await stat(new URL(`${id}/track.json`, trackDir))).mtime;
    return new Date(t.getTime() - t.getTimezoneOffset() * 6e4).toISOString().slice(0, 19) + '+09:00'; };
  const gitAt = gitListedAt(id);
  const listedAt = data.releaseDate ?? data.listedAt ?? gitAt ?? await localAt();
  // aiImpression: shown without ChatGPT's Markdown marks (track.json keeps the original)
  songs.push({ ...data, aiImpression: displayText(data.aiImpression), id, links: cleanLinks(id, linkInput), lyricsLabel: data.lyricsLabel ?? 'Lyrics', listedAt, audioPrivate: audioRelease === 'private' });
}
// Newest listing first; listOrder breaks ties (higher = registered later).
songs.sort((a, b) => (b.listedAt ?? '').localeCompare(a.listedAt ?? '') || (b.listOrder ?? 0) - (a.listOrder ?? 0) || a.id.localeCompare(b.id));
const latest = songs[0];

// ── HISTORY: albums/albums.json + albums/<id>/ images (python tools/make-album-images.py) ──
// Main visual = visual-web.jpg (the Producer-adopted AI jacket) when present; otherwise the chapter's
// typographic scene. The old CD front is only a small ORIGINAL ARCHIVE item (cover-240.jpg, archive: true).
const albumDir = new URL('albums/', root);
const { albums: allAlbums } = JSON.parse(await readFile(new URL('albums.json', albumDir), 'utf8'));
// "hidden": true = 掲載停止 for an album (set from the manager); its data and images stay in albums/.
const hiddenAlbums = allAlbums.filter(a => a.hidden === true).map(a => a.id);
const albums = allAlbums.filter(a => a.hidden !== true);
// JPEG pixel size (SOF marker), so every <img> carries width/height and the page never jumps.
async function jpegSize(url) {
  const b = await readFile(url);
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error(`JPEGの大きさを読めません: ${fileURLToPath(url)}`);
}
// Site texts edited from the manager (content/site.json): short copy that is not part of a song or an album.
const SITE = JSON.parse(await readFile(new URL('content/site.json', root), 'utf8'));
for (const [k, v] of Object.entries({ 'home.statement': SITE.home?.statement, 'home.historyLead': SITE.home?.historyLead, 'history.lead': SITE.history?.lead, 'history.description': SITE.history?.description, 'otherWorks.lead': SITE.otherWorks?.lead, 'otherWorks.description': SITE.otherWorks?.description, 'about.text': SITE.about?.text,
  'history.title': SITE.history?.title, 'history.endText': SITE.history?.endText, 'otherWorks.title': SITE.otherWorks?.title, 'otherWorks.endText': SITE.otherWorks?.endText,
  'message.lead': SITE.message?.lead, 'track.privateCondLabel': SITE.track?.privateCondLabel, 'track.privateCond': SITE.track?.privateCond }))
  if (!(Array.isArray(v) ? v.length && v.every(t => typeof t === 'string' && t.trim()) : typeof v === 'string' && v.trim())) throw new Error(`サイトの文言がありません: content/site.json の ${k}`);
const songById = new Map(songs.map(s => [s.id, s]));
const originOf = new Map();          // song id → album (only confirmed same songs)
for (const a of albums) {
  if (!/^[a-z0-9-]+$/.test(a.id)) throw new Error(`アルバムIDは英小文字・数字・ハイフンのみ: ${a.id}`);
  if (a.discs) a.tracks = a.discs.flatMap(d => d.tracks);
  if (!a.title || !(a.tracks?.length || a.works?.every(w => w.title && w.tracks?.length))) throw new Error(`アルバムの曲名・収録曲がありません: ${a.id}`);
  const visual = new URL(`${a.id}/visual-web.jpg`, albumDir);
  a.visualSize = await exists(visual) ? await jpegSize(visual) : null;
  if (a.visualSize && !await exists(new URL(`${a.id}/visual-640.jpg`, albumDir))) throw new Error(`visual-640.jpg がありません: albums/${a.id}（python tools/make-album-images.py を実行）`);
  a.visualWide = !!a.visualSize && a.visualSize.w / a.visualSize.h > 1.8;   // a logo banner rather than a jacket
  a.ownBackdrop = await exists(new URL(`${a.id}/backdrop-web.jpg`, albumDir));
  const titleImage = new URL(`${a.id}/title-web.png`, albumDir);   // optional: the adopted design's title lettering (transparent PNG)
  a.titleImageSize = a.visualSize && await exists(titleImage) ? (b => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) }))(await readFile(titleImage)) : null;
  // optional: small supporting pictures cut from the adopted design (albums/<id>/strip-N.jpg)
  a.stripSizes = a.strip ? await Promise.all(a.strip.map(async (_, n) => {
    const u = new URL(`${a.id}/strip-${n + 1}.jpg`, albumDir);
    if (!await exists(u)) throw new Error(`補助ビジュアルがありません: albums/${a.id}/strip-${n + 1}.jpg`);
    return jpegSize(u);
  })) : [];
  // joint chapter: each work's jacket cut from the adopted design (albums/<id>/jacket-N.jpg)
  a.workSizes = a.works ? await Promise.all(a.works.map(async (_, n) => {
    const u = new URL(`${a.id}/jacket-${n + 1}.jpg`, albumDir);
    if (!await exists(u)) throw new Error(`作品ジャケットがありません: albums/${a.id}/jacket-${n + 1}.jpg`);
    return jpegSize(u);
  })) : [];
  if (a.archive) {
    const u = new URL(`${a.id}/cover-240.jpg`, albumDir);
    if (!await exists(u)) throw new Error(`資料用の旧ジャケットがありません: albums/${a.id}/cover-240.jpg（python tools/make-album-images.py を実行）`);
    a.archiveSize = await jpegSize(u);
  }
  if (a.backdrop && !await exists(new URL(`${a.backdrop}/visual-web.jpg`, albumDir))) throw new Error(`背景に使うアルバムの採用ジャケットがありません: ${a.id} → ${a.backdrop}`);
  for (const t of a.tracks ?? []) if (t.music) {
    if (hiddenSongs.has(t.music)) { delete t.music; continue; }   // the song is 掲載停止: show the title without a link
    if (!songById.has(t.music)) throw new Error(`HISTORYのMUSICリンク先がありません: ${a.id} → ${t.music}`);
    originOf.set(t.music, a);
  }
}
// HISTORY = PIP POPPER's own albums in order; OTHER WORKS = members' solo and individually made works
// (albums.json "section": "other"). Same adopted chapter designs, shown on their own page.
const historyAlbums = albums.filter(a => a.section !== 'other');
const otherAlbums = albums.filter(a => a.section === 'other');

// ── Paths (r = relative path from the current page to the site root) ──
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const trackUrl = (r, id) => `${r}tracks/${id}/index.html`;
const homeUrl = r => `${r}index.html`;
const aboutUrl = r => `${r}about/index.html`;
const historyUrl = (r, id) => `${r}history/index.html${id ? `#${id}` : ''}`;
const otherUrl = (r, id) => `${r}other-works/index.html${id ? `#${id}` : ''}`;
const albumPageUrl = (r, a) => a.section === 'other' ? otherUrl(r, a.id) : historyUrl(r, a.id);
const albumVisual = (r, id, small) => `${r}assets/history/${id}-visual${small ? '-640' : ''}.jpg`;
const albumArchive = (r, id) => `${r}assets/history/${id}-archive.jpg`;
// Album ambient light: its AI jacket when adopted, otherwise a soft wash of the album's accent colour.
const albumGlow = (r, a) => a.visualSize ? glowStyle(albumVisual(r, a.id, true))
  : `background:radial-gradient(60% 55% at 50% 38%, ${a.accent}, transparent 70%) center / cover no-repeat`;
// Small tile used on the top page: the AI jacket, or a typographic stand-in in the album's theme.
const albumTile = (r, a) => a.visualSize
  ? `<span class="ht-jacket${a.visualWide ? ' is-wide' : ''}"><img src="${albumVisual(r, a.id, true)}" width="640" height="640" alt="" loading="lazy" decoding="async"></span>`
  : `<span class="ht-jacket ht-type theme-${a.id}" aria-hidden="true"><span class="ht-type-year">${esc(a.year)}</span><span class="ht-type-title">${esc(a.title)}</span></span>`;
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
// ── Search engines ───────────────────────────────────────────────────
// SITE_URL: the official address. Canonical URLs, sitemap.xml and robots.txt are built from it.
// GOOGLE_SITE_VERIFICATION: paste ONLY the code Google Search Console gives the Producer
// (the content="..." value of its HTML tag). Empty = no tag is written.
const SITE_URL = 'https://pip-popper.github.io/';
const GOOGLE_SITE_VERIFICATION = 'mCrw0muFFFCwTcnqTDQPt0duAOfiu-IDxaP29p08WeU';
const NAME_KANA = 'ピップポッパー';
// PIP POPPER PRIVATE entrance (header, right end). Empty = no link, so the site stays exactly as it is.
// After the Worker is deployed and the Producer approves, set its address here (e.g. 'https://pip-popper-private.＜name＞.workers.dev/').
// --private-url <address> shows it in a checking build only.
const PRIVATE_URL = option('--private-url') ?? 'https://pip-popper-private.pip-popper-private.workers.dev/';
const pageUrl = path => new URL(path, SITE_URL).href;          // path: '', 'about/', 'tracks/<id>/'
const firstSentence = text => (String(text ?? '').match(/^[^。]*。/) ?? [''])[0];
const DESCRIPTION = `PIP POPPER（${NAME_KANA}）の公式サイト。全${songs.length}作品の歌詞、ジャケット、作品紹介を掲載しています。`;
const trackDescription = s => `PIP POPPER（${NAME_KANA}）の楽曲「${s.title}」の${s.lyrics ? '歌詞と' : ''}ジャケット、作品紹介。${firstSentence(s.aiImpression)}`;
const wordmark = (tag, attrs = '') => `<${tag} class="wordmark"${attrs}><span class="wm-pip">PIP</span><span class="wm-popper">POPPER</span></${tag}>`;
// third: the 3rd-design "finish" layer (top page and About). page-fade + history.css: every page.
const head = (r, title, extraClass = '', { path = '', description = DESCRIPTION, verify = false, homeOpening = false, third = false, fonts = '' } = {}) => `<!doctype html>
<html lang="ja" class="no-js${extraClass}" data-logo="b">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(pageUrl(path))}">
${verify && GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${esc(GOOGLE_SITE_VERIFICATION)}">\n` : ''}<link rel="icon" href="${r}favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" sizes="32x32" href="${r}assets/favicon-32.png">
<link rel="apple-touch-icon" href="${r}assets/apple-touch-icon.png">
${FONTS}
${fonts}<link rel="stylesheet" href="${r}assets/site.css">
${homeOpening ? `<link rel="stylesheet" href="${r}assets/home-opening.css">\n<script defer src="${r}assets/home-opening.js"></script>\n` : ''}${third ? `<link rel="stylesheet" href="${r}assets/third-design.css">\n` : ''}<link rel="stylesheet" href="${r}assets/history.css">
<link rel="stylesheet" href="${r}assets/page-fade.css">
<script src="${r}assets/page-fade.js"></script>
<script>document.documentElement.classList.replace('no-js', 'js');</script>
</head>
<body>`;
// Ambient light image. A url() inside the --cover custom property is resolved against site.css by some
// browsers (top page: assets/assets/… → 404), so the image is also set directly, which resolves from the page.
const glowStyle = u => `--cover:url('${u}');background-image:url('${u}')`;
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
${onHome ? `  <a class="mobile-latest" href="#latest">最新楽曲</a>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-navigation">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <path class="menu-open-icon" d="M1 4h14M1 8h14M1 12h14"/>
      <path class="menu-close-icon" d="m3 3 10 10M13 3 3 13"/>
    </svg>
    メニュー
  </button>\n` : ''}  <nav ${onHome ? 'id="site-navigation" ' : ''}aria-label="サイト内">
    <a class="nav-latest" href="${onHome ? '#latest' : sec(r, 'latest')}">最新楽曲</a>
    <a href="${onHome ? '#works' : sec(r, 'works')}">楽曲一覧</a>
    <a class="nav-history" href="${historyUrl(r)}">ヒストリー</a>
    <a class="nav-other" href="${otherUrl(r)}">その他の作品</a>
    <a class="nav-about" href="${aboutUrl(r)}">アーティスト紹介</a>
    <a class="nav-message" href="${onHome ? '#message' : sec(r, 'message')}">メッセージ</a>${listeningUrl ? `
    <a class="nav-listen" href="${esc(listeningUrl)}" aria-label="LISTEN｜音楽を聴く（誰でも聴ける一般視聴ページ）">LISTEN<span class="nav-listen-ja">｜音楽を聴く</span></a>` : ''}${PRIVATE_URL ? `
    <a class="nav-private" href="${esc(PRIVATE_URL)}" aria-label="PRIVATE（招待者専用の音源ライブラリ）"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="2.5" y="7" width="11" height="8" rx="1" fill="currentColor"/></svg><span class="nav-private-label">PRIVATE</span></a>` : ''}
  </nav>
</header>`;
// Top page: the "finish" sign-off (brand + OFFICIAL MUSIC SITE) and a link back to the latest release.
const footer = (r, onHome) => `<footer class="site-foot">
${onHome ? `  <div class="foot-sign">
    <a class="foot-brand" href="#top">${wordmark('span')}</a>
    <p class="foot-tag">OFFICIAL MUSIC SITE</p>
  </div>` : `  <a class="foot-brand" href="${homeUrl(r)}">${wordmark('span')}</a>`}
  <nav aria-label="フッター">
${onHome ? '    <a href="#latest">最新楽曲</a>\n' : ''}    <a href="${onHome ? '#works' : sec(r, 'works')}">楽曲一覧</a>
    <a href="${historyUrl(r)}">ヒストリー</a>
    <a href="${otherUrl(r)}">その他の作品</a>
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
      <p class="message-lead">${SITE.message.lead.map(esc).join('<br>')}</p>
    </header>
    <form class="message-form reveal" id="message-form" novalidate data-endpoint="https://formspree.io/f/${MESSAGE.formId}">
      <div class="field">
        <label for="m-name">お名前・ニックネーム<span class="opt">任意</span></label>
        <input id="m-name" name="name" type="text" maxlength="50" autocomplete="nickname" placeholder="匿名や、知り合いの方はヒントだけでもOK">
      </div>
      <div class="field">
        <label for="m-body">メッセージ<span class="req">必須</span></label>
        <textarea id="m-body" name="message" rows="7" maxlength="3000" required aria-describedby="m-body-err m-body-count" placeholder="ご感想、ご意見、応援、苦情、何でも歓迎。&#10;悪口を書くなら、徹底的にお願いします。"></textarea>
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

// Songs whose audio is not released to the public: a light, PIP POPPER-style note instead of a player.
const PRIVATE_NOTE = `<div class="listen-private" role="note">
        <p class="lp-status"><span class="lp-key">音源</span><span class="lp-val">一般非公開</span></p>
        <p class="lp-cond"><span class="lp-key">${esc(SITE.track.privateCondLabel)}</span><span class="lp-val lp-heart">${esc(SITE.track.privateCond)}</span></p>
      </div>`;
// 2026-11-25: "▶ 試聴する" — written hidden for every song whose audio is not private; assets/listen-links.js shows it only when
// the listening page's ID list (/listen/available.json, matched by song ID) has the song. No list / an error = stays hidden.
const trialUrl = id => `${listeningUrl}#song-${encodeURIComponent(id)}`;
const trialLink = (song, cls) => listeningUrl && !song.audioPrivate ? `<a class="${cls}" data-listen-id="${esc(song.id)}" href="${esc(trialUrl(song.id))}" aria-label="${esc(song.title)}を一般視聴ページで試聴する" hidden><span aria-hidden="true">▶</span> 試聴する</a>` : '';
const trialScript = r => listeningUrl ? `<script src="${r}assets/listen-links.js" data-src="${esc(/^https:/.test(listeningUrl) ? new URL('available.json', listeningUrl).href : listeningUrl.replace(/[^/]*$/, '') + 'available.json')}" defer></script>\n` : '';
const listen = (r, song) => {
  if (song.audioPrivate) return PRIVATE_NOTE;
  const links = song.links.map(l => `<a class="listen-link" data-service="${l.service}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} <span aria-hidden="true">↗</span></a>`).join('') + trialLink(song, 'listen-link listen-trial');
  return links ? `<div class="listen">${links}</div>` : '';
};

// ── Top page ─────────────────────────────────────────────────────────
{
  const r = '';
  const kanaRank = new Map(sortedSongs(songs).map((s,i)=>[s.id,i]));
  const azRank = new Map(sortedSongs(songs,'az').map((s,i)=>[s.id,i]));
  const cards = songs.map((s, i) => `<li class="work reveal" style="--i:${i}" data-order-new="${i}" data-order-kana="${kanaRank.get(s.id)}" data-order-az="${azRank.get(s.id)}">
      <a class="work-link" href="${trackUrl(r, s.id)}">
        <span class="work-jacket">${jacket(r, s, { eager: i < 4, small: true })}</span>
        <span class="work-meta"><span class="work-no">${no(i)}</span>${s === latest ? '<span class="work-new">LATEST</span>' : ''}${s.audioPrivate ? '<span class="work-private">音源非公開</span>' : ''}</span>
        <span class="work-title" style="--fit:${titleParts(s.title).fit}">${titleParts(s.title).html}</span>
        ${s.aiImpression ? `<span class="work-note">${esc(s.aiImpression)}</span>` : ''}
      </a>${trialLink(s, 'work-trial')}
    </li>`).join('\n    ');
  // Latest title (finish layout): main title large, a "-subtitle-" or "feat." part on its own line.
  const rel = (m => m ? { main: m[1], sub: m[2] } : { main: latest.title, sub: null })(latest.title.match(/^(.+?)\s+((?:-|feat\.|～|~).+)$/));
  const relMain = titleParts(rel.main);
  const relJa = /[぀-ヿ㐀-鿿]/.test(rel.main);
  const latestTitle = `<span class="release-title${relJa ? ' is-ja' : ''}">${relMain.html}</span>${rel.sub ? ` <span class="release-subtitle">${esc(rel.sub)}</span>` : ''}`;
  const historyStrip = historyAlbums.map(a => `<li><a href="${historyUrl(r, a.id)}">
          ${albumTile(r, a)}
          <span class="ht-year">${esc(a.year)}</span><span class="ht-title">${esc(a.title)}</span>
        </a></li>`).join('\n        ');
  await write('index.html', `${head(r, `PIP POPPER（${NAME_KANA}）｜OFFICIAL MUSIC SITE`, ' page-home', { verify: true, homeOpening: true, third: true })}
<a class="skip" href="#latest">最新楽曲へ移動</a>
${world(`<div class="glow" data-key="${latest.id}" style="${glowStyle(coverUrl(r, latest.id, true))}"></div>`)}
<p class="rail" aria-hidden="true"><span>PIP POPPER</span><span>OFFICIAL MUSIC SITE</span></p>
${topbar(r, true)}
<main>
  <section class="opening" id="top" aria-labelledby="site-title">
    <div class="opening-pin">
      <div class="concert" aria-hidden="true"></div>
      <div class="concert-shade" aria-hidden="true"></div>
      <div class="opening-title">
        <p class="kicker">OFFICIAL MUSIC SITE</p>
        <h1 class="wordmark" id="site-title" aria-label="PIP POPPER"><span class="wm-pip">PIP</span><span class="logo-rule" aria-hidden="true"></span><span class="wm-popper">POPPER</span></h1>
        <span class="logo-width" aria-hidden="true"></span>
      </div>
      <div class="crowd" aria-hidden="true"></div>
      <a class="cue" href="#latest"><span>SCROLL</span><i aria-hidden="true"></i></a>
    </div>
  </section>

  <section class="statement" aria-label="PIP POPPERについて">
    <p class="reveal">${SITE.home.statement.map(t => `<span>${esc(t)}</span>`).join('')}</p>
  </section>

  <section class="latest" id="latest" data-light="${latest.id}" aria-labelledby="latest-title">
    <p class="section-label reveal"><span class="label-en">Latest Release</span><span class="label-ja">最新楽曲</span></p>
    <div class="latest-body">
      <a class="latest-jacket reveal" href="${trackUrl(r, latest.id)}" tabindex="-1" aria-hidden="true">${jacket(r, latest, { eager: true })}</a>
      <div class="latest-info reveal">
        <h2 id="latest-title" style="--fit:${relMain.fit}"><a href="${trackUrl(r, latest.id)}">${latestTitle}</a></h2>
        ${latest.artist ? `<p class="latest-artist">${esc(latest.artist)}</p>` : ''}
        ${latest.aiImpression ? `<p class="latest-note"><span class="note-label">AIの感想</span>${esc(latest.aiImpression)}</p>` : ''}
        <a class="more" href="${trackUrl(r, latest.id)}">作品ページへ <span aria-hidden="true">→</span></a>
      </div>
    </div>
  </section>

  <section class="works" id="works" aria-labelledby="works-title">
    <header class="works-head reveal">
      <p class="section-label"><span class="label-en">Works</span><span class="label-ja" id="works-title">楽曲一覧</span></p>
      <p class="works-count"><span>${songs.length}</span> 作品を掲載中</p>
    </header>
    <div class="works-tools"><label for="works-order">表示順</label><select id="works-order"><option value="new">新着順（掲載順）</option><option value="kana">あいうえお順</option><option value="az">A〜Z順</option></select>${listeningUrl?`<a class="more" href="${esc(listeningUrl)}">一般視聴ページ <span aria-hidden="true">→</span></a>`:''}</div>
    <ol class="work-grid">
    ${cards}
    </ol>
  </section>

  <section class="history-teaser" aria-labelledby="history-teaser-title">
    <div class="ht-head reveal">
      <p class="section-label"><span class="label-en">History</span><span class="label-ja" id="history-teaser-title">ヒストリー</span></p>
      <p class="ht-lead">${esc(SITE.home.historyLead)}</p>
      <div class="ht-links">
        <a class="more" href="${historyUrl(r)}">アルバムの歴史を見る <span aria-hidden="true">→</span></a>
        <a class="more" href="${otherUrl(r)}">その他の作品を見る <span aria-hidden="true">→</span></a>
      </div>
    </div>
    <ol class="ht-strip reveal" aria-label="HISTORYのアルバム">
        ${historyStrip}
    </ol>
  </section>
  ${messageSection}
</main>
${footer(r, true)}
${sharedScript}
${messageScript}
<script src="assets/works-sort.js" defer></script>
${trialScript(r)}</body>
</html>
`);
}

// ── Track pages: tracks/<id>/index.html ──────────────────────────────
for (const [i, s] of songs.entries()) {
  const r = '../../';
  const step = (other, label) => other ? `<a href="${trackUrl(r, other.id)}"><small>${label}</small><span>${esc(other.title)}</span></a>` : '<span></span>';
  await write(`tracks/${s.id}/index.html`, `${head(r, `${esc(s.title)}｜PIP POPPER`, ' page-track', { path: `tracks/${s.id}/`, description: trackDescription(s) })}
${s.lyrics ? `<a class="skip" href="#text">${esc(s.lyricsLabel)}へ移動</a>\n` : ''}${world(`<div class="glow on" data-key="${s.id}" style="${glowStyle(coverUrl(r, s.id, true))}"></div>`)}
${topbar(r, false)}
<main class="track">
  <a class="back" href="${sec(r, 'works')}">← 楽曲一覧</a>
  <section class="track-hero" aria-labelledby="track-title">
    <div class="track-jacket">${jacket(r, s, { eager: true, alt: `${s.title}のジャケット` })}</div>
    <div class="track-head">
      <p class="track-no"><span>${no(i)}</span>${s === latest ? ' LATEST' : ''}</p>
      ${titleTag('h1', s.title, ' id="track-title"')}
      ${s.artist ? `<p class="track-artist">${esc(s.artist)}</p>` : ''}${originOf.has(s.id) ? (a => `\n      <p class="track-origin"><span class="to-key">${a.section === 'other' ? 'OTHER WORKS' : 'HISTORY'}</span><a href="${albumPageUrl(r, a)}">${a.year}年『${esc(a.title)}』収録 <span aria-hidden="true">→</span></a></p>`)(originOf.get(s.id)) : ''}
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
  ${s.lyrics ? `<section class="block text reveal" id="text" aria-labelledby="text-title">
    <h2 class="block-head" id="text-title"><span class="label-en">${esc(s.lyricsLabel)}</span></h2>
    <div class="lyrics-text" lang="ja">${lyricsHtml(s.lyrics)}</div>
  </section>` : ''}
  <nav class="steps" aria-label="ほかの楽曲">${step(songs[i - 1], '← 新しい曲')}${step(songs[i + 1], '前の曲 →')}</nav>
</main>
${footer(r, false)}
${sharedScript}
${s.audioPrivate ? '' : trialScript(r)}</body>
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
<link rel="canonical" href="${SITE_URL}">
<meta name="robots" content="noindex">
<style>body{margin:0;background:#060708;color:#f4f0ea;font:16px/1.8 "Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;display:grid;place-items:center;min-height:100vh}a{color:inherit}</style>
</head>
<body><p>楽曲一覧はトップページに移りました。<a href="../index.html#works">楽曲一覧へ</a></p></body>
</html>
`);

// ── About page: about/index.html ─────────────────────────────────────
// Producer-approved text (unchanged from the previous site).
const ABOUT = SITE.about.text;
{
  const r = '../';
  await write('about/index.html', `${head(r, 'アーティスト紹介｜PIP POPPER', ' page-track page-about', { path: 'about/', description: `PIP POPPER（${NAME_KANA}）のアーティスト紹介。${ABOUT[0]}`, third: true })}
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
      <a class="more" href="${historyUrl(r)}">アルバムの歴史を見る <span aria-hidden="true">→</span></a>
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

// ── HISTORY page: history/index.html ─────────────────────────────────
// Lettering of the approved chapter design: brush title, typewriter "First Album", heavy italic year.
const HISTORY_FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Permanent+Marker&family=Special+Elite&family=Playfair+Display:ital,wght@1,700;1,800&family=Jost:wght@300;400&family=Barlow+Condensed:wght@700;800&display=swap">
`;
// "The site is the real thing; the content is PIP POPPER." Only confirmed facts from albums.json.
{
  const r = '../';
  const p = text => `<p>${esc(text)}</p>`;
  // Each chapter: a cinematic scene (the adopted AI jacket, or the album's typographic stand-in),
  // then story + episode beside the track list / album facts / members, then a small archive note.
  const chapter = (a, i, list) => {
    // Joint chapter (SOLO WORKS, adopted design 2026-11-20): one studio scene, a gold heading, and the
    // works side by side, each with its jacket, a short text and its track list.
    if (a.works) return `<li class="chapter theme-${a.id} has-visual is-group" id="${a.id}" data-light="${a.id}" style="--accent:${esc(a.accent)}" aria-labelledby="${a.id}-title">
      <div class="ch-feature">
        <img class="ch-feature-bg" src="${a.ownBackdrop ? `${r}assets/history/${a.id}-backdrop.jpg` : albumVisual(r, a.id)}" alt="" aria-hidden="true" loading="lazy" decoding="async">
        <header class="sw-head reveal">
          <p class="sw-kicker">PIP POPPER ${a.section === 'other' ? 'OTHER WORKS' : 'HISTORY'}</p>
          <h2 class="sw-title" id="${a.id}-title">${esc(a.title)}</h2>
          <p class="sw-lead">${esc(a.lead)}</p>
        </header>
        <div class="sw-works reveal">
          ${a.works.map((w, n) => `<article class="sw-work" aria-labelledby="${a.id}-w${n + 1}">
            <figure class="sw-jacket"><img src="${r}assets/history/${a.id}-jacket-${n + 1}.jpg" width="${a.workSizes[n].w}" height="${a.workSizes[n].h}" alt="『${esc(w.title)}』のジャケット" loading="lazy" decoding="async"></figure>
            <h3 class="sw-work-title" id="${a.id}-w${n + 1}">${esc(w.title)}</h3>
            <p class="sw-work-kind">${esc(w.kind)}</p>
            <p class="sw-work-text">${esc(w.text)}</p>
            <h4 class="sw-tracks-head">${esc(w.tracksLabel)}</h4>
            <ol class="sw-tracks">${w.tracks.map(t => `<li>${esc(t.title)}</li>`).join('')}</ol>
          </article>`).join('\n          ')}
        </div>
        ${a.audioNote ? `<p class="sw-note">※ ${esc(a.audioNote)}</p>` : ''}
      </div>
    </li>`;
    const trackItems = list => list.map(t => `<li><span class="tr-title">${esc(t.title)}</span>${t.note ? `<small class="tr-note">${esc(t.note)}</small>` : ''}${t.music ? `<a class="tr-music" href="${trackUrl(r, t.music)}">MUSIC「${esc(songById.get(t.music).title)}」 <span aria-hidden="true">→</span></a>` : ''}</li>`).join('');
    const tracks = trackItems(a.tracks);
    const info = [['アルバム名', a.title + (a.subtitle ? `（${a.subtitle}）` : '')], ['発表', a.dateLabel], ['区分', a.kind], ['収録', `全${a.tracks.length}曲`], ...(a.info ?? [])]
      .filter(([, v]) => v).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const label = a.membersLabel ?? '参加メンバー';
    const members = a.members?.length ? `<section class="ch-panel ch-members" aria-label="${esc(label)}">
            <h3>${esc(label)}</h3>
            <dl>${a.members.map(m => `<div><dt>${esc(m.name)}</dt><dd>${esc(m.role ?? m.note ?? '')}</dd></div>`).join('')}</dl>
            ${a.membersSource ? `<p class="ch-src">${esc(a.membersSource)}</p>` : ''}
          </section>` : '';
    const episode = a.episode ? `<section class="ch-episode${a.episode.quote ? ' is-quote' : ''}" aria-label="${esc(a.episode.title)}">
            <h3>${esc(a.episode.title)}</h3>
            ${a.episode.quote ? `<blockquote>${a.episode.text.map(p).join('')}</blockquote>` : a.episode.text.map(p).join('')}
          </section>` : '';
    const archive = a.archive ? `<aside class="ch-archive reveal" aria-label="ORIGINAL ARCHIVE">
        <img src="${albumArchive(r, a.id)}" width="${a.archiveSize.w}" height="${a.archiveSize.h}" alt="当時の『${esc(a.title)}』CDジャケット（資料）" loading="lazy" decoding="async">
        <p><span class="ch-archive-key">ORIGINAL ARCHIVE</span>当時のCDジャケット（資料）</p>
      </aside>` : a.archiveNote ? `<aside class="ch-archive is-text reveal" aria-label="ORIGINAL ARCHIVE"><p><span class="ch-archive-key">ORIGINAL ARCHIVE</span>${esc(a.archiveNote)}</p></aside>` : '';
    // Album with its adopted AI jacket: the Producer-approved chapter design (2026-11-20, first used for
    // 1999 PIP POPPER) — the jacket large on the left, title / year / story on the right, and
    // ALBUM INFO, members, track list and a small ORIGINAL ARCHIVE in a row of panels below.
    if (a.visualSize) {
      const hl = (text, word) => word && text.includes(word) ? esc(text).replace(esc(word), `<em>${esc(word)}</em>`) : esc(text);
      const lines = a.episode ? a.episode.text.map((t, j, all) => `<p>${hl(t, j === all.length - 1 ? a.episode.highlight : null)}</p>`).join('') : '';
      const fInfo = [['アルバム名', a.title + (a.subtitle ? `（${a.subtitle}）` : '')], ['発表年', a.dateLabel], ['区分', a.kind], ['収録曲数', `全${a.tracks.length}曲`], ...(a.info ?? []).map(([k, v]) => [k, v.replace(/（CD記載：.*）$/, '（CD記載）')])]
        .filter(([, v]) => v).map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
      const fMembers = (a.members ?? []).map(m => `<tr><th scope="row">${esc(m.name)}</th><td>${esc(m.role ?? m.note ?? '')}</td></tr>`).join('');
      return `<li class="chapter theme-${a.id} has-visual" id="${a.id}" data-light="${a.id}" style="--accent:${esc(a.accent)}" aria-labelledby="${a.id}-title">
      <div class="ch-feature">
        <img class="ch-feature-bg" src="${a.ownBackdrop ? `${r}assets/history/${a.id}-backdrop.jpg` : albumVisual(r, a.backdrop ?? a.id)}" alt="" aria-hidden="true" loading="${i < 1 ? 'eager' : 'lazy'}" decoding="async">
        <div class="ch-feature-top${a.visualWide ? ' is-wide' : ''}">
          <figure class="ch-visual reveal"><img src="${albumVisual(r, a.id)}" width="${a.visualSize.w}" height="${a.visualSize.h}" alt="『${esc(a.title)}』の${a.visualWide ? 'ロゴ' : 'ジャケット'}" loading="${i < 1 ? 'eager' : 'lazy'}" decoding="async"></figure>
          <div class="ch-feature-head reveal">
            <p class="ch-badge">${esc(a.no ?? '')}</p>
            <div class="ch-titlerow${a.yearLabel ? ' has-date' : ''}">
              <h2 class="ch-title${a.titleImageSize ? ' has-image' : ''}" id="${a.id}-title">${a.titleImageSize ? `<img class="ch-title-img" src="${r}assets/history/${a.id}-title.png" width="${a.titleImageSize.w}" height="${a.titleImageSize.h}" alt="${esc(a.title)}" decoding="async">` : a.titleLines ? (Array.isArray(a.titleLines) ? a.titleLines : a.title.split(' ')).map(w => `<span class="ch-title-line">${esc(w)}</span>`).join(' ') : esc(a.title)}<span class="ch-kindline">${(a.kindLabel ?? a.kind).includes('|') ? (a.kindLabel ?? a.kind).split('|').map(esc).join('<span class="ch-kindline-rule" aria-hidden="true"></span>') : esc(a.kindLabel ?? a.kind)}</span></h2>
              ${a.sideLabel ? `<p class="ch-side-label">${a.sideLabel.split(' ').map(esc).join('<br>')}</p>` : `<p class="ch-year${a.yearLabel ? ' is-date' : ''}">${esc(a.yearLabel ?? a.year)}</p>`}
            </div>
            ${a.episode ? `<section class="ch-origin" aria-labelledby="${a.id}-origin"><h3 id="${a.id}-origin">${hl(a.episode.title, a.episode.titleHighlight)}</h3><div class="ch-origin-text">${lines}</div>${a.episode.closing ? `<p class="ch-closing">${hl(a.episode.closing, 'PIP POPPER')}</p>` : ''}${[].concat(a.episode.closingAfter ?? []).map(t => `<p class="ch-closing-after">${esc(t)}</p>`).join('')}${a.episode.note ? `<div class="ch-origin-note">${a.episode.note.map(p).join('')}</div>` : ''}</section>` : ''}${a.credit ? `<p class="ch-credit"><span class="ch-credit-label">${esc(a.credit.label)}</span><span class="ch-credit-dot" aria-hidden="true">/</span><span class="ch-credit-who">${esc(a.credit.who)}</span>${a.credit.role ? `<span class="ch-credit-role">${esc(a.credit.role)}</span>` : ''}</p>` : ''}
          </div>
        </div>
        ${a.column ? `<section class="ch-column reveal" aria-labelledby="${a.id}-column"><h3 id="${a.id}-column">${esc(a.column.title)}</h3>${a.column.text.map((t, j) => p(t) + (a.column.focus && j === a.column.focus.after ? `<div class="ch-focus"><span class="ch-focus-letter" aria-hidden="true">${esc(a.column.focus.letter)}</span><div><p class="ch-focus-title">${esc(a.column.focus.title)}</p><p class="ch-focus-text">${esc(a.column.focus.text)}</p></div></div>` : '')).join('')}${a.column.notes ? `<div class="ch-notes">${a.column.notes.map(n => `<div class="ch-note"><h4>${esc(n.title)}</h4><p>${esc(n.text)}</p></div>`).join('')}</div>` : ''}${a.column.quote ? `<blockquote class="ch-quote"><small>${esc(a.column.quote.label)}</small>${a.column.quote.lines.map(esc).join('<br>')}</blockquote>` : ''}${a.column.closing ? `<p class="ch-column-closing">${esc(a.column.closing)}</p>` : ''}${a.column.closingAfter ? `<p>${esc(a.column.closingAfter)}</p>` : ''}</section>` : ''}
        <div class="ch-feature-panels reveal">
          <section class="fp fp-info" aria-labelledby="${a.id}-info"><h3 class="fp-head" id="${a.id}-info">${esc(a.infoLabel ?? 'ALBUM INFO')}</h3><table>${fInfo}</table>${a.infoNote ? `<p class="fp-src">${esc(a.infoNote)}</p>` : ''}</section>
          ${fMembers ? `<section class="fp fp-members${(a.members ?? []).some(m => m.role ?? m.note) ? '' : ' is-initials'}" aria-labelledby="${a.id}-members"><h3 class="fp-head" id="${a.id}-members">${esc(a.membersLabel ?? '参加メンバー')}</h3><table>${fMembers}</table>${a.membersSource ? `<p class="fp-src">${esc(a.membersSource)}</p>` : ''}</section>` : ''}
          ${a.discs ? `<header class="fp-discs-head">${a.tracksHead ? `<p class="fp-kicker">${esc(a.tracksHead.kicker)}</p><h3 class="fp-discs-title" id="${a.id}-tracks">${esc(a.tracksHead.title)} <em>${esc(a.tracksHead.sub)}</em></h3>${a.tracksHead.aside ? `<p class="fp-tracks-aside">${a.tracksHead.aside.map(esc).join('<br>')}</p>` : ''}` : `<h3 class="fp-discs-title" id="${a.id}-tracks">収録曲（全${a.tracks.length}曲）</h3>`}</header>${a.discs.map((d, n) => `<section class="fp fp-tracks fp-disc" aria-labelledby="${a.id}-disc${n + 1}"><div class="fp-disc-head"><span class="fp-disc-record" aria-hidden="true"></span><div><h4 class="fp-disc-name" id="${a.id}-disc${n + 1}">${esc(d.name)}</h4>${d.sub ? `<p class="fp-disc-sub">${esc(d.sub)}</p>` : ''}</div></div><ol>${trackItems(d.tracks)}</ol></section>`).join('')}${a.audioNote ? `<p class="fp-audio-note fp-discs-note">※ ${esc(a.audioNote)}</p>` : ''}` : `<section class="fp fp-tracks" aria-labelledby="${a.id}-tracks"><h3 class="fp-head" id="${a.id}-tracks">${a.tracksHead ? `<span class="fp-kicker">${esc(a.tracksHead.kicker)}</span>${esc(a.tracksHead.title)} <em>${esc(a.tracksHead.sub)}</em>` : `収録曲（全${a.tracks.length}曲）`}</h3>${a.tracksHead?.aside ? `<p class="fp-tracks-aside">${a.tracksHead.aside.map(esc).join('<br>')}</p>` : ''}<ol>${tracks}</ol>${a.audioNote ? `<p class="fp-audio-note">※ ${esc(a.audioNote)}</p>` : ''}</section>`}
          ${a.memo ? `<section class="fp fp-caution is-memo" aria-labelledby="${a.id}-memo"><h3 class="fp-caution-head" id="${a.id}-memo">${esc(a.memo.title)}</h3><ul>${a.memo.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul></section>` : ''}
          ${a.caution ? `<section class="fp fp-caution" aria-labelledby="${a.id}-caution"><h3 class="fp-caution-head" id="${a.id}-caution">${esc(a.caution.title)}</h3><ol>${a.caution.items.map(t => `<li>${esc(t)}</li>`).join('')}</ol>${a.caution.note ? `<p class="fp-caution-note">※ ${esc(a.caution.note)}</p>` : ''}</section>` : ''}
          ${a.archive ? `<aside class="fp fp-archive" aria-label="ORIGINAL ARCHIVE"><p class="fp-archive-label">ORIGINAL ARCHIVE</p><img src="${albumArchive(r, a.id)}" width="${a.archiveSize.w}" height="${a.archiveSize.h}" alt="当時の『${esc(a.title)}』CDジャケット（資料）" loading="lazy" decoding="async"><p class="fp-archive-note">※当時の実物CDジャケット（資料）</p></aside>` : a.archiveNote ? `<aside class="fp fp-archive is-text" aria-label="ORIGINAL ARCHIVE"><p class="fp-archive-label">ORIGINAL ARCHIVE</p><p class="fp-archive-note">${esc(a.archiveNote)}</p></aside>` : ''}
        </div>
        ${a.stripHead ? `<section class="ch-film reveal" aria-labelledby="${a.id}-film"><p class="ch-film-kicker">${esc(a.stripHead.kicker)}</p><h3 class="ch-film-title" id="${a.id}-film">${a.stripHead.lines.map(l => a.stripHead.em && l.includes(a.stripHead.em) ? esc(l).replace(esc(a.stripHead.em), `<em>${esc(a.stripHead.em)}</em>`) : esc(l)).join('<br>')}</h3><div class="ch-strip">${a.stripSizes.map((z, n) => `<figure><img src="${r}assets/history/${a.id}-strip-${n + 1}.jpg" width="${z.w}" height="${z.h}" alt="${esc(a.strip[n])}" loading="lazy" decoding="async">${a.stripHead.captions?.[n] ? `<figcaption><span>${esc(a.stripHead.captions[n][0])}</span><b>${esc(a.stripHead.captions[n][1])}</b></figcaption>` : ''}</figure>`).join('')}</div>${a.stripHead.note ? `<p class="ch-film-note">${esc(a.stripHead.note)}</p>` : ''}</section>` : a.stripSizes.length ? `<div class="ch-strip reveal">${a.stripSizes.map((z, n) => `<figure><img src="${r}assets/history/${a.id}-strip-${n + 1}.jpg" width="${z.w}" height="${z.h}" alt="${esc(a.strip[n])}" loading="lazy" decoding="async"></figure>`).join('')}</div>` : ''}${a.afterword ? `<section class="ch-afterword reveal" aria-labelledby="${a.id}-after"><p class="ch-after-label" id="${a.id}-after">${esc(a.afterword.label)}</p><div class="ch-after-text">${a.afterword.text.map(p).join('')}</div>${a.afterword.sign ? `<p class="ch-after-sign">${esc(a.afterword.sign)}</p>` : ''}</section>` : ''}
      </div>
    </li>`;
    }
    return `<li class="chapter theme-${a.id}${a.visualSize ? ' has-visual' : ''}" id="${a.id}" data-light="${a.id}" style="--accent:${esc(a.accent)}" aria-labelledby="${a.id}-title">
      <div class="ch-scene">
        <div class="ch-scene-art" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        ${a.visualSize ? `<img class="ch-visual-bg" src="${albumVisual(r, a.id, true)}" alt="" aria-hidden="true" loading="lazy" decoding="async">
        <figure class="ch-visual reveal"><img src="${albumVisual(r, a.id)}" width="${a.visualSize.w}" height="${a.visualSize.h}" alt="『${esc(a.title)}』のジャケット" loading="${i < 1 ? 'eager' : 'lazy'}" decoding="async"></figure>` : ''}
        <div class="ch-scene-text reveal">
          <p class="ch-no">${esc(a.no ?? '')}<span class="ch-count">${String(i + 1).padStart(2, '0')} / ${String(list.length).padStart(2, '0')}</span></p>
          <p class="ch-year">${esc(a.year)}</p>
          <h2 class="ch-title" id="${a.id}-title">${esc(a.title)}${a.subtitle ? ` <span class="ch-sub">${esc(a.subtitle)}</span>` : ''}</h2>
          <p class="ch-kind">${esc(a.kind)}${a.dateLabel ? `<span>${esc(a.dateLabel)}</span>` : ''}</p>
        </div>
      </div>
      <div class="ch-grid">
        <div class="ch-main reveal">
          <div class="ch-story">${a.story.map(p).join('')}</div>
          ${episode}
          ${a.audioNote ? `<p class="ch-audio-note" role="note">${esc(a.audioNote)}</p>` : ''}
        </div>
        <div class="ch-side reveal">
          <section class="ch-panel ch-tracks" aria-label="収録曲"><h3>収録曲<span>全${a.tracks.length}曲</span></h3><ol>${tracks}</ol></section>
          <section class="ch-panel ch-info" aria-label="アルバム情報"><h3>アルバム情報</h3><dl>${info}</dl></section>
          ${members}
        </div>
      </div>
      ${archive}
    </li>`;
  };
  const glowsOf = list => list.map((a, i) => `<div class="glow${i === 0 ? ' on' : ''}" data-key="${a.id}" style="${albumGlow(r, a)}"></div>`).join('');
  const glows = glowsOf(historyAlbums);
  // Old links to a work that moved to OTHER WORKS (history/#independence etc.) land on its new place.
  const movedScript = `<script>(() => { const id = decodeURIComponent(location.hash.slice(1)); const moved = ${JSON.stringify(otherAlbums.map(a => a.id))}; if (moved.some(m => id === m || id.startsWith(m + '-'))) location.replace('${otherUrl(r)}' + location.hash); })();</script>`;
  await write('history/index.html', `${head(r, 'ヒストリー｜PIP POPPER', ' page-track page-history', { path: 'history/', description: SITE.history.description, fonts: HISTORY_FONTS })}
${movedScript}
<a class="skip" href="#chapters">本文へ移動</a>
${world(glows)}
${topbar(r, false)}
<main class="history">
  <header class="hist-hero">
    <p class="section-label reveal"><span class="label-en">History</span><span class="label-ja">ヒストリー</span></p>
    <h1 class="hist-title reveal">${SITE.history.title.map(t => `<span class="tw">${esc(t)}</span>`).join('<wbr>')}</h1>
    <p class="hist-lead reveal">${esc(SITE.history.lead)}</p>
    <nav class="hist-index reveal" aria-label="アルバム">
      ${historyAlbums.map(a => `<a href="#${a.id}"><span class="hi-year">${esc(a.year)}</span><span class="hi-title">${esc(a.title)}</span></a>`).join('\n      ')}
    </nav>
  </header>
  <ol class="chapters" id="chapters">
    ${historyAlbums.map((a, i) => chapter(a, i, historyAlbums)).join('\n    ')}
  </ol>
  <section class="hist-end reveal" aria-label="楽曲一覧へ">
    <p>${esc(SITE.history.endText)}</p>
    <a class="more" href="${sec(r, 'works')}">楽曲一覧を見る <span aria-hidden="true">→</span></a>
    <a class="more" href="${otherUrl(r)}">その他の作品を見る <span aria-hidden="true">→</span></a>
  </section>
</main>
${footer(r, false)}
${sharedScript}
</body>
</html>
`);

  // ── OTHER WORKS page: other-works/index.html ──
  // A gallery to compare the works (existing jackets, kind, year, track count only), then each work's
  // adopted chapter design unchanged. The joint SOLO WORKS chapter stays one chapter; its three works
  // each get a card that opens that chapter at the work.
  const cards = otherAlbums.flatMap(a => a.works
    ? a.works.map((w, n) => ({ href: `#${a.id}-w${n + 1}`, img: `${r}assets/history/${a.id}-jacket-${n + 1}.jpg`, title: w.title, kind: w.kind, date: null, count: w.tracks.length }))
    : [{ href: `#${a.id}`, img: albumVisual(r, a.id, true), title: a.title, kind: a.kind, date: a.sideLabel ?? a.dateLabel ?? (/\d/.test(a.year ?? '') ? a.year : null), count: a.tracks.length }]);
  await write('other-works/index.html', `${head(r, 'その他の作品｜PIP POPPER', ' page-track page-history page-other', { path: 'other-works/', description: SITE.otherWorks.description, fonts: HISTORY_FONTS })}
<a class="skip" href="#chapters">本文へ移動</a>
${world(glowsOf(otherAlbums))}
${topbar(r, false)}
<main class="history other-works">
  <header class="hist-hero">
    <p class="section-label reveal"><span class="label-en">Other Works</span><span class="label-ja">その他の作品</span></p>
    <h1 class="hist-title reveal">${SITE.otherWorks.title.map(t => `<span class="tw">${esc(t)}</span>`).join('<wbr>')}</h1>
    <p class="hist-lead reveal">${esc(SITE.otherWorks.lead)}</p>
  </header>
  <ol class="ow-gallery reveal" aria-label="作品">
    ${cards.map(c => `<li><a href="${c.href}">
      <span class="ow-jacket"><img src="${c.img}" alt="" loading="lazy" decoding="async"></span>
      <span class="ow-kind">${esc(c.kind)}</span>
      <span class="ow-title">${esc(c.title)}</span>
      <span class="ow-meta">${c.date ? `${esc(c.date)}・` : ''}全${c.count}曲</span>
    </a></li>`).join('\n    ')}
  </ol>
  <ol class="chapters" id="chapters">
    ${otherAlbums.map((a, i) => chapter(a, i, otherAlbums)).join('\n    ')}
  </ol>
  <section class="hist-end reveal" aria-label="ヒストリーへ">
    <p>${esc(SITE.otherWorks.endText)}</p>
    <a class="more" href="${historyUrl(r)}">アルバムの歴史を見る <span aria-hidden="true">→</span></a>
    <a class="more" href="${sec(r, 'works')}">楽曲一覧を見る <span aria-hidden="true">→</span></a>
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
await mkdir(new URL('assets/history/', out), { recursive: true });
for (const f of ['third-design.css', 'history.css', 'page-fade.css', 'page-fade.js', 'works-sort.js', 'listen-links.js'])
  await copyFile(new URL(`src/${f}`, root), new URL(`assets/${f}`, out));
for (const a of albums) {
  if (a.visualSize) for (const [src, dst] of [['visual-web', 'visual'], ['visual-640', 'visual-640']])
    await copyFile(new URL(`${a.id}/${src}.jpg`, albumDir), new URL(`assets/history/${a.id}-${dst}.jpg`, out));
  if (a.titleImageSize) await copyFile(new URL(`${a.id}/title-web.png`, albumDir), new URL(`assets/history/${a.id}-title.png`, out));
  if (a.ownBackdrop) await copyFile(new URL(`${a.id}/backdrop-web.jpg`, albumDir), new URL(`assets/history/${a.id}-backdrop.jpg`, out));
  if (a.archive) await copyFile(new URL(`${a.id}/cover-240.jpg`, albumDir), new URL(`assets/history/${a.id}-archive.jpg`, out));
  for (const n of a.workSizes.keys()) await copyFile(new URL(`${a.id}/jacket-${n + 1}.jpg`, albumDir), new URL(`assets/history/${a.id}-jacket-${n + 1}.jpg`, out));
  for (const n of a.stripSizes.keys()) await copyFile(new URL(`${a.id}/strip-${n + 1}.jpg`, albumDir), new URL(`assets/history/${a.id}-strip-${n + 1}.jpg`, out));
}
await copyFile(new URL('src/site.css', root), new URL('assets/site.css', out));
await copyFile(new URL('src/stage.jpg', root), new URL('assets/stage.jpg', out));
for (const f of ['home-opening.css', 'home-opening.js', 'Anton-Regular.ttf', 'Anton-OFL.txt'])
  await copyFile(new URL(`src/${f}`, root), new URL(`assets/${f}`, out));
// Browser / bookmark icons (made by python tools/make-icons.py).
await copyFile(new URL('src/icons/favicon.ico', root), new URL('favicon.ico', out));
for (const f of ['favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'])
  await copyFile(new URL(`src/icons/assets/${f}`, root), new URL(`assets/${f}`, out));
for (const s of songs) {
  await copyFile(new URL(`${s.id}/cover-web.jpg`, trackDir), new URL(`assets/covers/${s.id}.jpg`, out));
  await copyFile(new URL(`${s.id}/cover-640.jpg`, trackDir), new URL(`assets/covers/${s.id}-640.jpg`, out));
}
// ── sitemap.xml / robots.txt (rebuilt every time, so new songs are always included) ──
const SITEMAP_PATHS = ['', 'about/', 'history/', 'other-works/', ...songs.map(s => `tracks/${s.id}/`)];
await write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PATHS.map(p => `  <url><loc>${esc(pageUrl(p))}</loc></url>`).join('\n')}
</urlset>
`);
// 掲載停止: remove what an earlier build made for hidden songs/albums (only those exact generated files)
for (const id of hiddenSongs) {
  await rm(new URL(`tracks/${id}/`, out), { recursive: true, force: true });
  for (const f of [`${id}.jpg`, `${id}-640.jpg`]) await rm(new URL(`assets/covers/${f}`, out), { force: true });
}
for (const id of hiddenAlbums) for (const f of await readdir(new URL('assets/history/', out)).catch(() => []))
  if (f.slice(0, id.length + 1) === `${id}-` && /^(visual|visual-640|archive|backdrop|title|strip-\d+|jacket-\d+)\.(jpg|png)$/.test(f.slice(id.length + 1))) await rm(new URL(`assets/history/${f}`, out), { force: true });

// works.json: the list the PRIVATE admin screen offers when adding a song (only already-public facts).
await write('works.json', JSON.stringify(songs.map(s => ({ id: s.id, title: s.title, cover: pageUrl(`assets/covers/${s.id}-640.jpg`) })), null, 1) + '\n');
await write('robots.txt', `User-agent: *
Allow: /

Sitemap: ${pageUrl('sitemap.xml')}
`);
if (!await exists(new URL('.nojekyll', out))) await writeFile(new URL('.nojekyll', out), '');
// Recurrence guard: no audio folder may remain in the published output.
if (await exists(new URL('assets/audio/', out))) throw new Error(`公開フォルダーに音源フォルダーが残っています: ${fileURLToPath(new URL('assets/audio/', out))}`);
console.log(`Built ${songs.length} songs into ${fileURLToPath(out)} — latest: ${latest.title}; audio: none (never on the official site)`);
