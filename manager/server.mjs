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
import { readFile, writeFile, rename, mkdir, readdir, stat, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const ROOT = path.resolve(arg('--root') ?? path.join(HERE, '..'));
const PORT = Number(arg('--port') ?? 18990);
const OPEN = !process.argv.includes('--no-open') && !process.env.PP_MANAGER_NO_OPEN;   // the env form is for checking the BAT without opening a browser
const BRANCH = 'main';
const REMOTE = 'origin';
const EXPECTED_REMOTE = process.env.PP_MANAGER_EXPECTED_REMOTE ?? 'https://github.com/pip-popper/pip-popper.github.io.git';
const LIVE_URL = 'https://pip-popper.github.io/';
const COMMIT_PREFIX = '[管理ツール]';
const TOKEN = randomBytes(24).toString('hex');
const WORK = path.join(ROOT, '.manager');            // previews, backups, log (ignored by .gitignore: only listed files are tracked)
const PREVIEW = path.join(WORK, 'preview');
const UI = path.join(HERE, 'ui');

// ── files the tool may change ─────────────────────────────────────────
const DATA_RE = /^(tracks\/[a-z0-9-]+\/track\.json|albums\/albums\.json|content\/site\.json)$/;
const PUBLISH_RE = /^(tracks\/[a-z0-9-]+\/track\.json|albums\/albums\.json|content\/site\.json|docs\/.+)$/;

// ── Git ───────────────────────────────────────────────────────────────
function git(args, opts = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 << 20, ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? '').replace(/\s+$/, ''), err: (r.stderr ?? '').trim() };   // keep leading spaces (status codes)
}
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
const TRACK_FIELDS = [['title', '曲名', 'line', true], ['artist', 'アーティスト名', 'line'], ['aiImpression', '紹介文', 'text'], ['lyrics', '歌詞', 'lyrics'], ['background', '制作背景', 'text'],
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
  const tracks = [];
  for (const id of (await readdir(path.join(ROOT, 'tracks'))).sort()) {
    const rel = `tracks/${id}/track.json`;
    if (!existsSync(path.join(ROOT, rel))) continue;
    const { data } = await readJson(rel);
    tracks.push({ type: 'track', id, title: data.title, order: data.listOrder ?? 0 });
  }
  tracks.sort((a, b) => b.order - a.order);
  const { data: { albums } } = await readJson('albums/albums.json');
  const al = albums.map(a => ({ type: 'album', id: a.id, title: a.title, year: a.year, group: a.section === 'other' ? 'other' : 'history' }));
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
    fields = TRACK_FIELDS.filter(([k]) => k in f.data && (f.data[k] === null || typeof f.data[k] === 'string') && !(k === 'streamingUrl' && f.data.audioRelease === 'private'))
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
  return { type, id, file: rel, rev: f.rev, title, fields, base };
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
    const p = spawn(process.execPath, args, { cwd: ROOT });
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
  for (const { file } of data) {
    const now = JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
    const before = await headJson(file);
    const diffs = [];
    const walk = (a, b, p) => {
      if (typeof b === 'string' || b === null || typeof a === 'string') { if (a !== b) diffs.push({ path: p, before: a ?? '', after: b ?? '' }); return; }
      if (b && typeof b === 'object') for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b)])) walk(a?.[k], b[k], [...p, Array.isArray(b) ? Number(k) : k]);
    };
    walk(before, now, []);
    const named = diffs.map(d => {
      if (file === 'albums/albums.json') { const al = now.albums[d.path[1]]; return { ...d, item: `アルバム『${al?.title ?? '?'}』`, label: labelOf(d.path.slice(2)) }; }
      if (file === 'content/site.json') return { ...d, item: `サイトの文言（${LABEL[d.path[0]] ?? d.path[0]}）`, label: siteLabel(d.path[0], d.path.slice(1)) };
      return { ...d, item: `曲「${now.title}」`, label: (TRACK_FIELDS.find(t => t[0] === d.path[0]) ?? [, d.path.join('.')])[1] };
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
  const patch = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', `${s}^`, s, '--', ...files], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  const a = spawnSync('git', ['apply', '-R', '--whitespace=nowarn'], { cwd: ROOT, input: patch, encoding: 'utf8' });
  if (a.status !== 0) return { status: 409, body: { error: 'その後に同じ箇所が変更されているため、自動では取り消せません。' } };
  return { status: 200, body: { ok: true, message: '取り消した内容を「公開していない変更」に入れました。プレビューで確認してから公開してください。' } };
}
async function discard() {
  const files = changedFiles().filter(f => DATA_RE.test(f.file)).map(f => f.file);
  if (!files.length) return { status: 400, body: { error: '破棄する変更はありません。' } };
  const bk = path.join(WORK, 'backup', `discard-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const f of files) { await mkdir(path.dirname(path.join(bk, f)), { recursive: true }); await copyFile(path.join(ROOT, f), path.join(bk, f)); }
  const r = git(['checkout', 'HEAD', '--', ...files]);
  return r.ok ? { status: 200, body: { ok: true, count: files.length } } : { status: 500, body: { error: '元に戻せませんでした。' } };
}

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
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 2e6) return send(res, 413, { error: '大きすぎます。' }); }
      body = JSON.parse(raw || '{}');
    }
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/state') {
      const ch = await describeChanges();
      const up = unpushed();
      return send(res, 200, { list: await listItems(), changes: ch, branch: currentBranch(), head: git(['rev-parse', '--short', 'HEAD']).out,
        pendingPush: up.tool, otherUnpushed: up.other, liveUrl: LIVE_URL, remoteOk: normUrl(remoteUrl()) === normUrl(EXPECTED_REMOTE) });
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
      else if (route === 'POST /api/quit') { send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return; }
      else r = { status: 404, body: { error: '見つかりません。' } };
      if (r.status === 200) log(`${route} ${JSON.stringify({ type: body.type, id: body.id, sha: body.sha })}`);
      return send(res, r.status, r.body);
    } finally { busy = false; }
  } catch (e) {
    log(`error ${e?.stack ?? e}`);
    return send(res, 500, { error: '処理できませんでした。もう一度お試しください。' });
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.log('\n管理ツールはすでに起動しています。開いているブラウザのタブを使ってください。\n（見つからない場合は、黒い画面を閉じてから起動し直してください）');
  else console.log('起動できませんでした：', e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  const open = `http://127.0.0.1:${PORT}/#t=${TOKEN}`;
  console.log('PIP POPPER 管理ツールを起動しました。');
  console.log('この黒い画面は、管理ツールを使っている間は閉じないでください（閉じると終了します）。');
  console.log(`ブラウザが開かないときは、次のアドレスを開いてください：\n${open}`);
  log(`start root=${ROOT}`);
  if (OPEN) spawn('cmd.exe', ['/c', 'start', '', open], { detached: true, stdio: 'ignore' }).unref();
  if (process.env.PP_MANAGER_PRINT_TOKEN) console.log(`TOKEN=${TOKEN}`);
});
