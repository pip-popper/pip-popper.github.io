// 管理ツールの自動テスト（本物のGitHub・本物の作業フォルダーには触れない）。
// 使い方：node manager/test-manager.mjs
// 一時フォルダーに「検証用の送信先（bare リポジトリ）」と「作業コピー」を作り、現在の作業フォルダーの
// build.mjs・content・manager を作業コピーへ入れてから、管理ツールのサーバーをその作業コピーに対して起動する。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ppm-test-'));
const BARE = path.join(TMP, 'remote.git'), WORK = path.join(TMP, 'work'), OTHER = path.join(TMP, 'other');
const PORT = 18991, PV_PORT = 18995;
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...a], { cwd, encoding: 'utf8' }); return (r.stdout ?? '').trim(); };
const gOk = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).status === 0;

console.log('準備：検証用の送信先と作業コピーを作成');
spawnSync('git', ['clone', '-q', '--bare', REPO, BARE]);
spawnSync('git', ['clone', '-q', BARE, WORK]);
for (const p of ['build.mjs', 'content', 'manager', 'src', 'private/worker/src/song-order.js', 'public-listening/approval.mjs']) cpSync(path.join(REPO, p), path.join(WORK, p), {
  recursive: true, filter: source => path.relative(REPO, source) !== path.join('manager', 'runtime')
});
g(WORK, 'config', 'user.name', 'Producer'); g(WORK, 'config', 'user.email', 'test@example.invalid');
// --allow-empty: when the manager is already committed in the repository there is nothing to add, but the
// tests still need one ordinary (non-manager) saved point named "test base"
g(WORK, 'add', '-f', 'build.mjs', 'content', 'manager', 'src', 'private/worker/src/song-order.js', 'public-listening/approval.mjs'); g(WORK, 'commit', '-q', '--allow-empty', '-m', 'test base'); g(WORK, 'push', '-q', 'origin', 'main');
g(WORK, 'branch', '-q', '-u', 'origin/main');

// stands in for GitHub's API listing the Pages deployments (8h sets what it answers; null = server error)
let pagesRuns = [];
const pagesMock = (await import('node:http')).createServer((q, s) => { s.writeHead(pagesRuns === null ? 500 : 200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ workflow_runs: pagesRuns ?? [] })); }).listen(18996, '127.0.0.1');
const env = { ...process.env, PP_MANAGER_EXPECTED_REMOTE: BARE, PP_MANAGER_PRINT_TOKEN: '1', PP_MANAGER_PRIVATE_URL: 'http://localhost:18995/', PP_MANAGER_PAGES_API: 'http://127.0.0.1:18996/runs' };
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
  const TRACK_COUNT = readdirSync(path.join(WORK, 'tracks')).filter(d => existsSync(path.join(WORK, 'tracks', d, 'track.json'))).length;
  ok(st.list.tracks.length === TRACK_COUNT && st.list.history.length === 16 && st.list.other.length === 6 && st.list.site.length === 6, `一覧：曲${st.list.tracks.length}・HISTORY${st.list.history.length}・その他${st.list.other.length}・文言${st.list.site.length}`);
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
  g(WORK, 'commit', '-q', '--allow-empty', '-m', 'AI work not yet approved');
  st = (await call('GET', '/api/state')).data;
  r = await call('POST', '/api/publish', { confirm: true, summary: 't' });
  ok(st.otherUnpushed === 1 && st.pendingPush === 0 && r.status === 409 && /AI等の作業/.test(r.data.error), 'AI等の未公開の保存点があると公開を拒否（一緒に送らない）');
  ok((await call('POST', '/api/push-pending', { confirm: true })).status !== 200, '送信のやり直しでもAI等の保存点は送らない');
  g(WORK, 'reset', '-q', '--soft', 'HEAD~1');
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

  console.log('8b. 追加した文言（見出し・末尾の文・メッセージ欄・非公開の注記）');
  st = (await call('GET', '/api/state')).data;
  ok(['home', 'history', 'otherWorks', 'about', 'message', 'track'].every(id => st.list.site.some(x => x.id === id)), 'サイトの文言に6項目（メッセージ欄・曲ページ（共通）を含む）');
  const hist = (await call('GET', '/api/item?type=site&id=history')).data;
  const hLead = hist.fields.find(f => f.value.startsWith('1999年から2001年へ'));
  const hTitle = hist.fields.find(f => f.value === 'アルバムでたどる');
  const hEnd = hist.fields.find(f => f.value.startsWith('過去の曲は'));
  ok(!!hLead && /見出しの下/.test(hLead.label) && !!hTitle && !!hEnd, 'ヒストリーの冒頭文「1999年から2001年へ」・見出し・末尾の文が編集項目にある');
  const siteBefore = read('content/site.json');
  r = await call('POST', '/api/item', { type: 'site', id: 'history', rev: hist.rev, changes: [{ path: hLead.path, value: 'テスト冒頭文' }, { path: hTitle.path, value: 'テスト見出し' }, { path: hEnd.path, value: 'テスト末尾' }] });
  ok(r.status === 200, 'ヒストリーの3項目をまとめて保存');
  const msg = (await call('GET', '/api/item?type=site&id=message')).data;
  ok((await call('POST', '/api/item', { type: 'site', id: 'message', rev: msg.rev, changes: [{ path: msg.fields[1].path, value: 'テスト2行目' }] })).status === 200, 'メッセージ欄の説明文を保存');
  const trk = (await call('GET', '/api/item?type=site&id=track')).data;
  const cond = trk.fields.find(f => f.value === '心が広い人。');
  ok((await call('POST', '/api/item', { type: 'site', id: 'track', rev: trk.rev, changes: [{ path: cond.path, value: 'テスト条件' }] })).status === 200, '非公開の注記を保存');
  r = await call('POST', '/api/preview', { type: 'site', id: 'history' });
  const ph = read('.manager/preview/history/index.html');
  ok(r.data.url === '/preview/history/index.html' && ph.includes('<span class="tw">テスト見出し</span><wbr><span class="tw">PIP POPPER</span>') && ph.includes('テスト冒頭文') && ph.includes('<p>テスト末尾</p>'), 'プレビューのヒストリーに見出し・冒頭文・末尾の文が反映');
  ok(read('.manager/preview/index.html').includes('何でもお気軽にどうぞ。<br>テスト2行目</p>'), 'プレビューのトップのメッセージ欄に反映');
  ok(read('.manager/preview/tracks/itoshi-no-honey/index.html').includes('lp-heart">テスト条件</span>'), 'プレビューの音源非公開の曲ページの注記に反映');
  st = (await call('GET', '/api/state')).data;
  ok(st.changes.items.length === 5 && st.changes.items.some(c => /ヒストリーページの見出しの下の文/.test(c.label)), '変更一覧に5か所（場所の名前付き）');
  r = await call('POST', '/api/discard', { confirm: true });
  ok(r.status === 200 && read('content/site.json') === siteBefore && status() === '', '破棄で site.json が元通り');

  console.log('8c. 配信リンク');
  const jh = (await call('GET', '/api/item?type=track&id=job-hunting')).data;
  const lk = jh.fields.find(f => f.path[0] === 'streamingUrl');
  ok(!!lk && lk.kind === 'url' && lk.value === '', '配信リンクの欄がある（空）');
  ok(!(await call('GET', '/api/item?type=track&id=itoshi-no-honey')).data.fields.some(f => f.path[0] === 'streamingUrl'), '音源非公開の曲には配信リンクの欄を出さない');
  ok((await call('POST', '/api/item', { type: 'track', id: 'job-hunting', rev: jh.rev, changes: [{ path: lk.path, value: 'http://open.spotify.com/track/x' }] })).status === 400, 'http のURLは拒否');
  ok((await call('POST', '/api/item', { type: 'track', id: 'job-hunting', rev: jh.rev, changes: [{ path: lk.path, value: 'https://example.com/x' }] })).status === 400, '対応外のサイトは拒否');
  const jhBefore = read('tracks/job-hunting/track.json');
  ok((await call('POST', '/api/item', { type: 'track', id: 'job-hunting', rev: jh.rev, changes: [{ path: lk.path, value: ' https://open.spotify.com/track/TEST123 ' }] })).status === 200, 'Spotify のURLを保存（前後の空白は除く）');
  ok(JSON.parse(read('tracks/job-hunting/track.json')).streamingUrl === 'https://open.spotify.com/track/TEST123', '保存された値が正しい');
  r = await call('POST', '/api/preview', { type: 'track', id: 'job-hunting' });
  ok(r.status === 200 && read('.manager/preview/tracks/job-hunting/index.html').includes('data-service="spotify" href="https://open.spotify.com/track/TEST123"'), 'プレビューの曲ページに「Spotifyで聴く」が出る');
  const jh2 = (await call('GET', '/api/item?type=track&id=job-hunting')).data;
  ok((await call('POST', '/api/item', { type: 'track', id: 'job-hunting', rev: jh2.rev, changes: [{ path: lk.path, value: '' }] })).status === 200 && read('tracks/job-hunting/track.json') === jhBefore, '空欄にすると null に戻り、ファイルは元と同じ');

  console.log('8d. PRIVATEのパスワード（ローカルの模擬PRIVATEに対して）');
  {
    const OLD = 'member-old-123456', NEW = 'member-new-789012', ADM = 'admin-pass-abcdef';
    const R2 = path.join(TMP, 'pv-r2'), VARS = path.join(TMP, 'pv.vars');
    writeFileSync(VARS, `PRIVATE_PASSWORD=${OLD}\nSESSION_KEY=${'k'.repeat(48)}\nADMIN_PASSWORD=${ADM}\n`);
    // first the Worker as published today (origin/main = the deployed version, before this feature): no change API yet
    const OLDTREE = path.join(TMP, 'published');
    const PUBLISHED = '1a0b059';   // the last public state before the password feature (origin/main has it since 2026-11-24)
    g(WORK, 'worktree', 'add', '-q', '--detach', OLDTREE, PUBLISHED);
    const oldPv = spawn(process.execPath, [path.join(OLDTREE, 'private', 'dev', 'serve.mjs'), '--vars', VARS, '--r2', R2, '--port', String(PV_PORT)]);
    await new Promise((res, rej) => { oldPv.stdout.on('data', d => /ローカル検証/.test(String(d)) && res()); setTimeout(() => rej(new Error('old PRIVATE imitation did not start')), 15000); });
    r = await call('POST', '/api/private/password', { newPassword: 'member-new-789012', confirmPassword: 'member-new-789012', adminPassword: ADM });
    ok(r.status === 501 && /まだこの機能に対応していません/.test(r.data.error), '更新前のPRIVATEには「まだ対応していません」と表示（変更なし）');
    oldPv.kill(); await new Promise(res => setTimeout(res, 500));
    const pv = spawn(process.execPath, [path.join(REPO, 'private', 'dev', 'serve.mjs'), '--vars', VARS, '--r2', R2, '--port', String(PV_PORT)]);
    await new Promise((res, rej) => { pv.stdout.on('data', d => /ローカル検証/.test(String(d)) && res()); setTimeout(() => rej(new Error('PRIVATE imitation did not start')), 15000); });
    const pvLogin = async pw => (await fetch(`http://localhost:${PV_PORT}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pw }) })).status;
    try {
      ok(await pvLogin(OLD) === 303, '模擬PRIVATE：最初は今のパスワードで入れる');
      ok((await call('POST', '/api/private/password', { newPassword: NEW, confirmPassword: NEW + 'x', adminPassword: ADM })).status === 400, '確認用が一致しないと送らない（400）');
      ok((await call('POST', '/api/private/password', { newPassword: 'short', confirmPassword: 'short', adminPassword: ADM })).status === 400, '短すぎるパスワードは送らない（400）');
      r = await call('POST', '/api/private/password', { newPassword: NEW, confirmPassword: NEW, adminPassword: 'wrong-admin-pass' });
      ok(r.status === 403 && /管理者パスワードが違います/.test(r.data.error), '管理者パスワードが違うと「違います」と表示（変更なし）');
      ok(await pvLogin(OLD) === 303, '失敗後も今のパスワードのまま');
      r = await call('POST', '/api/private/password', { newPassword: NEW, confirmPassword: NEW, adminPassword: ADM });
      ok(r.status === 200 && r.data.ok && r.data.mode === 'r2' && !!r.data.changedAt, '管理ツールから変更が完了');
      ok(await pvLogin(NEW) === 303 && await pvLogin(OLD) === 401, '直ちに：新しいパスワードで入れて、古いパスワードでは入れない');
      ok((await call('POST', '/api/private/restore', { adminPassword: ADM, confirm: 'ちがう言葉' })).status === 400 && await pvLogin(NEW) === 303, '確認の言葉が違うと戻さない');
      r = await call('POST', '/api/private/restore', { adminPassword: ADM, confirm: '旧パスワードに戻す' });
      ok(r.status === 200 && await pvLogin(OLD) === 303 && await pvLogin(NEW) === 401, 'Cloudflareのパスワードに戻せる');
      const logText = existsSync(path.join(WORK, '.manager', 'manager.log')) ? readFileSync(path.join(WORK, '.manager', 'manager.log'), 'utf8') : '';
      ok(!logText.includes(NEW) && !logText.includes(OLD) && !logText.includes(ADM) && /private\/password status=200/.test(logText), '記録（manager.log）にパスワードは残らない（操作名と結果だけ）');
      // what the tool writes: .manager (previews, backups, log) and the site data — not the test script itself
      const leaks = spawnSync('git', ['grep', '-l', '--no-index', '-e', NEW, '-e', ADM, '--', '.manager', 'content', 'tracks', 'albums', 'docs'], { cwd: WORK, encoding: 'utf8' }).stdout.trim();
      ok(leaks === '', '管理ツールが書くフォルダー（.manager・データ・docs）にパスワードは残らない', leaks);
      const broken = await fetch(`${base}/api/private/password`, { method: 'POST', headers: { 'X-PP-Token': token, 'Content-Type': 'application/json' }, body: `{"newPassword": "${NEW}", ` });
      ok(broken.status === 400 && !readFileSync(path.join(WORK, '.manager', 'manager.log'), 'utf8').includes(NEW), '壊れた送信内容は処理せず、記録にも残さない');
      // ── 一般視聴の管理（2026-11-25）：管理ツール → 模擬PRIVATE Worker → 模擬R2 ──
      {
        const { createHash } = await import('node:crypto');
        const PV = `http://localhost:${PV_PORT}`;
        ok((await call('POST', '/api/listen/list', { adminPassword: 'wrong-admin-pass' })).status === 403, '一般視聴：管理者パスワードが違うと読めない');
        let l = await call('POST', '/api/listen/list', { adminPassword: ADM });
        ok(l.status === 200 && l.data.songs.length === 0 && l.data.official.some(o => o.id === 'manner'), '一般視聴：公式サイトの曲を一覧（まだ0曲）');
        const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(6000, 5)]);
        const up = (id, bytes, rev) => fetch(`${base}/api/listen/upload`, { method: 'POST', body: bytes, headers: { 'X-PP-Token': token, 'Content-Type': 'audio/mpeg', 'X-Id': id, 'X-Rev': String(rev), 'X-Sha256': createHash('sha256').update(bytes).digest('hex'), 'X-Duration': '61.2', 'X-PP-Admin-Password': Buffer.from(ADM).toString('base64') } });
        ok((await up('no-such-song', mp3, l.data.rev)).status === 400, '一般視聴：公式サイトにない曲には登録できない');
        let res = await up('manner', mp3, l.data.rev), out = await res.json();
        ok(res.status === 200 && out.song.status === 'draft', '一般視聴：MP3を登録（下書き）');
        ok(!(await (await fetch(`${PV}/listen/`)).text()).includes('Manner'), '一般視聴：登録しただけでは公開されない');
        l = await call('POST', '/api/listen/list', { adminPassword: ADM });
        r = await call('POST', '/api/listen/action', { adminPassword: ADM, id: 'manner', op: 'settings', rev: l.data.rev, items: { lyrics: true, jacket: true, impression: false } });
        ok(r.status === 200 && r.data.song.draft.items.lyrics && r.data.song.draft.hasJacket, '一般視聴：歌詞・ジャケットは公式サイトのものを公開項目に');
        res = await fetch(`${base}/api/listen/audio`, { method: 'POST', headers: { 'X-PP-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword: ADM, id: 'manner' }) });
        ok(res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(mp3), '一般視聴：公開前の音源を管理ツールで試聴できる');
        r = await call('POST', '/api/listen/action', { adminPassword: ADM, id: 'manner', op: 'publish', rev: r.data.rev, confirm: true });
        const page = await (await fetch(`${PV}/listen/`)).text();
        const lyric = JSON.parse(read('tracks/manner/track.json')).lyrics.split('\n')[0].trim();
        ok(r.status === 200 && page.includes('Manner') && page.includes(lyric.slice(0, 6)) && (await fetch(`${PV}/listen/audio/manner.mp3`, { headers: { Range: 'bytes=0-9' } })).status === 206, '一般視聴：公開すると誰でも見られ・聴ける');
        r = await call('POST', '/api/listen/action', { adminPassword: ADM, id: 'manner', op: 'stop', rev: r.data.rev });
        ok(r.status === 200 && !(await (await fetch(`${PV}/listen/`)).text()).includes('Manner'), '一般視聴：掲載停止');
        r = await call('POST', '/api/listen/action', { adminPassword: ADM, id: 'manner', op: 'resume', rev: r.data.rev });
        ok(r.status === 200 && (await (await fetch(`${PV}/listen/`)).text()).includes('Manner'), '一般視聴：掲載再開');
        const log2 = readFileSync(path.join(WORK, '.manager', 'manager.log'), 'utf8');
        ok(!log2.includes(ADM) && /listen\/upload status=200/.test(log2), '一般視聴：記録にパスワードは残らない');
        ok(status() === '', '一般視聴：公式サイトのデータは変わらない');
      }
      // ── 管理者パスワードの変更（2026-11-25）──
      {
        const ADM2 = 'admin-changed-by-tool-9', pvAdmin = async pw => (await fetch(`http://localhost:${PV_PORT}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pw }) })).status;
        ok((await call('POST', '/api/private/admin-password', { newPassword: ADM2, confirmPassword: ADM2 + 'x', adminPassword: ADM })).status === 400, '管理者パスワード：確認用が一致しないと送らない');
        ok((await call('POST', '/api/private/admin-password', { newPassword: 'short', confirmPassword: 'short', adminPassword: ADM })).status === 400, '管理者パスワード：12文字未満は送らない');
        r = await call('POST', '/api/private/admin-password', { newPassword: ADM2, confirmPassword: ADM2, adminPassword: ADM });
        ok(r.status === 200 && r.data.ok, '管理者パスワード：管理ツールから変更できる');
        ok(await pvAdmin(ADM2) === 303 && await pvAdmin(ADM) === 401, '管理者パスワード：新しいもので入れて、古いものでは入れない');
        ok((await call('POST', '/api/listen/list', { adminPassword: ADM2 })).status === 200 && (await call('POST', '/api/listen/list', { adminPassword: ADM })).status === 403, '管理者パスワード：一般視聴の管理も新しいパスワードで使える');
        ok(await pvLogin(OLD) === 303, '管理者パスワード：招待者のパスワードは変わらない');
        r = await call('POST', '/api/private/admin-restore', { adminPassword: ADM2, confirm: 'Cloudflareの管理者パスワードに戻す' });
        ok(r.status === 200 && await pvAdmin(ADM) === 303, '管理者パスワード：Cloudflareのパスワードに戻せる');
        const log3 = readFileSync(path.join(WORK, '.manager', 'manager.log'), 'utf8');
        const leaks2 = spawnSync('git', ['grep', '-l', '--no-index', '-e', ADM2, '--', '.manager', 'content', 'tracks', 'albums', 'docs'], { cwd: WORK, encoding: 'utf8' }).stdout.trim();
        ok(!log3.includes(ADM2) && !log3.includes(ADM) && /admin-password status=200/.test(log3) && leaks2 === '', '管理者パスワード：記録・管理ツールのフォルダーに残らない');
      }
    } finally { pv.kill(); }
  }

  console.log('8b. 新曲：登録 → 公式HPへ取り込み → 破棄 → 再取り込み → 公開 → 取り消し');
  {
    const b64 = rel => readFileSync(path.join(REPO, rel)).toString('base64');
    const image = { original: { mime: 'image/png', data: b64('tracks/anniversary/cover.png') }, web: { mime: 'image/jpeg', data: b64('tracks/anniversary/cover-web.jpg') }, thumb: { mime: 'image/jpeg', data: b64('tracks/anniversary/cover-640.jpg') } };
    const fields = { title: '架空の新曲テスト', reading: 'かくうのしんきょくてすと', artist: 'PIP POPPER', lyrics: '公開する歌詞\n\n二行目', impression: '公開する感想', classification: 'general',
      lyricsScope: 'public', impressionScope: 'public', channels: { hp: true, listen: false, private: false }, state: 'draft', urls: [], memo: 'MEMO_NOT_PUBLIC' };
    const reg = (a, b) => call('POST', `/api/song-registration/${a}`, b);
    let r = await reg('save', { fields, image, confirm: true });
    const id = r.data.record.id;
    ok(r.status === 200 && r.data.publication.state === 'not-adopted', '下書きを保存（未取り込み）');
    ok((await reg('adopt', { id, rev: r.data.record.rev, slug: 'kakuu-test', confirm: true })).status === 400, '下書きのままでは取り込めない');
    r = await reg('save', { id, rev: r.data.record.rev, fields: { ...fields, state: 'ready' }, confirm: true });
    const rev = r.data.record.rev;
    ok(r.status === 200, '公開準備完了で保存');
    ok((await reg('adopt', { id, rev, slug: 'kakuu-test' })).status === 400, '確認なしの取り込みは拒否');
    ok((await reg('adopt', { id, rev, slug: 'Bad Name', confirm: true })).status === 400, '不正なURL名は拒否');
    ok((await reg('adopt', { id, rev, slug: 'manner', confirm: true })).status === 409, '既存の曲と同じURL名は拒否（既存の曲は変わらない）');
    ok(status() === '', 'ここまで公式データは変わらない');
    r = await reg('adopt', { id, rev, slug: 'kakuu-test', confirm: true });
    const t = JSON.parse(read('tracks/kakuu-test/track.json'));
    ok(r.status === 200 && r.data.publication.state === 'adopted' && existsSync(path.join(WORK, 'tracks/kakuu-test/cover-web.jpg')) && existsSync(path.join(WORK, 'tracks/kakuu-test/cover-640.jpg')), '取り込み：track.json と表示用画像2枚');
    ok(t.title === fields.title && t.lyrics === fields.lyrics && t.aiImpression === fields.impression && t.publicArchiveApproved === true && t.audio === null && !read('tracks/kakuu-test/track.json').includes('MEMO_NOT_PUBLIC'), '取り込んだ内容は承認済みの公開項目だけ（管理メモなし）');
    ok((await reg('adopt', { id, rev, slug: 'kakuu-test2', confirm: true })).status === 409, '二重の取り込みは拒否');
    let st = (await call('GET', '/api/state')).data;
    ok(st.changes.other.length === 0 && st.changes.items.some(c => c.item === '曲「架空の新曲テスト」' && c.label === 'ジャケット画像'), '公開していない変更に新曲（文字と画像）が並ぶ・管理ツール以外の変更なし');
    ok((await call('POST', '/api/discard', { confirm: true })).status === 200 && !existsSync(path.join(WORK, 'tracks/kakuu-test')) && status() === '', '「変更を破棄」で取り込みを取り消せる');
    ok((await reg('get', { id })).data.publication.state === 'withdrawn', '登録側は「取り込み取消済み」');
    ok((await reg('adopt', { id, rev, slug: 'kakuu-test', confirm: true })).status === 200, 'もう一度取り込める');
    r = await call('POST', '/api/preview', { type: 'track', id: 'kakuu-test' });
    ok(r.status === 200, 'プレビューを作れる');
    r = await call('POST', '/api/publish', { confirm: true, summary: '新曲：架空の新曲テスト' });
    const remoteFiles = g(BARE, 'ls-tree', '-r', '--name-only', 'main');
    ok(r.status === 200 && ['tracks/kakuu-test/track.json', 'tracks/kakuu-test/cover-web.jpg', 'tracks/kakuu-test/cover-640.jpg', 'docs/tracks/kakuu-test/index.html', 'docs/assets/covers/kakuu-test.jpg'].every(f => remoteFiles.split('\n').includes(f)), '公開：新曲のページと画像が送信先に届く');
    ok(g(BARE, 'show', 'main:docs/index.html').includes('data-order-kana'), '公開されたトップに表示順の切替がある');
    ok((await reg('get', { id })).data.publication.state === 'published', '登録側は「公開済み」（送信先にある時だけ）');
    {
      const g2 = (await reg('get', { id })).data;
      ok((await reg('save', { id, rev: g2.record.rev, fields: { ...fields, state: 'draft' }, confirm: true })).status === 409, '公開済みの曲の登録は「下書き」に戻せない');
      const s3 = await reg('save', { id, rev: g2.record.rev, fields: { ...fields, memo: '公開後のメモ', state: 'ready' }, confirm: true });
      ok(s3.status === 200 && s3.data.publication.state === 'published' && s3.data.record.state === 'ready', '公開済みの曲の登録を編集しても公開済みのまま');
      ok((await call('GET', '/api/state')).data.registrations.find(x => x.id === id)?.publication.state === 'published', '一覧の状態も公開済み（その場で切り替わる）');
      ok((await call('POST', '/api/fetch-status', {})).status === 200 && status() === '', '「更新」用の読み取りはファイルを変えない');
    }
    const h = (await call('GET', '/api/history')).data.history;
    ok(h[0].undoable, '新曲の公開も管理ツールで取り消せる対象');
    ok((await call('POST', '/api/undo', { sha: h[0].sha })).status === 200 && !existsSync(path.join(WORK, 'tracks/kakuu-test/cover-web.jpg')), '取り消し：新曲のファイルが「公開していない変更（削除）」になる');
    st = (await call('GET', '/api/state')).data;
    ok(st.changes.items.some(c => c.label === 'ジャケット画像（削除）') && st.changes.other.length === 0, '削除も公開前の一覧に出る');
    ok((await call('POST', '/api/discard', { confirm: true })).status === 200 && existsSync(path.join(WORK, 'tracks/kakuu-test/cover-web.jpg')) && status() === '', '取り消しを破棄すると元に戻る');
  }

  console.log('8c. 既存の曲によみがなを付ける（あいうえお順用）');
  {
    const it = (await call('GET', '/api/item?type=track&id=manner')).data;
    const fi = it.fields.findIndex(f => f.path[0] === 'reading');
    ok(fi >= 0 && it.fields[fi].value === '', 'よみがな欄がある（未設定は空欄）');
    ok((await call('POST', '/api/item', { type: 'track', id: 'manner', rev: it.rev, changes: [{ path: ['reading'], value: '漢字' }] })).status === 400, 'ひらがな・カタカナ・英数字以外は拒否');
    const r = await call('POST', '/api/item', { type: 'track', id: 'manner', rev: it.rev, changes: [{ path: ['reading'], value: 'まなー' }] });
    ok(r.status === 200 && JSON.parse(read('tracks/manner/track.json')).reading === 'まなー' && JSON.parse(read('tracks/manner/track.json')).lyrics === JSON.parse(g(WORK, 'show', 'HEAD:tracks/manner/track.json')).lyrics, 'よみがなを保存（他の項目は不変）');
    ok((await call('POST', '/api/discard', { confirm: true })).status === 200 && status() === '', '破棄で元に戻る');
  }

  console.log('8d. アルバム：登録 → 履歴・復元 → 取り込み → 公開 → 曲順・追加・外す・掲載順・ジャケット');
  {
    const b64 = rel => readFileSync(path.join(REPO, rel)).toString('base64');
    const image = { original: { mime: 'image/png', data: b64('tracks/anniversary/cover.png') }, web: { mime: 'image/jpeg', data: b64('tracks/anniversary/cover-web.jpg') }, thumb: { mime: 'image/jpeg', data: b64('tracks/anniversary/cover-640.jpg') } };
    const fields = { title: '架空アルバム', subtitle: '', section: 'history', kind: 'Album', year: '2026', dateLabel: '2026年11月', intro: '紹介の一段落目。\n\n紹介の二段落目。', story: '制作秘話の本文。',
      tracks: [{ title: 'Manner', music: 'manner' }, { title: '新しい曲（ページなし）' }], urls: [], state: 'draft', memo: 'ALBUM_MEMO_NOT_PUBLIC' };
    const reg = (a, b) => call('POST', `/api/album-registration/${a}`, b);
    const before = read('albums/albums.json');
    let r = await reg('save', { fields, confirm: true });
    const id = r.data.record.id, first = r.data.record.rev;
    ok(r.status === 200 && /^album-[a-f0-9]{24}$/.test(id) && r.data.publication.state === 'not-adopted', '下書き保存（アルバムIDを自動発行）');
    ok((await reg('save', { fields: { ...fields, tracks: [{ title: 'x', music: 'no-such-song' }] }, confirm: true })).status === 400, '存在しない曲IDは収録できない');
    ok((await reg('save', { id, rev: first, fields: { ...fields, state: 'ready' }, confirm: true })).status === 400, 'ジャケットなしでは公開準備完了にできない');
    r = await reg('save', { id, rev: first, fields: { ...fields, title: '架空アルバム（改）', tracks: [fields.tracks[1], fields.tracks[0]], state: 'ready' }, image, confirm: true });
    const second = r.data.record.rev;
    ok(r.status === 200 && r.data.record.id === id && r.data.record.tracks[0].title === '新しい曲（ページなし）' && r.data.history.length === 2, '編集保存：IDはそのまま、曲順の入れ替え、履歴2件');
    r = await reg('restore', { id, rev: second, restoreRev: first, confirm: true });
    ok(r.status === 200 && r.data.record.title === '架空アルバム' && r.data.record.id === id, '以前の保存版を復元');
    r = await reg('save', { id, rev: r.data.record.rev, fields: { ...fields, state: 'ready' }, image, confirm: true });
    const rev = r.data.record.rev;
    ok(read('albums/albums.json') === before && status() === '', 'ここまで公式データは変わらない');
    ok((await reg('delete', { id, confirm: true })).status === 200 && !(await call('GET', '/api/state')).data.albumRegistrations.some(a => a.id === id) && (await call('GET', '/api/state')).data.deletedRegistrations.some(a => a.id === id), '登録の削除（一覧から消え、削除済みに出る）');
    ok((await reg('undelete', { id, confirm: true })).status === 200 && (await call('GET', '/api/state')).data.albumRegistrations.some(a => a.id === id), '削除した登録を復元');
    ok((await reg('adopt', { id, rev, slug: 'pip-popper', confirm: true })).status === 409, '既存のアルバムと同じURL名は拒否');
    r = await reg('adopt', { id, rev, slug: 'kakuu-album', confirm: true });
    const albums = JSON.parse(read('albums/albums.json')).albums, entry = albums.find(a => a.id === 'kakuu-album');
    const lastHistory = albums.filter(a => a.section !== 'other').at(-1);
    ok(r.status === 200 && r.data.publication.state === 'adopted' && entry && lastHistory.id === 'kakuu-album' && existsSync(path.join(WORK, 'albums/kakuu-album/visual-web.jpg')), '取り込み：HISTORY の最後に追加、ジャケット2枚');
    ok(entry.tracks.length === 2 && entry.tracks[0].music === 'manner' && entry.episode.text.length === 2 && entry.column.text[0] === '制作秘話の本文。' && !read('albums/albums.json').includes('ALBUM_MEMO_NOT_PUBLIC'), '紹介文・制作秘話・収録曲が入り、管理メモは入らない');
    ok(albums.filter(a => a.id !== 'kakuu-album').map(a => a.id).join() === JSON.parse(before).albums.map(a => a.id).join(), '既存のアルバムの並びはそのまま');
    let st = (await call('GET', '/api/state')).data;
    ok(st.changes.other.length === 0 && st.changes.items.length === 3 && st.changes.items.some(c => c.item === 'アルバム『架空アルバム』' && c.label === '新しいアルバム') && st.changes.items.some(c => c.item === 'アルバム『架空アルバム』' && c.label === 'ジャケット画像'), '公開していない変更は3件だけ（新しいアルバム＋画像2枚。後ろのアルバムはずれない）');
    r = await call('POST', '/api/publish', { confirm: true, summary: 'アルバム：架空アルバム' });
    const remote = g(BARE, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    ok(r.status === 200 && remote.includes('albums/kakuu-album/visual-web.jpg') && remote.includes('docs/assets/history/kakuu-album-visual.jpg') && g(BARE, 'show', 'main:docs/history/index.html').includes('id="kakuu-album"'), '公開：HISTORYページに新しいアルバム');
    ok((await reg('get', { id })).data.publication.state === 'published', '登録側は「公開済み」');
    ok((await reg('delete', { id, confirm: true })).status === 409, '公開済みのアルバムの登録は削除できない（先に掲載停止）');
    // track list editing on the published album
    let it = (await call('GET', '/api/item?type=album&id=kakuu-album')).data;
    ok(it.tracks.length === 2 && it.hasJacket && it.section === 'history', '編集画面に収録曲・ジャケット・掲載ページ');
    ok((await call('POST', '/api/album/tracks', { id: 'kakuu-album', rev: it.rev, op: 'move', index: 0, dir: 1 })).status === 200, '曲順を入れ替え');
    it = (await call('GET', '/api/item?type=album&id=kakuu-album')).data;
    ok(it.tracks[1].music === 'manner', '入れ替わった');
    ok((await call('POST', '/api/album/tracks', { id: 'kakuu-album', rev: it.rev, op: 'add', title: 'Diet', music: 'diet' })).status === 200, '既存曲を追加');
    it = (await call('GET', '/api/item?type=album&id=kakuu-album')).data;
    ok((await call('POST', '/api/album/tracks', { id: 'kakuu-album', rev: it.rev, op: 'remove', index: 1 })).status === 400, '確認なしでは外さない');
    ok((await call('POST', '/api/album/tracks', { id: 'kakuu-album', rev: it.rev, op: 'remove', index: 1, confirm: true })).status === 200 && existsSync(path.join(WORK, 'tracks/manner/track.json')), '外しても曲そのものは残る');
    it = (await call('GET', '/api/item?type=album&id=kakuu-album')).data;
    ok(it.tracks.map(t => t.title).join('|') === '新しい曲（ページなし）|Diet', '曲目：新しい曲・Diet');
    ok((await call('POST', '/api/album/tracks', { id: 'favorite-track', rev: it.rev, op: 'move', index: 0, dir: 1 })).status === 409 || (await call('POST', '/api/album/tracks', { id: 'favorite-track', rev: (await call('GET', '/api/item?type=album&id=favorite-track')).data.rev, op: 'move', index: 0, dir: 1 })).status === 400, 'ディスク別構成の作品は曲目構成を変えない');
    ok((await call('POST', '/api/album/move', { id: 'kakuu-album', rev: it.rev, dir: -1 })).status === 200 && JSON.parse(read('albums/albums.json')).albums.filter(a => a.section !== 'other').at(-2).id === 'kakuu-album', '掲載順を前へ');
    ok((await call('GET', '/api/state')).data.changes.items.some(c => c.item === 'HISTORY の掲載順'), '掲載順の変更が一覧に出る');
    ok((await call('POST', '/api/album/move', { id: 'pip-popper', rev: (await call('GET', '/api/item?type=album&id=pip-popper')).data.rev, dir: -1 })).status === 400, '先頭より前へは動かない');
    const jacket = { original: { mime: 'image/jpeg', data: b64('tracks/manner/cover-640.jpg') }, web: { mime: 'image/jpeg', data: b64('tracks/manner/cover-web.jpg') }, thumb: { mime: 'image/jpeg', data: b64('tracks/manner/cover-640.jpg') } };
    ok((await call('POST', '/api/album/jacket', { id: 'kakuu-album', image: jacket, confirm: true })).status === 200 && readFileSync(path.join(WORK, 'albums/kakuu-album/visual-web.jpg')).equals(readFileSync(path.join(REPO, 'tracks/manner/cover-web.jpg'))), 'ジャケットを差し替え');
    ok((await call('POST', '/api/preview', { type: 'album', id: 'kakuu-album' })).status === 200, '変更後のプレビューを作れる');
    ok((await call('POST', '/api/discard', { confirm: true })).status === 200 && status() === '' && JSON.parse(read('albums/albums.json')).albums.find(a => a.id === 'kakuu-album').tracks.length === 2, '変更を破棄で公開済みの状態に戻る（画像も）');
  }

  console.log('8e. 掲載停止・再開・管理一覧から外す（曲とアルバム）');
  {
    let it = (await call('GET', '/api/item?type=track&id=diet')).data;
    ok((await call('POST', '/api/hidden', { type: 'track', id: 'diet', rev: it.rev, hidden: true })).status === 400, '確認なしでは止めない');
    ok((await call('POST', '/api/archive', { type: 'track', id: 'diet', archive: true, confirm: true })).status === 409, '掲載中の曲は一覧から外せない');
    ok((await call('POST', '/api/hidden', { type: 'track', id: 'diet', rev: it.rev, hidden: true, confirm: true })).status === 200 && JSON.parse(read('tracks/diet/track.json')).hidden === true, '曲の掲載停止（データは残る）');
    ok((await call('GET', '/api/state')).data.changes.items.some(c => c.item === '曲「Diet」' && c.label === '掲載' && c.after === '掲載停止'), '掲載停止が「公開していない変更」に出る（公開ボタンが押せる）');
    let r = await call('POST', '/api/publish', { confirm: true, summary: '掲載停止：Diet' });
    let remote = g(BARE, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    ok(r.status === 200 && !remote.includes('docs/tracks/diet/index.html') && !remote.includes('docs/assets/covers/diet.jpg') && remote.includes('tracks/diet/track.json') && remote.includes('tracks/diet/cover-web.jpg'), '公開：曲ページと表示画像は消え、元データは残る');
    const hist = g(BARE, 'show', 'main:docs/history/index.html');
    ok(!g(BARE, 'show', 'main:docs/works.json').includes('"diet"') && !hist.includes('tracks/diet/'), '一覧・アルバムの曲目からリンクが外れる');
    ok((await call('POST', '/api/archive', { type: 'track', id: 'diet', archive: true, confirm: true })).status === 200 && !(await call('GET', '/api/state')).data.list.tracks.some(t => t.id === 'diet') && (await call('GET', '/api/state')).data.archived.some(a => a.id === 'diet'), '管理一覧から外す（復元一覧に出る）');
    ok((await call('POST', '/api/archive', { type: 'track', id: 'diet', archive: false, confirm: true })).status === 200 && (await call('GET', '/api/state')).data.list.tracks.find(t => t.id === 'diet')?.hidden === true, '一覧に戻す（掲載停止中のまま）');
    it = (await call('GET', '/api/item?type=track&id=diet')).data;
    const un = await call('POST', '/api/hidden', { type: 'track', id: 'diet', rev: it.rev, hidden: false, confirm: true }); const pub2 = await call('POST', '/api/publish', { confirm: true, summary: '掲載再開：Diet' });
    ok(un.status === 200 && pub2.status === 200 && g(BARE, 'ls-tree', '-r', '--name-only', 'main').split(String.fromCharCode(10)).includes('docs/tracks/diet/index.html'), `掲載を再開して公開すると曲ページが戻る ${un.status} ${pub2.status} ${pub2.data?.error ?? ''}`);
    it = (await call('GET', '/api/item?type=album&id=kakuu-album')).data;
    ok((await call('POST', '/api/hidden', { type: 'album', id: 'kakuu-album', rev: it.rev, hidden: true, confirm: true })).status === 200 && (await call('POST', '/api/publish', { confirm: true, summary: '掲載停止：架空アルバム' })).status === 200, 'アルバムの掲載停止を公開');
    remote = g(BARE, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    ok(!g(BARE, 'show', 'main:docs/history/index.html').includes('id="kakuu-album"') && !remote.includes('docs/assets/history/kakuu-album-visual.jpg') && remote.includes('albums/kakuu-album/visual-web.jpg') && remote.includes('docs/assets/history/pip-popper-visual.jpg'), 'アルバムが消え（元データは残る）、他のアルバムの画像は消えない');
    ok(status() === '', '作業フォルダーに残りなし');
  }

  console.log('8f. 公式HPに表示する内容（歌詞・ジャケット・AIの感想、歌詞を載せない理由）');
  {
    const T = 'manner', file = `tracks/${T}/track.json`, orig = read(file);
    let it = (await call('GET', `/api/item?type=track&id=${T}`)).data;
    ok(JSON.stringify(it.display) === JSON.stringify({ lyrics: true, jacket: true, impression: true, lyricsNotice: null }) && it.notices.length === 3, '既存曲の初期値は「すべて表示」（今の表示のまま）・理由は3種類');
    const page = async () => { await call('POST', '/api/preview', { type: 'track', id: T }); return read(`.manager/preview/tracks/${T}/index.html`); };
    const before = await page(), homeBefore = read('.manager/preview/index.html'), worksBefore = read('.manager/preview/works.json');
    const save = async display => { it = (await call('GET', `/api/item?type=track&id=${T}`)).data; return call('POST', '/api/item', { type: 'track', id: T, rev: it.rev, display }); };
    const all = { lyrics: true, jacket: true, impression: true };
    let r = await save({ ...all, lyrics: false, lyricsNotice: 'general' });
    let html = await page();
    const saved = JSON.parse(read(file));
    ok(r.status === 200 && saved.lyrics === JSON.parse(orig).lyrics && saved.aiImpression === JSON.parse(orig).aiImpression && saved.display.lyrics === false, '歌詞だけ非表示で保存（歌詞・感想の原文は残る）');
    ok(!html.includes('class="lyrics-text"') && html.includes('この楽曲には一部不適切な表現が含まれるため、歌詞の掲載を控えています。') && html.includes(`assets/covers/${T}.jpg`) && html.includes('id="ai-title"'), '歌詞の代わりに①の案内、ジャケットとAIの感想は表示');
    ok(status() === `M ${file}`, '保存だけでは公開されない（docs は変わらない）');
    for (const [v, text] of [['women', 'この楽曲の歌詞は、女性の皆さまからご理解をいただくことが難しいと判断したため、掲載を控えています。'], ['broadminded', 'この楽曲の歌詞は、非常に心の広い方にしか受け止めていただけない可能性があるため、掲載を控えています。']]) {
      await save({ ...all, lyrics: false, lyricsNotice: v }); html = await page();
      ok(html.includes(text) && !html.includes('一部不適切な表現') && !html.includes('class="lyrics-text"'), `理由「${v}」の文が歌詞欄に出る`);
    }
    await save({ ...all, lyrics: false, lyricsNotice: null }); html = await page();
    ok(!html.includes('id="text"') && !html.includes('掲載を控えています') && !html.includes('href="#text"'), '「理由を表示しない」で歌詞欄ごと消える');
    const items = (await call('GET', '/api/state')).data.changes.items.filter(c => c.item === '曲「Manner」');
    ok(items.some(c => c.label === '公式HP：歌詞' && c.before === '表示する' && c.after === '表示しない') && items.some(c => c.label === '公式HP：歌詞を載せない理由' && c.after === '理由を表示しない'), '公開前の変更一覧に「公式HP：歌詞 表示する→表示しない」が出る');
    await save({ lyrics: true, jacket: false, impression: false }); html = await page();
    const home = read('.manager/preview/index.html');
    const card = home.match(new RegExp(`<li class="work[^>]*>\\s*<a class="work-link" href="tracks/${T}/index.html"[\\s\\S]*?</li>`))?.[0] ?? '';
    ok(!html.includes(`assets/covers/${T}`) && html.includes('jacket-fallback') && !html.includes('id="ai-title"') && html.includes('class="lyrics-text"'), 'ジャケット・AIの感想を非表示（曲名の表示）、歌詞を再掲載すると原文が戻る');
    ok(card !== '' && !card.includes(`covers/${T}-640`) && !card.includes('work-note'), '楽曲一覧のカードにも反映');
    ok(existsSync(path.join(WORK, '.manager', 'preview', 'assets', 'covers', `${T}-640.jpg`)) && read('.manager/preview/works.json') === worksBefore, '画像ファイル・作品一覧（PRIVATE・一般視聴が使う）は変わらない');
    ok((await save({ ...all, lyrics: false, lyricsNotice: 'free text' })).status === 400 && (await save({ lyrics: 'no' })).status === 400 && (await call('POST', '/api/item', { type: 'site', id: 'home', rev: 'x', display: all })).status !== 200, '決められた理由以外・不正な値は保存しない');
    await save(all); html = await page();
    ok(read(file) === orig && status() === '', 'すべて表示に戻すと track.json は元どおり（変更なし）');
    ok(html === before && read('.manager/preview/index.html') === homeBefore, '公開ページも変更前と同じに戻る');
  }

  console.log('8g. AIの感想を後から追加・修正・削除（制作背景とは別の欄、公開済みの曲）');
  {
    const T = 'manner', file = `tracks/${T}/track.json`, orig = read(file);
    // a published song taken in without an impression: no aiImpression key at all
    const { aiImpression: _drop, ...noImp } = JSON.parse(orig);
    writeFileSync(path.join(WORK, file), JSON.stringify(noImp, null, 2) + '\n');
    g(WORK, 'commit', '-q', '-am', 'test: song without impression'); g(WORK, 'push', '-q', 'origin', 'main');
    let it = (await call('GET', `/api/item?type=track&id=${T}`)).data;
    const field = () => it.fields.find(f => f.path[0] === 'aiImpression');
    ok(field()?.value === '' && field()?.label === 'AIの感想' && it.hasImpression === false && it.fields.some(f => f.path[0] === 'background'), '感想のない曲にも「AIの感想」欄（空）が出る・制作背景は別の欄');
    const edit = async value => { it = (await call('GET', `/api/item?type=track&id=${T}`)).data; return call('POST', '/api/item', { type: 'track', id: T, rev: it.rev, changes: [{ path: ['aiImpression'], value }] }); };
    const show = async display => { it = (await call('GET', `/api/item?type=track&id=${T}`)).data; return call('POST', '/api/item', { type: 'track', id: T, rev: it.rev, display }); };
    const page = async () => { await call('POST', '/api/preview', { type: 'track', id: T }); return read(`.manager/preview/tracks/${T}/index.html`); };
    const others = d => JSON.stringify({ ...d, aiImpression: undefined, display: undefined });
    let r = await edit('一行目の感想\r\n\r\n二行目の感想');
    let now = JSON.parse(read(file));
    ok(r.status === 200 && now.aiImpression === '一行目の感想\n\n二行目の感想' && others(now) === others(noImp), '新規入力を保存（複数行。歌詞・制作背景・音源などほかの項目は同じ）');
    let html = await page();
    ok(html.includes('id="ai-title"') && html.includes('一行目の感想') && html.includes('二行目の感想'), 'プレビューの曲ページに「AIの感想」が出る');
    const items = (await call('GET', '/api/state')).data.changes.items.filter(c => c.item === '曲「Manner」');
    ok(items.length === 1 && items[0].label === 'AIの感想' && items[0].before === '', '公開前の変更一覧に「AIの感想」（追加）が出る');
    r = await call('POST', '/api/publish', { confirm: true, summary: 'AIの感想：Manner' });
    ok(r.status === 200 && g(BARE, 'show', `main:docs/tracks/${T}/index.html`).includes('二行目の感想') && g(BARE, 'show', `main:${file}`).includes('一行目の感想'), '公開すると公式HPの曲ページに反映');
    r = await show({ lyrics: true, jacket: true, impression: false }); html = await page(); now = JSON.parse(read(file));
    ok(r.status === 200 && !html.includes('id="ai-title"') && now.aiImpression === '一行目の感想\n\n二行目の感想', '「AIの感想を表示する」を外すと非表示・文章は残る');
    it = (await call('GET', `/api/item?type=track&id=${T}`)).data;
    ok(field().value === '一行目の感想\n\n二行目の感想' && it.display.impression === false, '非表示中も編集欄に現在の文章が出る');
    r = await edit('修正した感想'); await show({ lyrics: true, jacket: true, impression: true }); html = await page(); now = JSON.parse(read(file));
    ok(r.status === 200 && html.includes('修正した感想') && !html.includes('一行目の感想') && !('display' in now), '修正して表示に戻すと修正後の文章が出る');
    r = await edit(''); html = await page(); now = JSON.parse(read(file));
    ok(r.status === 200 && now.aiImpression === null && !html.includes('id="ai-title"') && others(now) === others(noImp) && (await call('GET', `/api/item?type=track&id=${T}`)).data.hasImpression === false, '空にして保存すると削除（ほかの項目は同じ）');
    writeFileSync(path.join(WORK, file), orig);
    r = await call('POST', '/api/publish', { confirm: true, summary: '元に戻す' });
    ok(r.status === 200 && read(file) === orig && status() === '', '元の感想に戻して公開・作業フォルダーに残りなし');
  }

  console.log('8h. 公式サイトへの配信（GitHub Pages）の失敗を知らせ、内容を変えずに送り直す');
  {
    const run = (sha, st, conclusion) => ({ name: 'pages build and deployment', head_sha: sha, status: st, conclusion });
    const remoteHead = () => g(BARE, 'rev-parse', 'main');
    const ps = async () => (await call('GET', '/api/pages-status')).data;
    pagesRuns = [];
    ok((await ps()).state === 'waiting', '配信の記録がまだないときは「配信待ち」');
    pagesRuns = [run(remoteHead(), 'in_progress', null)];
    ok((await ps()).state === 'running', '配信中');
    pagesRuns = [run(remoteHead(), 'completed', 'success')];
    ok((await ps()).state === 'ok' && (await call('POST', '/api/redeploy', { confirm: true })).status === 400, '配信成功・成功しているときは送り直さない');
    pagesRuns = null;
    ok((await ps()).state === 'unknown', 'GitHubに問い合わせできないときは「不明」（失敗扱いにしない）');
    const before = remoteHead(), tree = g(BARE, 'rev-parse', 'main^{tree}');
    pagesRuns = [run(before, 'completed', 'failure'), run('0'.repeat(40), 'completed', 'success')];
    const p = await ps();
    ok(p.state === 'failed' && p.head === before.slice(0, 7) && status() === '' && (await call('GET', '/api/state')).data.changes.items.length === 0, '公開済み・未公開の変更なしでも、GitHub側の配信失敗を検出');
    ok((await call('POST', '/api/redeploy', {})).status === 400, '確認なしの送り直しは拒否');
    const r = await call('POST', '/api/redeploy', { confirm: true });
    const after = remoteHead();
    ok(r.status === 200 && after !== before && g(BARE, 'rev-parse', 'main^{tree}') === tree && g(BARE, 'log', '-1', '--format=%s', 'main').startsWith('[管理ツール] 公式サイトへの送り直し') && g(BARE, 'show', '--name-only', '--format=', 'main') === '',
      '送り直し：新しい保存点を送信し、ファイルの中身（曲データ・公式HP）は一切変わらない');
    pagesRuns = [run(after, 'completed', 'success'), run(before, 'completed', 'failure')];
    ok((await ps()).state === 'ok' && status() === '', '送り直した版の配信が成功すれば警告は消える・作業フォルダーに残りなし');
  }

  console.log('9. 終了');
  ok((await call('POST', '/api/quit')).status === 200, '終了できる');
} catch (e) {
  fail++; console.log('  NG  例外：', e.message);
} finally {
  try { srv.kill(); } catch {}
  pagesMock.close();
  await new Promise(r => setTimeout(r, 400));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n結果：合格 ${pass} / 不合格 ${fail}`);
process.exit(fail ? 1 : 0);
