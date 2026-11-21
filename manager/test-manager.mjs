// 管理ツールの自動テスト（本物のGitHub・本物の作業フォルダーには触れない）。
// 使い方：node manager/test-manager.mjs
// 一時フォルダーに「検証用の送信先（bare リポジトリ）」と「作業コピー」を作り、現在の作業フォルダーの
// build.mjs・content・manager を作業コピーへ入れてから、管理ツールのサーバーをその作業コピーに対して起動する。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ppm-test-'));
const BARE = path.join(TMP, 'remote.git'), WORK = path.join(TMP, 'work'), OTHER = path.join(TMP, 'other');
const PORT = 18991;
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...a], { cwd, encoding: 'utf8' }); return (r.stdout ?? '').trim(); };
const gOk = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).status === 0;

console.log('準備：検証用の送信先と作業コピーを作成');
spawnSync('git', ['clone', '-q', '--bare', REPO, BARE]);
spawnSync('git', ['clone', '-q', BARE, WORK]);
for (const p of ['build.mjs', 'content', 'manager']) cpSync(path.join(REPO, p), path.join(WORK, p), { recursive: true });
g(WORK, 'config', 'user.name', 'Producer'); g(WORK, 'config', 'user.email', 'test@example.invalid');
g(WORK, 'add', '-f', 'build.mjs', 'content', 'manager'); g(WORK, 'commit', '-q', '-m', 'test base'); g(WORK, 'push', '-q', 'origin', 'main');
g(WORK, 'branch', '-q', '-u', 'origin/main');

const env = { ...process.env, PP_MANAGER_EXPECTED_REMOTE: BARE, PP_MANAGER_PRINT_TOKEN: '1' };
const srv = spawn(process.execPath, [path.join(WORK, 'manager', 'server.mjs'), '--root', WORK, '--no-open', '--port', String(PORT)], { env });
const token = await new Promise((res, rej) => { let out = ''; srv.stdout.on('data', d => { out += d; const m = out.match(/TOKEN=([0-9a-f]+)/); if (m) res(m[1]); }); setTimeout(() => rej(new Error('server did not start')), 15000); });
const base = `http://127.0.0.1:${PORT}`;
const call = async (method, p, body, headers = {}) => {
  if (method === 'POST') body = body ?? {};                      // same as the screen (manager/ui/app.js)
  const r = await fetch(base + p, { method, headers: { 'X-PP-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const read = rel => readFileSync(path.join(WORK, rel), 'utf8');
const status = () => g(WORK, 'status', '--porcelain=v1', '-uall');

try {
  console.log('1. 安全確認');
  ok((await fetch(base + '/api/state')).status === 403, '合言葉なしの要求は拒否');
  ok((await call('GET', '/api/state', null, { 'X-PP-Token': 'x' })).status === 403, '違う合言葉は拒否');
  const http = await import('node:http');
  const hostStatus = await new Promise(res => http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', headers: { Host: 'evil.example', 'X-PP-Token': token } }, r => res(r.statusCode)));
  ok(hostStatus === 403, '別のホスト名からの要求は拒否');

  console.log('2. 一覧と読み込み');
  let st = (await call('GET', '/api/state')).data;
  ok(st.list.tracks.length === 25 && st.list.history.length === 16 && st.list.other.length === 6 && st.list.site.length === 4, `一覧：曲${st.list.tracks.length}・HISTORY${st.list.history.length}・その他${st.list.other.length}・文言${st.list.site.length}`);
  ok(st.changes.items.length === 0 && st.remoteOk && st.branch === 'main', '変更なし・送信先とブランチが正しい');
  const pts = (await call('GET', '/api/item?type=album&id=place-to-stay')).data;
  const fIdx = pts.fields.findIndex(f => f.value === 'Showtime2010');
  ok(fIdx >= 0, 'アルバムの曲名（Showtime2010）が編集項目にある');
  ok(!pts.fields.some(f => f.path[0] === 'id' || f.path[0] === 'accent' || f.path[0] === 'visual'), 'ID・色・画像設定は編集項目にない');
  const track = (await call('GET', '/api/item?type=track&id=job-hunting')).data;
  ok(track.fields.some(f => f.path[0] === 'title' && f.required) && track.fields.some(f => f.path[0] === 'lyrics'), '曲：曲名（必須）と歌詞がある');

  console.log('3. 保存');
  const before = read('albums/albums.json');
  let r = await call('POST', '/api/item', { type: 'album', id: 'place-to-stay', rev: pts.rev, changes: [{ path: pts.fields[fIdx].path, value: 'Showtime2010 TEST' }] });
  ok(r.status === 200, '曲名を変更して保存');
  const after = read('albums/albums.json');
  const dl = before.split('\n').filter((l, i) => l !== after.split('\n')[i]);
  ok(dl.length === 1 && after.includes('"Showtime2010 TEST"') && after.split('\n').length === before.split('\n').length, 'ファイルの変化はその1行だけ（形式は不変）');
  ok(JSON.parse(after).albums.length === JSON.parse(before).albums.length, 'JSONとして正しく読める');
  r = await call('POST', '/api/item', { type: 'album', id: 'place-to-stay', rev: pts.rev, changes: [{ path: pts.fields[fIdx].path, value: 'x' }] });
  ok(r.status === 409, '古い画面からの保存は拒否（上書き防止）');
  const pts2 = (await call('GET', '/api/item?type=album&id=place-to-stay')).data;
  ok((await call('POST', '/api/item', { type: 'album', id: 'place-to-stay', rev: pts2.rev, changes: [{ path: ['id'], value: 'x' }] })).status === 400, '編集できない項目（ID）は拒否');
  const tTitle = track.fields.find(f => f.path[0] === 'title');
  ok((await call('POST', '/api/item', { type: 'track', id: 'job-hunting', rev: track.rev, changes: [{ path: tTitle.path, value: '  ' }] })).status === 400, '必須の曲名を空にするのは拒否');
  ok(status() === 'M albums/albums.json', '変わったのは albums.json だけ（docs は未変更）');

  console.log('4. プレビュー');
  r = await call('POST', '/api/preview', { type: 'album', id: 'place-to-stay' });
  ok(r.status === 200 && r.data.url === '/preview/history/index.html#place-to-stay', 'プレビューのページが作られる');
  ok(read('.manager/preview/history/index.html').includes('Showtime2010 TEST'), 'プレビューに変更後の曲名が出る');
  ok((await fetch(base + '/preview/history/index.html')).status === 200, 'プレビューをブラウザで開ける');
  ok(status() === 'M albums/albums.json', 'プレビューで docs は変わらない');

  console.log('5. 公開前の確認と拒否条件');
  st = (await call('GET', '/api/state')).data;
  ok(st.changes.items.length === 1 && st.changes.items[0].before === 'Showtime2010' && st.changes.items[0].after === 'Showtime2010 TEST', '変更内容（前→後）が表示できる');
  writeFileSync(path.join(WORK, 'build.mjs'), read('build.mjs') + '\n// other work\n');
  r = await call('POST', '/api/publish', { confirm: true, summary: 't' });
  ok(r.status === 409 && /管理ツール以外の変更/.test(r.data.error), 'ほかの作業の変更があると公開を拒否');
  g(WORK, 'checkout', '--', 'build.mjs');
  ok((await call('POST', '/api/publish', { summary: 't' })).status === 400, '確認なしの公開は拒否');
  g(WORK, 'remote', 'set-url', 'origin', path.join(TMP, 'nowhere.git'));
  r = await call('POST', '/api/publish', { confirm: true, summary: 't' });
  ok(r.status === 409 && /送信先/.test(r.data.error), '送信先が違うと公開を拒否');
  g(WORK, 'remote', 'set-url', 'origin', BARE);
  spawnSync('git', ['clone', '-q', BARE, OTHER]); g(OTHER, 'config', 'user.name', 'x'); g(OTHER, 'config', 'user.email', 'x@example.invalid');
  g(OTHER, 'commit', '-q', '--allow-empty', '-m', 'someone else'); g(OTHER, 'push', '-q', 'origin', 'main');
  r = await call('POST', '/api/publish', { confirm: true, summary: 't' });
  ok(r.status === 409 && /GitHub側/.test(r.data.error), 'GitHub側が先に進んでいると公開を拒否');
  g(OTHER, 'reset', '-q', '--hard', 'HEAD~1'); g(OTHER, 'push', '-q', '-f', 'origin', 'main'); g(WORK, 'fetch', '-q', 'origin');

  console.log('6. 公開（検証用の送信先へ）');
  const bareBefore = g(BARE, 'rev-parse', 'main');
  r = await call('POST', '/api/publish', { confirm: true, summary: 'PLACE TO STAY の曲名' });
  ok(r.status === 200, `公開できた（${r.data?.head ?? r.data?.error}）`);
  const files = g(BARE, 'show', '--name-only', '--format=', 'main').split('\n').filter(Boolean);
  ok(g(BARE, 'rev-parse', 'main~1') === bareBefore, '送信先 main に1件の保存点が追加された');
  ok(files.includes('albums/albums.json') && files.includes('docs/history/index.html') && files.every(f => /^(albums\/albums\.json|docs\/)/.test(f)), `送信されたのはデータと docs だけ（${files.length}ファイル）`);
  ok(g(BARE, 'log', '-1', '--format=%s', 'main').startsWith('[管理ツール]'), '保存点の説明に [管理ツール] が付く');
  ok(g(BARE, 'show', 'main:docs/history/index.html').includes('Showtime2010 TEST'), '公開されたページに変更が反映');
  ok(status() === '', '公開後、作業フォルダーに残りの変更はない');

  console.log('7. 履歴と取り消し');
  let h = (await call('GET', '/api/history')).data.history;
  ok(h[0].byTool && h[0].published && h[0].undoable, '最新の公開が履歴に出て、取り消し可能');
  ok(!h.find(x => x.subject === 'test base').undoable, '管理ツール以外の保存点は取り消し対象外');
  r = await call('POST', '/api/undo', { sha: h[0].sha });
  ok(r.status === 200 && read('albums/albums.json') === before, '取り消し：データが変更前と完全に同じに戻る（未公開の変更として）');
  ok(status() === 'M albums/albums.json', '取り消しでは docs も GitHub も変わらない');
  r = await call('POST', '/api/publish', { confirm: true, summary: '取り消し' });
  ok(r.status === 200 && !g(BARE, 'show', 'main:docs/history/index.html').includes('Showtime2010 TEST') && g(BARE, 'show', 'main:docs/history/index.html').includes('Showtime2010'), '取り消しを公開すると元の表示に戻る');

  console.log('8. 破棄・サイト文言・歌詞');
  const site = (await call('GET', '/api/item?type=site&id=home')).data;
  const sf = site.fields.find(f => f.value === '選んだ一曲を、いまの音で。');
  ok(!!sf, 'トップの一文が編集項目にある');
  ok((await call('POST', '/api/item', { type: 'site', id: 'home', rev: site.rev, changes: [{ path: sf.path, value: 'テスト一文' }] })).status === 200, 'トップの一文を保存');
  await call('POST', '/api/preview', { type: 'site', id: 'home' });
  ok(read('.manager/preview/index.html').includes('<span>テスト一文</span>'), 'プレビューのトップに反映');
  const tr2 = (await call('GET', '/api/item?type=track&id=job-hunting')).data;
  const ly = tr2.fields.find(f => f.path[0] === 'lyrics');
  const tBefore = read('tracks/job-hunting/track.json');
  ok((await call('POST', '/api/item', { type: 'track', id: 'job-hunting', rev: tr2.rev, changes: [{ path: ly.path, value: ly.value + '\nテスト行' }] })).status === 200, '歌詞に1行追加して保存');
  ok(JSON.parse(read('tracks/job-hunting/track.json')).lyrics.endsWith('\nテスト行'), '歌詞の改行が正しく保存される');
  ok((await call('POST', '/api/discard', {})).status === 400, '確認なしの破棄は拒否');
  r = await call('POST', '/api/discard', { confirm: true });
  ok(r.status === 200 && r.data.count === 2 && read('tracks/job-hunting/track.json') === tBefore && status() === '', '破棄で2ファイルとも元通り');
  ok(existsSync(path.join(WORK, '.manager', 'backup')), '保存・破棄の前の内容は .manager/backup に残る');

  console.log('9. 終了');
  ok((await call('POST', '/api/quit')).status === 200, '終了できる');
} catch (e) {
  fail++; console.log('  NG  例外：', e.message);
} finally {
  try { srv.kill(); } catch {}
  await new Promise(r => setTimeout(r, 400));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n結果：合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
