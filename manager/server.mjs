// PIP POPPER 管理ツール Version 1 — ローカル専用サーバー（このパソコンの中だけで動く）。
// 起動：プロジェクト直下の「PIP POPPER管理ツールを起動.bat」。画面はブラウザで開く。
//
// できること：曲・アルバム・サイトの文言の文字を編集 → 保存 → プレビュー → 公開（GitHub Pages）→ 取り消し。
// 触るファイル：tracks/<曲ID>/track.json・albums/albums.json・content/site.json（文字の値だけ。項目の追加・削除はしない）。
// 公開時だけ docs/ を作り直して commit・push する。PRIVATE（private/）・デザイン（src/）・画像・build.mjs には触れない。
// 秘密情報は持たない：GitHubへの送信はこのパソコンに保存済みのGitのログイン情報を使う。
//
// 安全：127.0.0.1 でだけ待ち受け、起動ごとの合言葉（token）とHost確認がない要求は拒否。
//       保存は「画面が読んだ時点の内容」と一致するときだけ（他の作業の上書き防止）。
//       公開は、ブランチ・送信先・変更ファイルの範囲・GitHubとの同期を確認してから行う。
//
// テスト用オプション：--root <フォルダー>（別の作業コピーを対象にする）、--no-open、--port <番号>、
//   環境変数 PP_MANAGER_EXPECTED_REMOTE（検証用の送信先。通常は使わない）。
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, readdir, stat, copyFile, rm, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateLyricsCall } from './private-lyrics.mjs';
import { listReleaseStatus, saveReleaseStatus, sanitizePrivateRows } from './release-status.mjs';
import { registrationAction, listRegistrations, images as checkImages } from './song-registration.mjs';
import { albumRegistrationAction, listAlbumRegistrations, adoptionSource, markAlbumAdopted, albumGet, ALBUM_SLUG } from './album-registration.mjs';
import { validReading } from '../private/worker/src/song-order.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ROOT = path.resolve(arg('--root') ?? path.join(HERE, '..'));
let PORT = Number(arg('--port') ?? 18990);
const OPEN = !process.argv.includes('--no-open') && !process.env.PP_MANAGER_NO_OPEN;   // the env form is for checking the BAT without opening a browser
const BRANCH = 'main';
const REMOTE = 'origin';
const EXPECTED_REMOTE = process.env.PP_MANAGER_EXPECTED_REMOTE ?? 'https://github.com/pip-popper/pip-popper.github.io.git';
const LIVE_URL = 'https://pip-popper.github.io/';
// PRIVATE (Cloudflare Worker). HTTPS only; plain http is accepted only for the local imitation used by the tests.
const PRIVATE_URL = (() => {
  const u = new URL(process.env.PP_MANAGER_PRIVATE_URL ?? 'https://pip-popper-private.pip-popper-private.workers.dev/');
  if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('PRIVATE must be https');
  return u;
})();
const COMMIT_PREFIX = '[管理ツール]';
const TOKEN = randomBytes(24).toString('hex');
const WORK = path.join(ROOT, '.manager');            // previews, backups, log (ignored by .gitignore: only listed files are tracked)
const PREVIEW = path.join(WORK, 'preview');
const UI = path.join(HERE, 'ui');

// ── files the tool may change ─────────────────────────────────────────
const DATA_RE = /^(tracks\/[a-z0-9-]+\/(track\.json|cover-(web|640)\.jpg)|albums\/albums\.json|albums\/[a-z0-9-]+\/visual-(web|640)\.jpg|content\/site\.json)$/;
// names for the settings a new song brings with it (shown before publishing)
const TRACK_EXTRA_LABEL = { publicationClass: '公開区分', publicArchiveApproved: '公式HPへの掲載許可', lyricsScope: '歌詞の公開範囲', impressionScope: 'AIの感想の公開範囲', artwork: 'ジャケットのファイル名', links: '配信リンク', downloadUrl: 'ダウンロードURL' };
const VALUE_LABEL = { general: '一般公開', site: 'このサイトのみ', public: '一般公開' };
const valueLabel = v => typeof v === 'string' && Object.hasOwn(VALUE_LABEL, v) ? VALUE_LABEL[v] : v;
const IMAGE_RE = /^(tracks\/[a-z0-9-]+\/cover-(web|640)|albums\/[a-z0-9-]+\/visual-(web|640))\.jpg$/;   // only the display JPEGs a new song needs (2026-11-24)
const PUBLISH_RE = /^(tracks\/[a-z0-9-]+\/(track\.json|cover-(web|640)\.jpg)|albums\/albums\.json|albums\/[a-z0-9-]+\/visual-(web|640)\.jpg|content\/site\.json|docs\/.+)$/;

// ── Git ───────────────────────────────────────────────────────────────
function git(args, opts = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-c', `safe.directory=${SAFE_DIR}`, ...args], { cwd: ROOT, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 << 20, ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\s+$/, ''), err: (r.stderr ?? '').trim() };   // keep leading spaces (status codes)
}
const SAFE_DIR = ROOT.replace(/\\/g, '/');   // the folder may be moved or copied to another drive (2026-11-24)
const changedFiles = () => {
  const r = git(['status', '--porcelain=v1', '-uall']);
  return r.out ? r.out.split('\n').map(l => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() })) : [];
};
const currentBranch = () => git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
const remoteUrl = () => git(['remote', 'get-url', REMOTE]).out;
const normUrl = u => String(u).replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();

// ── JSON files (format preserved: indent detected, LF, trailing newline — verified byte-identical) ──
const sha = t => createHash('sha256').update(t).digest('hex').slice(0, 16);
async function readJson(rel) {
  const text = await readFile(path.join(ROOT, rel), 'utf8');
  const m = text.match(/^\{\r?\n( +)/);
  return { text, data: JSON.parse(text), indent: m ? m[1].length : 2, eol: text.includes('\r\n') ? '\r\n' : '\n', rev: sha(text) };
}
async function writeJsonAtomic(rel, data, indent, eol = '\n') {
  const file = path.join(ROOT, rel);
  const text = (JSON.stringify(data, null, indent) + '\n').replace(/\n/g, eol);   // the file's own line endings are kept
  JSON.parse(text);                                   // never write something that cannot be read back
  const bk = path.join(WORK, 'backup', new Date().toISOString().replace(/[:.]/g, '-'), rel);
  await mkdir(path.dirname(bk), { recursive: true });
  await copyFile(file, bk);                           // the previous version is kept before every save
  const tmp = `${file}.manager-tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
  return sha(text);
}

// ── what can be edited (text values only; ids, colours, image settings, links stay as they are) ──
const TRACK_FIELDS = [['title', '曲名', 'line', true], ['reading', '曲名のよみがな（あいうえお順の並び替えに使う。ひらがな。空欄なら曲名で並ぶ）', 'reading'], ['artist', 'アーティスト名', 'line'], ['aiImpression', '紹介文', 'text'], ['lyrics', '歌詞', 'lyrics'], ['background', '制作背景', 'text'],
  ['streamingUrl', '配信リンク（Spotify・YouTube・Suno・Apple Music のURL。空欄なら表示なし）', 'url']];
// the services build.mjs shows as a "…で聴く" button (other sites need a label, which v1 does not edit)
const LINK_HOSTS = ['open.spotify.com', 'spotify.link', 'suno.com', 'www.suno.com', 'app.suno.ai', 'suno.ai', 'www.youtube.com', 'youtube.com', 'youtu.be', 'music.youtube.com', 'music.apple.com'];
function linkProblem(v) {
  let u; try { u = new URL(v); } catch { return 'URLの形が正しくありません（https:// から入力してください）。'; }
  if (u.protocol !== 'https:') return 'URLは https:// で始まるものだけ登録できます。';
  if (!LINK_HOSTS.includes(u.hostname)) return 'Spotify・YouTube・Suno・Apple Music のURLだけ登録できます（ほかのサイトはAIに依頼してください）。';
  return null;
}
const ALBUM_SKIP = new Set(['id', 'section', 'accent', 'visual', 'music', 'date', 'listOrder', 'archive', 'titleLines', 'backdrop']);
const LABEL = {
  title: '作品名', subtitle: '副題', no: '上部の小見出し', kind: '区分', kindLabel: 'タイトル下の一行', year: '目次・一覧の年',
  dateLabel: '発表年の表示', yearLabel: '年の表示', sideLabel: '横の表示', lead: 'リード文', episode: '制作秘話', column: 'コラム',
  text: '本文', highlight: '強調する語句', titleHighlight: '見出しで強調する語句', closing: '締めの一文', closingAfter: '締めの後の文', note: '注記',
  tracks: '収録曲', members: '参加メンバー', name: '名前', role: '役割', membersLabel: 'メンバー欄の見出し', membersSource: 'メンバー欄の出典',
  info: '作品情報', archiveNote: '下部の注記', audioNote: '曲目の注記', caution: '注意欄', memo: 'メモ欄', items: '項目', strip: '補助画像の説明',
  works: '作品', tracksLabel: '曲目の見出し', credit: '参加者の行', label: 'ラベル', who: '参加者', quote: '引用', lines: '行', focus: '強調欄',
  letter: '文字', notes: '曲の解説', tracksHead: '曲目の見出し', kicker: '小見出し', sub: '副題', aside: '横の文', discs: 'ディスク',
  infoLabel: '作品情報の見出し', infoNote: '作品情報の注記', stripHead: '写真欄', captions: 'キャプション', em: '強調する語',
  afterword: 'あとがき', sign: '署名', story: '本文', statement: 'トップの一文', historyLead: 'トップのヒストリー欄の文',
  description: '検索結果に出る説明文', home: 'トップページ', history: 'ヒストリー', otherWorks: 'その他の作品', about: 'アーティスト紹介',
  message: 'メッセージ欄', track: '曲ページ（共通）',
};
function stringLeaves(value, p = [], skip = new Set()) {
  if (typeof value === 'string') return [p];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, [...p, i], skip));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => skip.has(k) ? [] : stringLeaves(v, [...p, k], skip));
  return [];
}
// "title" means the work's name at the top, a song name inside a track list, and a heading elsewhere
// content/site.json: each text named by where it appears on the site
const SITE_PAGES = ['home', 'history', 'otherWorks', 'about', 'message', 'track'];
const SITE_LABEL = {
  'home.statement': 'トップページの大きな一文（行）', 'home.historyLead': 'トップページ「ヒストリー」欄の説明文',
  'history.title': 'ヒストリーページの見出し（1行目・2行目。2行目は英字の太い書体）', 'history.lead': 'ヒストリーページの見出しの下の文',
  'history.description': '検索結果やSNSに出る説明文（ヒストリー）', 'history.endText': 'ヒストリーページのいちばん下の文',
  'otherWorks.title': 'その他の作品ページの見出し（1行目・2行目。2行目は英字の太い書体）', 'otherWorks.lead': 'その他の作品ページの見出しの下の文',
  'otherWorks.description': '検索結果やSNSに出る説明文（その他の作品）', 'otherWorks.endText': 'その他の作品ページのいちばん下の文',
  'about.text': 'アーティスト紹介の本文（段落。1段落目は大きな文字で、検索結果の説明文にも使われる）',
  'message.lead': 'トップページ「メッセージ」欄の説明文（行）',
  'track.privateCondLabel': '音源非公開の曲ページ：条件の見出し', 'track.privateCond': '音源非公開の曲ページ：条件の本文',
};
const siteLabel = (id, p) => (SITE_LABEL[`${id}.${p[0]}`] ?? labelOf(p)) + (typeof p[1] === 'number' ? ` › ${p[1] + 1}` : '');
const labelOf = p => p.map((k, i) => typeof k === 'number' ? `${k + 1}` : k === 'title' && i > 0 ? (['tracks', 'works'].includes(p[i - 2]) ? (p[i - 2] === 'works' ? '作品名' : '曲名') : '見出し') : (LABEL[k] ?? k)).join(' › ');
const getAt = (o, p) => p.reduce((v, k) => v?.[k], o);
function setAt(o, p, value) { const last = p[p.length - 1]; const parent = getAt(o, p.slice(0, -1)); if (parent == null || !(last in parent)) throw new Error('項目が見つかりません'); parent[last] = value; }
const kindOf = (p, v) => /lyrics/.test(p.join('.')) ? 'lyrics' : (v.length > 60 || v.includes('\n') ? 'text' : 'line');

async function listItems() {
  const archived = new Set((await readArchive()).map(a => `${a.type}:${a.id}`));
  const tracks = [];
  for (const id of (await readdir(path.join(ROOT, 'tracks'))).sort()) {
    const rel = `tracks/${id}/track.json`;
    if (!existsSync(path.join(ROOT, rel))) continue;
    const { data } = await readJson(rel);
    if (archived.has(`track:${id}`)) continue;
    tracks.push({ type: 'track', id, title: data.title, order: data.listOrder ?? 0, hidden: data.hidden === true });
  }
  tracks.sort((a, b) => b.order - a.order);
  const { data: { albums } } = await readJson('albums/albums.json');
  const al = albums.filter(a => !archived.has(`album:${a.id}`)).map(a => ({ type: 'album', id: a.id, title: a.title, year: a.year, group: a.section === 'other' ? 'other' : 'history', hidden: a.hidden === true }));
  const site = SITE_PAGES.map(id => ({ type: 'site', id, title: LABEL[id] }));
  return { tracks, history: al.filter(a => a.group === 'history'), other: al.filter(a => a.group === 'other'), site };
}
function fileOf(type, id) {
  if (type === 'track' && /^[a-z0-9-]+$/.test(id)) return `tracks/${id}/track.json`;
  if (type === 'album') return 'albums/albums.json';
  if (type === 'site') return 'content/site.json';
  throw new Error('対象が見つかりません');
}
async function loadItem(type, id) {
  const rel = fileOf(type, id);
  const f = await readJson(rel);
  let base, fields;
  if (type === 'track') {
    base = [];
    fields = TRACK_FIELDS.filter(([k]) => (k in f.data || k === 'reading') && (f.data[k] == null || typeof f.data[k] === 'string') && !(k === 'streamingUrl' && f.data.audioRelease === 'private'))
      .map(([k, label, kind, required]) => ({ path: [k], label, kind, required: !!required, nullable: f.data[k] === null || !required, value: f.data[k] ?? '' }));
  } else if (type === 'album') {
    const i = f.data.albums.findIndex(a => a.id === id);
    if (i < 0) throw new Error('アルバムが見つかりません');
    base = ['albums', i];
    fields = stringLeaves(f.data.albums[i], [], ALBUM_SKIP).map(p => {
      const v = getAt(f.data.albums[i], p);
      return { path: p, label: labelOf(p), kind: kindOf(p, v), required: p.length === 1 && p[0] === 'title', nullable: false, value: v };
    });
  } else {
    if (!(id in f.data)) throw new Error('対象が見つかりません');
    base = [id];
    fields = stringLeaves(f.data[id]).map(p => ({ path: p, label: siteLabel(id, p), kind: kindOf(p, getAt(f.data[id], p)), required: true, nullable: false, value: getAt(f.data[id], p) }));
  }
  const title = type === 'track' ? f.data.title : type === 'album' ? f.data.albums[base[1]].title : LABEL[id];
  const extra = type === 'track' ? { hidden: f.data.hidden === true }
    : type === 'album' ? (a => ({ hidden: a.hidden === true, section: a.section === 'other' ? 'other' : 'history', tracks: a.discs ? null : (a.tracks ?? []).map(t => ({ title: t.title, music: t.music ?? null })), hasJacket: existsSync(path.join(ROOT, 'albums', id, 'visual-web.jpg')), joint: !!a.works }))(f.data.albums[base[1]]) : {};
  return { type, id, file: rel, rev: f.rev, title, fields, base, ...extra };
}
async function saveItem({ type, id, rev, changes }) {
  const rel = fileOf(type, id);
  const f = await readJson(rel);
  if (f.rev !== rev) return { status: 409, body: { error: 'このデータは画面を開いた後に変更されています。いったん読み込み直してください（あなたの入力はまだ保存されていません）。' } };
  const item = await loadItem(type, id);
  const allowed = new Map(item.fields.map(fd => [JSON.stringify(fd.path), fd]));
  if (!Array.isArray(changes) || !changes.length) return { status: 400, body: { error: '変更がありません。' } };
  for (const c of changes) {
    const fd = allowed.get(JSON.stringify(c.path));
    if (!fd) return { status: 400, body: { error: '編集できない項目が含まれています。' } };
    if (typeof c.value !== 'string') return { status: 400, body: { error: '文字以外は保存できません。' } };
    const value = c.value.replace(/\r\n?/g, '\n');
    if (fd.required && !value.trim()) return { status: 400, body: { error: `「${fd.label}」は空にできません。` } };
    if (value.length > 20000) return { status: 400, body: { error: `「${fd.label}」が長すぎます。` } };
    if (fd.kind === 'url' && value.trim() && linkProblem(value.trim())) return { status: 400, body: { error: linkProblem(value.trim()) } };
    if (fd.kind === 'reading') { if (!validReading(value)) return { status: 400, body: { error: 'よみがなは、ひらがな・カタカナ・英数字で入力してください。' } }; f.data.reading = value.trim() || null; continue; }
    setAt(f.data, [...item.base, ...c.path], (fd.kind === 'url' ? value.trim() : value) === '' && fd.nullable && type === 'track' ? null : (fd.kind === 'url' ? value.trim() : value));
  }
  const newRev = await writeJsonAtomic(rel, f.data, f.indent, f.eol);
  return { status: 200, body: { ok: true, rev: newRev } };
}

// ── build (preview / publish) ─────────────────────────────────────────
function runBuild(outDir) {
  return new Promise(resolve => {
    const args = [path.join(ROOT, 'build.mjs')];
    if (outDir) args.push('--out', outDir);
    const p = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let log = '';
    p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
    p.on('close', code => {
      const msg = (log.match(/Error: ([^\n]+)/) ?? [])[1];
      resolve({ ok: code === 0, error: code === 0 ? null : (msg ? msg.replace(/[A-Z]:\\[^\s）)]+/g, '（ファイル）') : 'ページを作れませんでした。') });
    });
  });
}
const pageOf = (type, id, albumGroup) => type === 'track' ? `tracks/${id}/index.html`
  : type === 'album' ? `${albumGroup === 'other' ? 'other-works' : 'history'}/index.html#${id}`
  : ({ home: 'index.html', history: 'history/index.html', otherWorks: 'other-works/index.html', about: 'about/index.html', message: 'index.html#message', track: 'tracks/itoshi-no-honey/index.html' })[id] ?? 'index.html';

// ── unpublished changes, field by field ───────────────────────────────
async function headJson(rel) { const r = git(['show', `HEAD:${rel}`]); return r.ok ? JSON.parse(r.out) : null; }
async function describeChanges() {
  const files = changedFiles();
  const data = files.filter(f => DATA_RE.test(f.file));
  const other = files.filter(f => !DATA_RE.test(f.file));
  const items = [];
  for (const { file, code } of data) {
    if (IMAGE_RE.test(file)) {
      const isAlbum = file.startsWith('albums/'), key = file.split('/')[1];
      let title = key; try { title = isAlbum ? JSON.parse(await readFile(path.join(ROOT, 'albums', 'albums.json'), 'utf8')).albums.find(a => a.id === key)?.title ?? key : JSON.parse(await readFile(path.join(ROOT, path.dirname(file), 'track.json'), 'utf8')).title; } catch {}
      items.push({ path: [file], before: code.includes('?') || code.includes('A') ? '' : '（以前の画像）', after: file.endsWith('640.jpg') ? '一覧用の画像' : (isAlbum ? 'アルバムページ用の画像' : '曲ページ用の画像'), item: isAlbum ? `アルバム『${title}』` : `曲「${title}」`, label: code.includes('D') ? 'ジャケット画像（削除）' : 'ジャケット画像' });
      continue;
    }
    if (code.includes('D')) { items.push({ path: [file], before: file, after: '（削除）', item: file, label: 'ファイル' }); continue; }
    const now = JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
    const before = await headJson(file);
    const diffs = [];
    // every kind of value counts (text, yes/no such as 掲載停止, numbers); objects are compared field by field
    const isObj = v => v !== null && typeof v === 'object';
    const show = (v, p) => p.at(-1) === 'hidden' ? (v === true ? '掲載停止' : '掲載中') : v === undefined || v === null ? '' : isObj(v) ? '（項目）' : typeof v === 'boolean' ? (v ? 'はい' : 'いいえ') : valueLabel(String(v));
    const walk = (a, b, p) => {
      if (!isObj(a) && isObj(b)) a = Array.isArray(b) ? [] : {};
      if (isObj(a) && !isObj(b) && b === undefined) b = Array.isArray(a) ? [] : {};
      if (!isObj(a) || !isObj(b)) { if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) diffs.push({ path: p, before: show(a, p), after: show(b, p) }); return; }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], [...p, Array.isArray(b) ? Number(k) : k]);
    };
    if (file === 'albums/albums.json') {
      // albums are matched by their ID, so adding or moving one does not make every later album look changed
      const byId = d => new Map((d?.albums ?? []).map(a => [a.id, a]));
      const B = byId(before), N = byId(now);
      for (const [id, a] of N) {
        if (!B.has(id)) { items.push({ path: ['albums', id], before: '', after: `${a.section === 'other' ? 'その他の作品' : 'HISTORY'} に追加（収録曲 ${(a.tracks ?? []).length} 曲）`, item: `アルバム『${a.title}』`, label: '新しいアルバム' }); continue; }
        diffs.length = 0; walk(B.get(id), a, []);
        items.push(...diffs.map(d => ({ ...d, item: `アルバム『${a.title}』`, label: d.path.at(-1) === 'hidden' ? '掲載' : labelOf(d.path) })));
      }
      for (const [id, a] of B) if (!N.has(id)) items.push({ path: ['albums', id], before: a.title, after: '（データから削除）', item: `アルバム『${a.title}』`, label: 'アルバム' });
      for (const sec of ['history', 'other']) {
        const order = d => (d?.albums ?? []).filter(a => (a.section === 'other' ? 'other' : 'history') === sec && B.has(a.id) && N.has(a.id)).map(a => a.title);
        if (order(before).join('\n') !== order(now).join('\n')) items.push({ path: ['order', sec], before: order(before).join(' → '), after: order(now).join(' → '), item: sec === 'other' ? 'その他の作品の掲載順' : 'HISTORY の掲載順', label: '並び順' });
      }
      continue;
    }
    walk(before, now, []);
    const named = diffs.map(d => {
      if (file === 'content/site.json') return { ...d, item: `サイトの文言（${LABEL[d.path[0]] ?? d.path[0]}）`, label: siteLabel(d.path[0], d.path.slice(1)) };
      return { ...d, item: `曲「${now.title}」`, label: d.path[0] === 'hidden' ? '掲載' : (TRACK_FIELDS.find(t => t[0] === d.path[0]) ?? [, TRACK_EXTRA_LABEL[d.path[0]] ?? d.path.join('.')])[1] };
    });
    items.push(...named);
  }
  return { files: data.map(f => f.file), other: other.map(f => f.file), items };
}

// ── publish checks ────────────────────────────────────────────────────
// saved points on this PC that GitHub does not have yet, split into the manager's own and everything else
function unpushed() {
  const r = git(['log', '--format=%s', `${REMOTE}/${BRANCH}..HEAD`]);
  const subjects = r.ok && r.out ? r.out.split('\n') : [];
  return { tool: subjects.filter(s => s.startsWith(COMMIT_PREFIX)).length, other: subjects.filter(s => !s.startsWith(COMMIT_PREFIX)).length };
}
function publishProblems({ fetch = true } = {}) {
  const problems = [];
  // publishing pushes HEAD: never carry an AI's not-yet-approved work to the live site with it
  const up = unpushed();
  if (up.other) problems.push(`AI等の作業による、まだ公開していない保存点が ${up.other} 件あります。担当者の公開が終わるまで、管理ツールからは公開できません。`);
  if (currentBranch() !== BRANCH) problems.push(`作業中のブランチが ${BRANCH} ではありません。`);
  if (normUrl(remoteUrl()) !== normUrl(EXPECTED_REMOTE)) problems.push('送信先が公式サイトのリポジトリではありません。');
  const other = changedFiles().filter(f => !DATA_RE.test(f.file));
  if (other.length) problems.push(`管理ツール以外の変更が ${other.length} 件あります（AIなどの作業中の可能性）。作業を終えてから公開してください。`);
  if (fetch) {
    const fe = git(['fetch', REMOTE, BRANCH]);
    if (!fe.ok) problems.push('GitHubと通信できませんでした（インターネット接続を確認してください）。');
    else {
      const behind = git(['rev-list', '--count', `HEAD..${REMOTE}/${BRANCH}`]).out;
      if (behind !== '0') problems.push('GitHub側に、このパソコンにない新しい変更があります。担当者に連絡してください。');
    }
  }
  return problems;
}

async function publish({ summary }) {
  const ch = await describeChanges();
  if (!ch.files.length) return { status: 400, body: { error: '公開する変更がありません。' } };
  const problems = publishProblems();
  if (problems.length) return { status: 409, body: { error: problems.join('\n') } };
  const b = await runBuild(null);                                  // docs/ ← the real site
  if (!b.ok) { git(['checkout', '--', 'docs']); git(['clean', '-fdq', '--', 'docs']); return { status: 400, body: { error: `ページを作れませんでした：${b.error}` } }; }
  const files = changedFiles();
  const bad = files.filter(f => !PUBLISH_RE.test(f.file));
  if (bad.length) { git(['checkout', '--', 'docs']); return { status: 409, body: { error: '想定外のファイルが変わったため、公開を中止しました。' } }; }
  git(['add', '--', ...files.map(f => f.file)]);
  const staged = git(['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
  if (staged.some(f => !PUBLISH_RE.test(f))) { git(['reset', '-q']); return { status: 409, body: { error: '想定外のファイルが含まれたため、公開を中止しました。' } }; }
  const msg = `${COMMIT_PREFIX} ${String(summary || '文字情報の更新').slice(0, 120)}`;
  const c = git(['commit', '-q', '-m', msg]);
  if (!c.ok) { git(['reset', '-q']); return { status: 500, body: { error: '保存点（commit）を作れませんでした。' } }; }
  const head = git(['rev-parse', '--short', 'HEAD']).out;
  const p = git(['push', REMOTE, `${BRANCH}:${BRANCH}`]);
  if (!p.ok) return { status: 502, body: { error: `GitHubへの送信に失敗しました。変更はこのパソコンに保存点 ${head} として残っています。もう一度「公開する」を押すと送信だけをやり直します。`, head, pending: true } };
  log(`publish ${head} ${msg}`);
  return { status: 200, body: { ok: true, head, staged: staged.length, url: LIVE_URL } };
}
// a saved commit whose push failed earlier: send it again (only manager commits, nothing else waiting)
async function pushPending() {
  const ahead = git(['rev-list', '--count', `${REMOTE}/${BRANCH}..HEAD`]).out;
  if (ahead === '0') return { status: 400, body: { error: '送信待ちの保存点はありません。' } };
  const subjects = git(['log', '--format=%s', `${REMOTE}/${BRANCH}..HEAD`]).out.split('\n');
  if (subjects.some(s => !s.startsWith(COMMIT_PREFIX))) return { status: 409, body: { error: '管理ツール以外の保存点が送信待ちです。担当者に連絡してください。' } };
  const problems = publishProblems().filter(p => !p.startsWith('管理ツール以外の変更'));
  if (problems.length) return { status: 409, body: { error: problems.join('\n') } };
  const p = git(['push', REMOTE, `${BRANCH}:${BRANCH}`]);
  return p.ok ? { status: 200, body: { ok: true, url: LIVE_URL } } : { status: 502, body: { error: 'GitHubへの送信に失敗しました。時間をおいてもう一度お試しください。' } };
}

// ── history and undo ──────────────────────────────────────────────────
function history() {
  const r = git(['log', '-40', '--date=format:%Y-%m-%d %H:%M', `--format=%H%x1f%h%x1f%ad%x1f%s`, BRANCH]);
  const pushedRef = git(['rev-parse', '--verify', '-q', `${REMOTE}/${BRANCH}`]).ok;
  return r.out.split('\n').filter(Boolean).map(line => {
    const [full, short, date, subject] = line.split('\x1f');
    const files = git(['show', '--name-only', '--format=', full]).out.split('\n').filter(Boolean);
    const byTool = subject.startsWith(COMMIT_PREFIX);
    return { sha: short, date, subject, byTool, published: pushedRef && git(['merge-base', '--is-ancestor', full, `${REMOTE}/${BRANCH}`]).ok,
      undoable: byTool && files.every(f => PUBLISH_RE.test(f)) && files.some(f => DATA_RE.test(f)) };
  });
}
async function undo({ sha: s }) {
  if (!/^[0-9a-f]{7,40}$/.test(String(s))) return { status: 400, body: { error: '対象が正しくありません。' } };
  const h = history().find(x => x.sha === s || s.startsWith(x.sha));
  if (!h || !h.undoable) return { status: 400, body: { error: 'この保存点は管理ツールでは取り消せません。' } };
  if (changedFiles().length) return { status: 409, body: { error: '公開していない変更があります。先に「公開する」か「変更を破棄」をしてください。' } };
  const files = git(['show', '--name-only', '--format=', s]).out.split('\n').filter(f => DATA_RE.test(f));
  const patch = spawnSync('git', ['-c', 'core.quotepath=false', '-c', `safe.directory=${SAFE_DIR}`, 'diff', '--binary', `${s}^`, s, '--', ...files], { cwd: ROOT, windowsHide: true, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  const a = spawnSync('git', ['-c', `safe.directory=${SAFE_DIR}`, 'apply', '-R', '--binary', '--whitespace=nowarn'], { cwd: ROOT, windowsHide: true, input: patch, encoding: 'utf8' });
  if (a.status !== 0) return { status: 409, body: { error: 'その後に同じ箇所が変更されているため、自動では取り消せません。' } };
  return { status: 200, body: { ok: true, message: '取り消した内容を「公開していない変更」に入れました。プレビューで確認してから公開してください。' } };
}
async function discard() {
  const files = changedFiles().filter(f => DATA_RE.test(f.file)).map(f => f.file);
  if (!files.length) return { status: 400, body: { error: '破棄する変更はありません。' } };
  const bk = path.join(WORK, 'backup', `discard-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const added = new Set(changedFiles().filter(f => DATA_RE.test(f.file) && (f.code.includes('?') || f.code.includes('A'))).map(f => f.file));
  for (const f of files) { if (!existsSync(path.join(ROOT, f))) continue; await mkdir(path.dirname(path.join(bk, f)), { recursive: true }); await copyFile(path.join(ROOT, f), path.join(bk, f)); }
  if (added.size) { git(['reset', '-q', '--', ...added]); for (const f of added) await rm(path.join(ROOT, f), { force: true }); for (const d of new Set([...added].map(f => path.dirname(path.join(ROOT, f))))) { try { await rmdir(d); } catch {} } }
  const tracked = files.filter(f => !added.has(f));
  const r = tracked.length ? git(['checkout', 'HEAD', '--', ...tracked]) : { ok: true };
  return r.ok ? { status: 200, body: { ok: true, count: files.length } } : { status: 500, body: { error: '元に戻せませんでした。' } };
}

// ── PRIVATE: invitee password (2026-11-22) ────────────────────────────
// The administrator password typed on the screen is used only inside one call: sign in to the PRIVATE admin screen
// (same as the web form, with its lockout), call the change API (which checks the administrator password again and
// counts attempts), then sign out. Nothing is stored, logged or kept in memory afterwards. No Cloudflare API token.
async function privateCall(adminPassword, apiPath, payload) {
  if (typeof adminPassword !== 'string' || !adminPassword) return { status: 400, body: { error: '管理者パスワードを入力してください。' } };
  let cookie = null;
  try {
    const login = await fetch(new URL('admin/login', PRIVATE_URL), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: adminPassword }) });
    if (login.status === 401) return { status: 403, body: { error: '管理者パスワードが違います。' } };
    if (login.status === 429) return { status: 429, body: { error: '入力の回数が多すぎるため、一時的にロックされています。しばらく時間をおいてからお試しください。' } };
    if (login.status === 503) return { status: 503, body: { error: 'PRIVATEの管理画面が準備中です（管理者パスワードがCloudflareに設定されていません）。' } };
    cookie = login.status === 303 ? (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).find(c => /^pp_admin=.+/.test(c)) : null;
    if (!cookie) return { status: 502, body: { error: 'PRIVATEに入室できませんでした。時間をおいてお試しください。' } };
    const r = await fetch(new URL(`admin/api/${apiPath}`, PRIVATE_URL), { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { Cookie: cookie, 'X-PP-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, adminPassword }) });
    let data = {}; try { data = await r.json(); } catch {}
    if (r.status === 404) return { status: 501, body: { error: 'PRIVATE側がまだこの機能に対応していません（Cloudflareへの更新前）。今のパスワードのままです。' } };
    return r.ok ? { status: 200, body: { ok: true, mode: data.mode, changedAt: data.changedAt ?? null, message: data.message } }
      : { status: r.status, body: { error: data.error ?? 'PRIVATEで処理できませんでした。今のパスワードのままです。' } };
  } catch {
    return { status: 502, body: { error: 'PRIVATEに接続できませんでした（インターネット接続を確認してください）。今のパスワードのままです。' } };
  } finally {
    if (cookie) fetch(new URL('admin/logout', PRIVATE_URL), { method: 'POST', redirect: 'manual', headers: { Cookie: cookie } }).catch(() => {});
  }
}
async function changePrivatePassword({ newPassword, confirmPassword, adminPassword }) {
  if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string') return { status: 400, body: { error: '新しいパスワードを入力してください。' } };
  if (newPassword !== confirmPassword) return { status: 400, body: { error: '新しいパスワードと確認用が一致しません。' } };
  if (newPassword.length < 8 || newPassword.length > 200) return { status: 400, body: { error: '新しいパスワードは8〜200文字にしてください。' } };
  if (newPassword !== newPassword.trim()) return { status: 400, body: { error: '新しいパスワードの最初と最後に空白を入れないでください。' } };
  return privateCall(adminPassword, 'private-password', { newPassword });
}
const restorePrivatePassword = ({ adminPassword, confirm }) => privateCall(adminPassword, 'private-password/restore', { confirm });

// The inventory is held only in this local server process. Lyrics and credentials
// are not part of the release-status data returned or persisted.
let releasePrivateRows = null;
async function releaseStatusList(body) {
  if (body?.adminPassword !== undefined) {
    releasePrivateRows = null;
    const result = await privateLyricsCall(PRIVATE_URL, body);
    if (result.status !== 200) return result;
    releasePrivateRows = sanitizePrivateRows(result.body.songs);
  }
  return { status: 200, body: await listReleaseStatus(ROOT, releasePrivateRows) };
}


// ── 2026-11-24: structure operations on the published data (all become "公開していない変更" first) ──
// Nothing is erased: a hidden song/album keeps its files and data; "管理一覧から外す" only hides it in this tool
// (.manager/archived.json, restorable). Album track edits keep every existing track object as it is.
const ARCHIVE = () => path.join(WORK, 'archived.json');
async function readArchive() { try { return JSON.parse(await readFile(ARCHIVE(), 'utf8')); } catch { return []; } }
async function writeArchive(list) { await mkdir(WORK, { recursive: true }); const tmp = `${ARCHIVE()}.tmp`; await writeFile(tmp, JSON.stringify(list, null, 2) + '\n'); await rename(tmp, ARCHIVE()); }
const stale = () => ({ status: 409, body: { error: 'このデータは画面を開いた後に変更されています。読み込み直してください。' } });
async function albumsFile(rev) { const f = await readJson('albums/albums.json'); if (rev !== undefined && f.rev !== rev) return null; return f; }
async function setHidden({ type, id, rev, hidden, confirm }) {
  if (confirm !== true || typeof hidden !== 'boolean') return { status: 400, body: { error: '確認が必要です。' } };
  if (type === 'track') {
    if (!/^[a-z0-9-]+$/.test(id ?? '')) return { status: 400, body: { error: '対象が正しくありません。' } };
    const rel = `tracks/${id}/track.json`, f = await readJson(rel);
    if (f.rev !== rev) return stale();
    if (hidden) f.data.hidden = true; else delete f.data.hidden;
    return { status: 200, body: { ok: true, rev: await writeJsonAtomic(rel, f.data, f.indent, f.eol) } };
  }
  if (type === 'album') {
    const f = await albumsFile(rev); if (!f) return stale();
    const a = f.data.albums.find(x => x.id === id); if (!a) return { status: 404, body: { error: 'アルバムが見つかりません。' } };
    if (hidden) a.hidden = true; else delete a.hidden;
    return { status: 200, body: { ok: true, rev: await writeJsonAtomic('albums/albums.json', f.data, f.indent, f.eol) } };
  }
  return { status: 400, body: { error: '対象が正しくありません。' } };
}
async function moveAlbum({ id, rev, dir }) {
  const f = await albumsFile(rev); if (!f) return stale();
  const list = f.data.albums, i = list.findIndex(a => a.id === id);
  if (i < 0 || ![-1, 1].includes(dir)) return { status: 400, body: { error: '対象が正しくありません。' } };
  const group = a => a.section === 'other' ? 'other' : 'history';
  let j = i + dir; while (j >= 0 && j < list.length && group(list[j]) !== group(list[i])) j += dir;   // next one in the same page
  if (j < 0 || j >= list.length) return { status: 400, body: { error: dir < 0 ? 'すでに先頭です。' : 'すでに最後です。' } };
  [list[i], list[j]] = [list[j], list[i]];
  return { status: 200, body: { ok: true, rev: await writeJsonAtomic('albums/albums.json', f.data, f.indent, f.eol) } };
}
async function albumTracks({ id, rev, op, index, dir, title, music, confirm }) {
  const f = await albumsFile(rev); if (!f) return stale();
  const a = f.data.albums.find(x => x.id === id); if (!a) return { status: 404, body: { error: 'アルバムが見つかりません。' } };
  if (a.discs || a.works || !Array.isArray(a.tracks)) return { status: 400, body: { error: 'この作品（ディスク別・複数作品の構成）の収録曲はAIに依頼してください。' } };
  const t = a.tracks;
  if (op === 'move') { const j = index + dir; if (!Number.isInteger(index) || ![-1, 1].includes(dir) || index < 0 || j < 0 || j >= t.length) return { status: 400, body: { error: '動かせません。' } }; [t[index], t[j]] = [t[j], t[index]]; }
  else if (op === 'remove') { if (confirm !== true || !Number.isInteger(index) || !t[index]) return { status: 400, body: { error: '確認が必要です。' } }; if (t.length === 1) return { status: 400, body: { error: '収録曲を0曲にはできません（掲載を止めるときは「掲載を停止」）。' } }; t.splice(index, 1); }
  else if (op === 'add') {
    if (typeof title !== 'string' || !title.trim() || title.length > 150) return { status: 400, body: { error: '曲名を入力してください。' } };
    if (music && (!/^[a-z0-9-]+$/.test(music) || !existsSync(path.join(ROOT, 'tracks', music, 'track.json')))) return { status: 400, body: { error: '公式サイトの曲が見つかりません。' } };
    t.push(music ? { title: title.trim(), music } : { title: title.trim() });
  } else return { status: 400, body: { error: '操作が正しくありません。' } };
  return { status: 200, body: { ok: true, rev: await writeJsonAtomic('albums/albums.json', f.data, f.indent, f.eol) } };
}
async function albumJacket({ id, image, confirm }) {
  if (confirm !== true || !/^[a-z0-9-]+$/.test(id ?? '')) return { status: 400, body: { error: '確認が必要です。' } };
  const { data } = await readJson('albums/albums.json'); const a = data.albums.find(x => x.id === id);
  if (!a) return { status: 404, body: { error: 'アルバムが見つかりません。' } };
  if (a.works) return { status: 400, body: { error: '複数作品の構成のジャケットはAIに依頼してください。' } };
  let img; try { img = checkImages(image); } catch (e) { return { status: 400, body: { error: e.message } }; }
  if (!img) return { status: 400, body: { error: '画像を選んでください。' } };
  const folder = path.join(ROOT, 'albums', id); await mkdir(folder, { recursive: true });
  for (const [name, bytes] of [['visual-web.jpg', img.web.bytes], ['visual-640.jpg', img.thumb.bytes]]) {
    const target = path.join(folder, name);
    if (existsSync(target)) { const bk = path.join(WORK, 'backup', new Date().toISOString().replace(/[:.]/g, '-'), 'albums', id, name); await mkdir(path.dirname(bk), { recursive: true }); await copyFile(target, bk); }
    await writeFile(`${target}.tmp`, bytes); await rename(`${target}.tmp`, target);
  }
  return { status: 200, body: { ok: true } };
}
async function adoptAlbum({ id, rev, slug, confirm }) {
  if (confirm !== true) return { status: 400, body: { error: '取り込み前の確認が必要です。' } };
  const src = await adoptionSource(ROOT, id, rev); if (src.error) return src.error;
  const pub = (await albumGet(ROOT, id, registrationCtx)).body.publication;
  if (['adopted', 'published'].includes(pub?.state)) return { status: 409, body: { error: `このアルバムはすでに取り込み済みです（${pub.slug}）。` } };
  slug = String(slug ?? '').trim();
  if (!ALBUM_SLUG.test(slug) || slug.length > 60) return { status: 400, body: { error: 'ページのURL名は英小文字・数字・ハイフンで入力してください（例：new-album-2026）。' } };
  const f = await readJson('albums/albums.json');
  if (f.data.albums.some(a => a.id === slug) || existsSync(path.join(ROOT, 'albums', slug))) return { status: 409, body: { error: '同じURL名のアルバムがすでにあります。別の名前にしてください。' } };
  const r = src.record, paras = t => t.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const entry = { id: slug, ...(r.section === 'other' ? { section: 'other' } : {}), no: 'PIP POPPER', kind: r.kind, year: r.year || '—', date: null, dateLabel: r.dateLabel || null,
    title: r.title, subtitle: r.subtitle || null, accent: '#ec2630', visual: { source: `管理ツールで登録（albums/${slug}/visual-web.jpg）`, adopted: `${new Date().toISOString().slice(0, 10)} 管理ツールで取り込み` },
    info: r.links.map(u => ['配信', u]), ...(paras(r.intro).length ? { episode: { title: 'アルバム紹介', text: paras(r.intro) } } : {}),
    ...(paras(r.story).length ? { column: { title: '制作秘話', text: paras(r.story) } } : {}), tracks: r.tracks.map(t => ({ ...t })), archive: false };
  // a new album goes at the end of its own page (the order can be changed afterwards)
  let at = f.data.albums.length; for (let i = f.data.albums.length - 1; i >= 0; i--) if ((f.data.albums[i].section === 'other') === (r.section === 'other')) { at = i + 1; break; }
  const folder = path.join(ROOT, 'albums', slug); await mkdir(folder);
  try {
    await copyFile(src.web, path.join(folder, 'visual-web.jpg')); await copyFile(src.thumb, path.join(folder, 'visual-640.jpg'));
    f.data.albums.splice(at, 0, entry);
    await writeJsonAtomic('albums/albums.json', f.data, f.indent, f.eol);
  } catch (e) { await rm(folder, { recursive: true, force: true }); throw e; }
  await markAlbumAdopted(ROOT, id, slug);
  return albumGet(ROOT, id, registrationCtx);
}
async function archiveItem({ type, id, archive, confirm }) {
  if (confirm !== true || !['track', 'album'].includes(type) || !/^[a-z0-9-]+$/.test(id ?? '')) return { status: 400, body: { error: '確認が必要です。' } };
  const list = await readArchive(), key = x => `${x.type}:${x.id}`;
  if (archive) {
    const hidden = type === 'track' ? (await readJson(`tracks/${id}/track.json`)).data.hidden === true : (await readJson('albums/albums.json')).data.albums.find(a => a.id === id)?.hidden === true;
    if (!hidden) return { status: 409, body: { error: '先に「掲載を停止」して公開してから、一覧から外してください。' } };
    if (!list.some(x => key(x) === `${type}:${id}`)) list.push({ type, id, at: new Date().toISOString() });
  } else { const i = list.findIndex(x => key(x) === `${type}:${id}`); if (i >= 0) list.splice(i, 1); }
  await writeArchive(list);
  return { status: 200, body: { ok: true } };
}
async function archivedList() {
  const out = [];
  for (const a of await readArchive()) {
    try { const title = a.type === 'track' ? (await readJson(`tracks/${a.id}/track.json`)).data.title : (await readJson('albums/albums.json')).data.albums.find(x => x.id === a.id)?.title; if (title) out.push({ ...a, title }); } catch {}
  }
  return out;
}

// a song counts as published only when GitHub's main (as last fetched) has its track.json
const registrationCtx = { isPublished: async slug => git(['cat-file', '-e', `${REMOTE}/${BRANCH}:tracks/${slug}/track.json`]).ok,
  albumHere: async slug => { try { return (await readJson('albums/albums.json')).data.albums.some(a => a.id === slug); } catch { return false; } },
  albumPublished: async slug => { const r = git(['show', `${REMOTE}/${BRANCH}:albums/albums.json`]); try { return r.ok && JSON.parse(r.out).albums.some(a => a.id === slug); } catch { return false; } } };

// ── HTTP ──────────────────────────────────────────────────────────────
async function log(line) { try { await mkdir(WORK, { recursive: true }); await writeFile(path.join(WORK, 'manager.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' }); } catch {} }
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
async function serveFile(res, base, rel) {
  const file = path.resolve(base, decodeURIComponent(rel));
  if (!file.startsWith(path.resolve(base))) return send(res, 404, 'Not found', 'text/plain');
  try { const st = await stat(file); const f = st.isDirectory() ? path.join(file, 'index.html') : file; send(res, 200, await readFile(f), TYPES[path.extname(f)] ?? 'application/octet-stream'); }
  catch { send(res, 404, 'Not found', 'text/plain'); }
}
let busy = false;                                                    // one write at a time
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, 'Forbidden', 'text/plain');
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/preview/')) return serveFile(res, PREVIEW, url.pathname.slice('/preview/'.length) || 'index.html');
    if (!url.pathname.startsWith('/api/')) return serveFile(res, UI, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (req.headers['x-pp-token'] !== TOKEN) return send(res, 403, { error: 'もう一度、起動用のファイルから開いてください。' });
    let body = {};
    if (req.method === 'POST') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: '形式が正しくありません。' });
      const limit=['/api/song-registration/save','/api/album-registration/save','/api/album/jacket'].includes(url.pathname)?30e6:2e6;let length=0;const chunks=[];
      for await(const c of req){length+=c.length;if(length>limit)return send(res,413,{error:'大きすぎます。'});chunks.push(c);}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(res, 400, { error: '形式が正しくありません。' }); }   // never logged: a body may hold a password
    }
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') {
      const ch = await describeChanges();
      const up = unpushed();
      return send(res, 200, { list: await listItems(), registrations:await listRegistrations(ROOT,registrationCtx), albumRegistrations: await listAlbumRegistrations(ROOT, registrationCtx), deletedRegistrations: [...await listRegistrations(ROOT, registrationCtx, { deleted: true }), ...(await listAlbumRegistrations(ROOT, registrationCtx, { deleted: true })).map(a => ({ ...a, kind: 'album' }))], archived: await archivedList(), changes: ch, branch: currentBranch(), head: git(['rev-parse', '--short', 'HEAD']).out,
        pendingPush: up.tool, otherUnpushed: up.other, liveUrl: LIVE_URL, privateUrl: PRIVATE_URL.href, remoteOk: normUrl(remoteUrl()) === normUrl(EXPECTED_REMOTE) });
    }
    if (route === 'GET /api/item') return send(res, 200, await loadItem(url.searchParams.get('type'), url.searchParams.get('id')));
    if (route === 'GET /api/history') return send(res, 200, { history: history() });
    if (req.method !== 'POST') return send(res, 404, { error: '見つかりません。' });
    if (busy) return send(res, 409, { error: '前の操作を処理中です。少し待ってください。' });
    busy = true;
    try {
      let r;
      if (route === 'POST /api/item') r = await saveItem(body);
      else if (route === 'POST /api/preview') {
        await rm(PREVIEW, { recursive: true, force: true });
        const b = await runBuild(PREVIEW);
        const item = body.type === 'album' ? (await listItems()) : null;
        const group = item ? [...item.history, ...item.other].find(a => a.id === body.id)?.group : null;
        r = b.ok ? { status: 200, body: { ok: true, url: `/preview/${pageOf(body.type, body.id, group)}` } } : { status: 400, body: { error: `プレビューを作れませんでした：${b.error}` } };
      }
      else if (route === 'POST /api/discard') r = body.confirm === true ? await discard() : { status: 400, body: { error: '確認が必要です。' } };
      else if (route === 'POST /api/publish') r = body.confirm === true ? await publish(body) : { status: 400, body: { error: '確認が必要です。' } };
      else if (route === 'POST /api/push-pending') r = body.confirm === true ? await pushPending() : { status: 400, body: { error: '確認が必要です。' } };
      else if (route === 'POST /api/undo') r = await undo(body);
      else if (route === 'POST /api/check-publish') r = { status: 200, body: { problems: publishProblems() } };
      else if (route === 'POST /api/private/password') r = await changePrivatePassword(body);
      else if (route === 'POST /api/private/restore') r = await restorePrivatePassword(body);
      else if (route === 'POST /api/private/lyrics/list') r = await privateLyricsCall(PRIVATE_URL, body);
      else if (route === 'POST /api/private/lyrics/save') {
        r = await privateLyricsCall(PRIVATE_URL, body, true);
        if (r.status === 200 && releasePrivateRows) {
          const cached = releasePrivateRows.find(row => row.id === r.body.song.id);
          if (cached) cached.privateLyrics = !!r.body.song.lyrics.trim();
        }
      }
      else if (route === 'POST /api/release-status/list') r = await releaseStatusList(body);
      else if (route === 'POST /api/release-status/save') r = await saveReleaseStatus(ROOT, releasePrivateRows, body);
      else if (route.startsWith('POST /api/song-registration/')) r = await registrationAction(ROOT,url.pathname.slice('/api/song-registration/'.length),body,registrationCtx);
      else if (route === 'POST /api/album-registration/adopt') r = await adoptAlbum(body);
      else if (route.startsWith('POST /api/album-registration/')) r = await albumRegistrationAction(ROOT, url.pathname.slice('/api/album-registration/'.length), body, registrationCtx);
      else if (route === 'POST /api/fetch-status') r = { status: 200, body: { ok: git(['fetch', REMOTE, BRANCH], { timeout: 15000 }).ok } };   // read GitHub's state only (no files change)
      else if (route === 'POST /api/hidden') r = await setHidden(body);
      else if (route === 'POST /api/album/move') r = await moveAlbum(body);
      else if (route === 'POST /api/album/tracks') r = await albumTracks(body);
      else if (route === 'POST /api/album/jacket') r = await albumJacket(body);
      else if (route === 'POST /api/archive') r = await archiveItem(body);
      else if (route === 'POST /api/quit') { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return; }
      else r = { status: 404, body: { error: '見つかりません。' } };
      // the log names the operation only (for PRIVATE: whether it succeeded); input values are never written
      if (route.startsWith('POST /api/private/') || route.startsWith('POST /api/release-status/') || route.startsWith('POST /api/song-registration/') || route.startsWith('POST /api/album-registration/') || route === 'POST /api/album/jacket') log(`${route} status=${r.status}`);
      else if (r.status === 200) log(`${route} ${JSON.stringify({ type: body.type, id: body.id, sha: body.sha })}`);
      return send(res, r.status, r.body);
    } finally { busy = false; }
  } catch (e) {
    log(`error ${req.url?.startsWith('/api/private/') || req.url?.startsWith('/api/release-status/') || req.url?.startsWith('/api/song-registration/') ? 'in private management operation' : (e?.stack ?? e)}`);
    return send(res, 500, { error: '処理できませんでした。もう一度お試しください。' });
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log('\n管理ツールはすでに起動しています。開いているブラウザのタブを使ってください。\n（見つからない場合は、黒い画面を閉じてから起動し直してください）');
  else console.log('起動できませんでした：', e.message);
  process.exit(1);
});
// The EXE owns this pipe. If it disappears unexpectedly, its own server exits too.
if (process.argv.includes('--launcher')) {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
// 2026-11-24: the manager folder can be copied (PIP POPPER管理ツール一式). When this copy has no unpublished
// changes and nothing unsent, take in what was published from elsewhere (fast-forward only, never a merge).
function syncFromGitHub() {
  if (process.env.PP_MANAGER_NO_SYNC) return;
  if (changedFiles().length || currentBranch() !== BRANCH || normUrl(remoteUrl()) !== normUrl(EXPECTED_REMOTE)) return;
  if (!git(['fetch', REMOTE, BRANCH], { timeout: 15000 }).ok) return;
  if (git(['rev-list', '--count', `${REMOTE}/${BRANCH}..HEAD`]).out !== '0') return;
  if (git(['rev-list', '--count', `HEAD..${REMOTE}/${BRANCH}`]).out === '0') return;
  const m = git(['merge', '--ff-only', '-q', `${REMOTE}/${BRANCH}`]);
  log(`sync from GitHub ${m.ok ? 'ok' : 'failed'}`);
}
try { syncFromGitHub(); } catch {}
server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;
  const open = `http://127.0.0.1:${PORT}/#t=${TOKEN}`;
  console.log('PIP POPPER 管理ツールを起動しました。');
  console.log('この黒い画面は、管理ツールを使っている間は閉じないでください（閉じると終了します）。');
  console.log(`ブラウザが開かないときは、次のアドレスを開いてください：\n${open}`);
  log(`start root=${ROOT}`);
  if (OPEN) spawn('cmd.exe', ['/c', 'start', '', open], { detached: true, stdio: 'ignore' }).unref();
  if (process.env.PP_MANAGER_PRINT_TOKEN) console.log(`TOKEN=${TOKEN}`);
});
