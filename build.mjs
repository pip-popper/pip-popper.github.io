import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const output = join(root, 'docs');
const sources = join(root, 'tracks');
const logoFile = 'ライブステージのPIP POPPERロゴ(1).png';

async function copyArtwork(source, target, usePublishedCopy = false) {
  try {
    await copyFile(source, target);
  } catch (error) {
    if (!usePublishedCopy || error.code !== 'ENOENT') throw error;
    await readFile(target);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function page(title, base, active, content) {
  const nav = [
    ['tracks', 'tracks/index.html', '楽曲一覧'],
    ['about', 'about/index.html', 'アーティスト紹介']
  ].map(([key, path, label]) =>
    `<a href="${base}${path}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`
  ).join('');
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${base}assets/site.css">
</head>
<body>
<a class="skip" href="#main">本文へ</a>
<header class="masthead"><div class="wrap masthead-inner">
<a class="wordmark" href="${base}index.html"${active === 'home' ? ' aria-current="page"' : ''}>PIP POPPER</a>
<nav aria-label="サイト内">${nav}</nav>
</div></header>
<main id="main" class="wrap">${content}</main>
</body>
</html>
`;
}

function artwork(track, base) {
  return `<img class="cover" src="${base}${track.cover}" alt="${escapeHtml(track.title)}のジャケット">`;
}

function details(track) {
  const date = track.releaseDate ? `<time datetime="${track.releaseDate}">${track.releaseDate}</time>` : '';
  const summary = track.summary ? `<p class="description">${escapeHtml(track.summary)}</p>` : '';
  return date + summary;
}

function link(url, label) {
  if (!url) return '';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`掲載URLに HTTPS が必要です: ${label}`);
  return `<li><a href="${escapeHtml(parsed.href)}">${label}</a></li>`;
}

async function readTrack(folder) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder)) throw new Error(`楽曲IDが無効です: ${folder}`);
  const path = join(sources, folder);
  const data = JSON.parse(await readFile(join(path, 'track.json'), 'utf8'));
  if (!data.title?.trim()) throw new Error(`曲名が必要です: ${folder}`);
  if (data.releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.releaseDate)) throw new Error(`公開日の形式が無効です: ${folder}`);
  if (typeof data.artwork !== 'string' || basename(data.artwork) !== data.artwork || !/\.png$/i.test(data.artwork)) {
    throw new Error(`ジャケットにPNGのファイル名が必要です: ${folder}`);
  }
  if (data.audio != null && (typeof data.audio !== 'string' || basename(data.audio) !== data.audio || !/.(mp3|m4a|wav)$/i.test(data.audio))) {
    throw new Error(`音源にはMP3・M4A・WAVのファイル名が必要です: ${folder}`);
  }
  const sourceAudio = data.audio ? join(path, data.audio) : null;
  const audioFile = data.audio ? `assets/audio/${folder}${extname(data.audio).toLowerCase()}` : null;
  let sourceImage = join(path, data.artwork);
  if (folder === 'job-hunting') sourceImage = join(root, data.artwork);
  return {
    ...data, id: folder, sourceImage, sourceAudio, audioFile, cover: `assets/covers/${folder}.png`,
    links: link(data.streamingUrl, '配信で聴く') + link(data.downloadUrl, '無料ダウンロード')
  };
}

const directories = await readdir(sources, { withFileTypes: true });
const tracks = await Promise.all(directories.filter(entry => entry.isDirectory()).map(entry => readTrack(entry.name)));
tracks.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') ||
  (a.listOrder ?? 0) - (b.listOrder ?? 0) || a.id.localeCompare(b.id));
const latest = tracks[0];
if (!latest) throw new Error('掲載する楽曲データが必要です。');

function logo(base) {
  return `<img class="brand-logo" src="${base}assets/pip-popper-logo.png" alt="PIP POPPER">`;
}

async function save(path, html) {
  const target = join(output, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, html, 'utf8');
}

await mkdir(join(output, 'assets', 'covers'), { recursive: true });
if (tracks.some(track => track.audioFile)) await mkdir(join(output, 'assets', 'audio'), { recursive: true });
await Promise.all([
  copyArtwork(join(root, logoFile), join(output, 'assets', 'pip-popper-logo.png'), true),
  ...tracks.map(track => copyArtwork(track.sourceImage, join(output, track.cover), track.id === 'job-hunting')),
  ...tracks.filter(track => track.audioFile).map(track => copyFile(track.sourceAudio, join(output, track.audioFile)))
]);

await save('index.html', page('PIP POPPER｜公式サイト', '', 'home', `
<section class="hero">
  <div class="hero-copy">
    <h1>${logo('')}</h1>
    <p class="eyebrow">最新楽曲</p>
    <h2>${escapeHtml(latest.title)}</h2>
    ${details(latest)}
    <div class="actions"><a class="button" href="tracks/${latest.id}/index.html">作品を見る <span aria-hidden="true">↗</span></a>
    <a href="tracks/index.html">楽曲一覧へ</a></div>
  </div>
  <a class="hero-cover" href="tracks/${latest.id}/index.html" aria-label="${escapeHtml(latest.title)}の個別ページへ">${artwork(latest, '')}</a>
</section>`));

await save('tracks/index.html', page('楽曲一覧｜PIP POPPER', '../', 'tracks', `
<section class="page">
  <h1>楽曲一覧</h1>
  <ul class="track-list">${tracks.map(track => `<li><a class="track-row" href="${track.id}/index.html">
    ${artwork(track, '../')}<div><h2>${escapeHtml(track.title)}</h2>${details(track)}</div><span aria-hidden="true">↗</span>
  </a></li>`).join('')}</ul>
</section>`));

for (const track of tracks) {
  const listen = track.audioFile ? `<section class="reading listen"><h2>楽曲を聴く</h2><audio controls preload="metadata" src="../../${track.audioFile}">お使いのブラウザでは再生できません。</audio></section>` : '';
  const impression = track.aiImpression ? `<section class="reading"><h2>AIの感想</h2><p class="prose">${escapeHtml(track.aiImpression)}</p></section>` : '';
  const background = track.background ? `<section class="reading"><h2>制作背景</h2><p class="prose">${escapeHtml(track.background)}</p></section>` : '';
  const links = track.links ? `<section class="reading"><h2>配信・ダウンロード</h2><ul>${track.links}</ul></section>` : '';
  const lyrics = track.lyrics ? `<p class="prose lyrics-text">${escapeHtml(track.lyrics)}</p>` : '<p class="description">歌詞は未掲載です。</p>';
  const artist = track.artist ? `<p class="description">${escapeHtml(track.artist)}</p>` : '';
  await save(`tracks/${track.id}/index.html`, page(`${track.title}｜PIP POPPER`, '../../', 'tracks', `
<article class="page">
  <a class="back" href="../index.html">← 楽曲一覧</a>
  <div class="track-heading">${artwork(track, '../../')}<div><h1>${escapeHtml(track.title)}</h1>${artist}${details(track)}</div></div>
  ${listen}${impression}
  <section class="reading lyrics"><h2>歌詞</h2>${lyrics}</section>
  ${background}${links}
</article>`));
}

await save('about/index.html', page('アーティスト紹介｜PIP POPPER', '../', 'about', `
<article class="page about">
  <h1>アーティスト紹介</h1>
  ${logo('../')}
  <p>日々の経験や社会への疑問、皮肉やユーモアを、歌詞と音楽にしています。</p>
  <p>作品の原点は、本人が書いた歌詞と楽曲です。過去に作った曲も、AIなど現代の制作手段を使いながら再制作しています。</p>
  <p>このサイトは、自分の頭から生まれた作品を、できるだけ長く世の中に残すための公式アーカイブです。</p>
  <a class="button" href="../tracks/index.html">楽曲一覧を見る <span aria-hidden="true">↗</span></a>
</article>`));
console.log(`Generated ${tracks.length + 3} pages for ${tracks.length} track(s) in docs/.`);
