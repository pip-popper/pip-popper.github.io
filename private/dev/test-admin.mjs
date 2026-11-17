// Automated checks for PIP POPPER PRIVATE (invitee side + admin screen) against the local imitation of Cloudflare.
//   node private/dev/test-admin.mjs
// Uses a temporary folder only; real R2, Manner and the originals are never touched.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { storeUpload } from '../worker/src/catalog.js';
import { mockEnv } from './mock-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pp-admin-test-'));
const r2 = path.join(tmp, 'r2');
let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'OK ' : 'NG '} ${name}${cond || !detail ? '' : `  → ${detail}`}`); if (!cond) failures++; };
const sha = b => createHash('sha256').update(b).digest('hex');
// Silent MPEG-1 Layer III frames; `seconds` changes the length, `tag` makes the bytes unique.
const mp3 = (seconds, tag = 0) => { const f = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc0]), Buffer.alloc(413)]); const b = Buffer.concat(Array(Math.round(seconds * 38.28)).fill(f)); b[100] = tag; return b; };

// Same state as production today: the legacy (version 1) list with Manner at audio/manner.mp3.
const manner = mp3(20, 1);
mkdirSync(path.join(r2, 'audio'), { recursive: true });
writeFileSync(path.join(r2, 'audio', 'manner.mp3'), manner);
writeFileSync(path.join(r2, 'catalog.json'), JSON.stringify({ updated: '2026-11-17T14:54:09.574Z', songs: [
  { id: 'manner', title: 'Manner', file: 'audio/manner.mp3', size: manner.length, type: 'audio/mpeg', cover: 'https://pip-popper.github.io/assets/covers/manner-640.jpg' }] }));
const works = [{ id: 'distance', title: 'Distance', cover: 'https://pip-popper.github.io/assets/covers/distance-640.jpg' },
  { id: 'manner', title: 'Manner', cover: 'https://pip-popper.github.io/assets/covers/manner-640.jpg' }];
const vars = { PRIVATE_PASSWORD: 'member-pass-123456', SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: 'admin-pass-abcdef' };
let corruptNext = false;
const env = mockEnv({ r2Dir: r2, publicDir: path.join(here, '..', 'worker', 'public'), vars,
  worksUrl: `data:application/json,${encodeURIComponent(JSON.stringify(works))}`,
  hooks: { corrupt: key => { if (corruptNext && key.startsWith('audio/')) { corruptNext = false; return true; } return false; } } });

const O = 'http://localhost';
async function call(method, p, { cookie, headers = {}, body, ip = '198.51.100.10' } = {}) {
  const res = await worker.fetch(new Request(O + p, { method, body, duplex: body ? 'half' : undefined,
    headers: { Origin: O, 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers } }), env);
  return res;
}
const cookieOf = res => (res.headers.get('set-cookie') ?? '').split(';')[0];
const login = async (p, pw, ip) => call('POST', p, { body: new URLSearchParams({ password: pw }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ip });
const api = (method, p, admin, data) => call(method, `/admin/api/${p}`, { cookie: admin, headers: { 'X-PP-Admin': '1', ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
const put = (p, admin, buf, hash = sha(buf)) => call(p.method, `/admin/api/${p.url}`, { cookie: admin, headers: { 'X-PP-Admin': '1', 'X-Sha256': hash, 'Content-Length': String(buf.length), 'X-Duration': '20' }, body: buf });
const catalogFile = () => JSON.parse(readFileSync(path.join(r2, 'catalog.json'), 'utf8'));
const audioKeys = () => readdirSync(path.join(r2, 'audio')).map(f => `audio/${f}`).sort();
const get = async (admin) => (await api('GET', 'catalog', admin)).json();

// ── 0. Before ADMIN_PASSWORD exists / when it equals the member password ──
{
  const saved = env.ADMIN_PASSWORD;
  delete env.ADMIN_PASSWORD; ok('管理者パスワード未設定なら管理画面は閉じる（503）', (await call('GET', '/admin')).status === 503);
  env.ADMIN_PASSWORD = vars.PRIVATE_PASSWORD; ok('招待者と同じ管理者パスワードは使えない（503）', (await call('GET', '/admin')).status === 503);
  env.ADMIN_PASSWORD = saved;
}
// ── 1. Invitee side is unchanged ──
const member = cookieOf(await login('/login', vars.PRIVATE_PASSWORD));
{
  const page = await (await call('GET', '/', { cookie: member })).text();
  ok('招待者：旧形式の曲目でMannerを表示', page.includes('Manner') && /\/audio\/manner\?v=/.test(page));
  const a = await call('GET', '/audio/manner', { cookie: member });
  ok('招待者：Mannerを再生できる（中身一致）', a.status === 200 && sha(Buffer.from(await a.arrayBuffer())) === sha(manner));
  ok('招待者：未入室は401', (await call('GET', '/audio/manner')).status === 401);
}
// ── 2. Admin sign-in and protection ──
{
  ok('管理：誤パスワードは401', (await login('/admin/login', 'wrong-password-x', '198.51.100.20')).status === 401);
  ok('管理：招待者パスワードでは入れない', (await login('/admin/login', vars.PRIVATE_PASSWORD, '198.51.100.20')).status === 401);
}
const res = await login('/admin/login', vars.ADMIN_PASSWORD);
const admin = cookieOf(res);
const sc = res.headers.get('set-cookie') ?? '';
ok('管理：正しいパスワードで入室（Path=/admin・SameSite=Strict・HttpOnly）', res.status === 303 && /Path=\/admin/.test(sc) && /SameSite=Strict/.test(sc) && /HttpOnly/.test(sc));
ok('管理：管理画面が表示される', (await (await call('GET', '/admin', { cookie: admin })).text()).includes('楽曲の管理'));
ok('管理API：入室なしは401', (await call('GET', '/admin/api/catalog', { headers: { 'X-PP-Admin': '1' } })).status === 401);
ok('管理API：招待者Cookieでは401', (await call('GET', '/admin/api/catalog', { cookie: member, headers: { 'X-PP-Admin': '1' } })).status === 401);
ok('管理API：専用ヘッダーなしは403', (await call('GET', '/admin/api/catalog', { cookie: admin })).status === 403);
ok('管理API：他サイトからは403', (await call('GET', '/admin/api/catalog', { cookie: admin, headers: { 'X-PP-Admin': '1', Origin: 'https://evil.example' } })).status === 403);
ok('招待者側：管理Cookieでは音源は401', (await call('GET', '/audio/manner', { cookie: admin })).status === 401);

let view = await get(admin);
ok('移行：旧形式を rev 0 として読み込み、Mannerの音源更新日時を引き継ぐ', view.rev === 0 && view.songs[0].id === 'manner' && view.songs[0].audioUpdatedAt === '2026-11-17T14:54:09.574Z');
ok('移行：読み込みだけでは曲目ファイルを書き換えない', !('rev' in catalogFile()));

// ── 3. Replace audio (the most important operation) ──
const v1 = mp3(25, 2);
{
  const before = audioKeys();
  corruptNext = true;
  const r = await put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev}` }, admin, v1);
  ok('差し替え：通信中に壊れた音源は拒否（422）', r.status === 422, String(r.status));
  ok('差し替え：失敗後も曲目は元のまま', !('rev' in catalogFile()) && catalogFile().songs[0].file === 'audio/manner.mp3');
  ok('差し替え：失敗後も旧音源を再生できる', sha(Buffer.from(await (await call('GET', '/audio/manner', { cookie: member })).arrayBuffer())) === sha(manner));
  ok('差し替え：失敗した新音源はR2に残らない', JSON.stringify(audioKeys()) === JSON.stringify(before), audioKeys().join(','));
}
{
  const r = await put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev}` }, admin, Buffer.from('not an mp3 file at all'));
  ok('差し替え：MP3でないファイルは拒否（422）、残さない', r.status === 422 && audioKeys().length === 1);
  const r2b = await put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev}` }, admin, v1, 'a'.repeat(64));
  ok('差し替え：指紋が一致しないものは拒否（422）', r2b.status === 422 && audioKeys().length === 1);
  const r3 = await put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev + 5}` }, admin, v1);
  ok('差し替え：古い画面の版番号では行わない（409）、残さない', r3.status === 409 && audioKeys().length === 1);
  let big = false;
  try { await storeUpload({ headers: new Headers({ 'Content-Length': String(60 * 1048576), 'X-Sha256': 'a'.repeat(64) }) }, env, 'manner'); } catch (e) { big = e.status === 413; }
  ok('差し替え：50MBを超えるファイルは拒否（413）', big);
}
const oldPage = await (await call('GET', '/', { cookie: member })).text();
{
  const r = await put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev}` }, admin, v1);
  const data = await r.json();
  ok('差し替え：成功（200）', r.status === 200 && data.message === '音源を差し替えました。', JSON.stringify(data));
  const song = catalogFile().songs[0];
  ok('差し替え：曲名・ジャケット・並び順は変わらない', song.id === 'manner' && song.title === 'Manner' && song.cover.endsWith('manner-640.jpg') && catalogFile().songs.length === 1);
  ok('差し替え：曲目は新しい音源を指し、大きさ・指紋・日時を記録', song.file !== 'audio/manner.mp3' && song.size === v1.length && song.sha256 === sha(v1) && song.audioUpdatedAt > '2026-11-17T14:54:09.574Z');
  const a = await call('GET', '/audio/manner', { cookie: member });
  ok('差し替え：招待者には新しい音源が届く', sha(Buffer.from(await a.arrayBuffer())) === sha(v1));
  const newPage = await (await call('GET', '/', { cookie: member })).text();
  const vOld = /\/audio\/manner\?v=([^"&]+)/.exec(oldPage)[1], vNew = /\/audio\/manner\?v=([^"&]+)/.exec(newPage)[1];
  ok('差し替え：音源のアドレスが変わる（古いキャッシュを使わない）', vOld !== vNew);
  ok('差し替え：配信は保存禁止（no-store）', (a.headers.get('cache-control') ?? '').includes('no-store'));
  ok('差し替え：旧音源はすぐには消さず、削除待ちとして記録', existsSync(path.join(r2, 'audio', 'manner.mp3')) && catalogFile().retired.some(x => x.file === 'audio/manner.mp3' && x.reason === 'replaced'));
  view = data;
}
// ── 4. Two screens / two devices at the same time ──
{
  const a = mp3(21, 3), b = mp3(22, 4);
  const [ra, rb] = await Promise.all([put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev}` }, admin, a), put({ method: 'PUT', url: `songs/manner/audio?rev=${view.rev}` }, admin, b)]);
  const codes = [ra.status, rb.status].sort().join(',');
  ok('同時差し替え：片方だけ成功し、もう片方は409', codes === '200,409', codes);
  const winner = ra.status === 200 ? a : b;
  ok('同時差し替え：曲目は成功した方の音源', catalogFile().songs[0].sha256 === sha(winner));
  const referenced = new Set([...catalogFile().songs.map(s => s.file), ...catalogFile().retired.map(r => r.file)]);
  ok('同時差し替え：負けた方の音源はR2に残らない', audioKeys().every(k => referenced.has(k)), audioKeys().join(','));
  view = await get(admin);
}
{
  const add = await put({ method: 'POST', url: `songs?rev=${view.rev}&work=distance` }, admin, mp3(18, 5));
  const data = await add.json();
  ok('追加：公式サイトの作品から追加（曲名・ジャケットは作品一覧から）', add.status === 200 && catalogFile().songs.some(s => s.id === 'distance' && s.title === 'Distance' && s.cover.endsWith('distance-640.jpg')));
  ok('追加：同じ曲は二重に追加できない（409）', (await put({ method: 'POST', url: `songs?rev=${data.rev}&work=distance` }, admin, mp3(18, 6))).status === 409);
  const custom = await put({ method: 'POST', url: `songs?rev=${data.rev}&title=${encodeURIComponent('新曲（仮）')}` }, admin, mp3(10, 7));
  ok('追加：公式サイトにない曲も曲名だけで追加', custom.status === 200 && catalogFile().songs.some(s => s.title === '新曲（仮）' && /^song-[0-9a-f]{8}$/.test(s.id) && !s.cover));
  view = await get(admin);
}
{
  const ids = view.songs.map(s => s.id);
  const [x, y] = await Promise.all([api('POST', 'order', admin, { rev: view.rev, ids: [...ids].reverse() }), api('POST', 'order', admin, { rev: view.rev, ids: [ids[1], ids[0], ids[2]] })]);
  const codes = [x.status, y.status].sort().join(',');
  ok('同時の並べ替え：片方だけ保存し、上書き消失なし（200,409）', codes === '200,409', codes);
  view = await get(admin);
  ok('並べ替え：曲が欠けたり増えたりした一覧は拒否（409）', (await api('POST', 'order', admin, { rev: view.rev, ids: view.songs.slice(1).map(s => s.id) })).status === 409);
  const r = await api('POST', 'order', admin, { rev: view.rev, ids: ['manner', ...view.songs.map(s => s.id).filter(i => i !== 'manner')] });
  ok('並べ替え：保存され、招待者の一覧にも反映', r.status === 200 && (await (await call('GET', '/', { cookie: member })).text()).indexOf('Manner') < (await (await call('GET', '/', { cookie: member })).text()).indexOf('Distance'));
  view = await r.json();
}
// ── 5. Remove and restore ──
{
  const before = view.songs.map(s => s.id);
  const r = await api('POST', 'songs/distance/remove', admin, { rev: view.rev });
  view = await r.json();
  ok('外す：一覧から消え、招待者は再生できない', r.status === 200 && !view.songs.some(s => s.id === 'distance') && (await call('GET', '/audio/distance', { cookie: member })).status === 404);
  ok('外す：「外した曲」に24時間表示、音源はまだ残す', view.removed.some(x => x.id === 'distance') && audioKeys().some(k => k.startsWith('audio/distance-')));
  const back = await api('POST', 'restore', admin, { rev: view.rev, file: view.removed[0].file });
  view = await back.json();
  ok('戻す：元の位置に戻り、再生できる', back.status === 200 && JSON.stringify(view.songs.map(s => s.id)) === JSON.stringify(before) && (await call('GET', '/audio/distance', { cookie: member })).status === 200);
}
// ── 6. Safe cleanup of unused files ──
{
  const keysBefore = audioKeys();
  await get(admin); await call('GET', '/admin', { cookie: admin }); await call('GET', '/', { cookie: member });
  ok('整理：画面を開いただけでは何も削除しない', JSON.stringify(audioKeys()) === JSON.stringify(keysBefore));
  // Make the replaced files 25 hours old, add one 25-hour-old stray upload and one fresh stray upload.
  const cat = catalogFile();
  for (const x of cat.retired) x.at = new Date(Date.now() - 25 * 3600e3).toISOString();
  writeFileSync(path.join(r2, 'catalog.json'), JSON.stringify(cat));
  const oldStray = 'audio/manner-old-stray.mp3', newStray = 'audio/manner-new-stray.mp3';
  await env.BUCKET.put(oldStray, mp3(1, 8)); await env.BUCKET.put(newStray, mp3(1, 9));
  const metaFile = path.join(r2, '.meta', `${encodeURIComponent(oldStray)}.json`);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')); meta.uploaded = new Date(Date.now() - 25 * 3600e3).toISOString(); writeFileSync(metaFile, JSON.stringify(meta));
  const live = new Set(catalogFile().songs.map(s => s.file));
  view = await get(admin);
  const r = await api('POST', 'order', admin, { rev: view.rev, ids: view.songs.map(s => s.id) });   // any change runs the cleanup
  view = await r.json();
  const now = audioKeys();
  ok('整理：24時間を過ぎた旧音源（差し替え前のMannerなど）を削除', !now.includes('audio/manner.mp3') && catalogFile().retired.length === 0, now.join(','));
  ok('整理：24時間を過ぎた迷子ファイルを削除', !now.includes(oldStray));
  ok('整理：新しい迷子ファイル（アップロード直後かもしれない）は残す', now.includes(newStray));
  ok('整理：どの曲かが使っている音源は絶対に消さない', [...live].every(k => now.includes(k)));
  for (const s of view.songs) ok(`整理後も再生できる：${s.title}`, (await call('GET', `/audio/${s.id}`, { cookie: member })).status === 200);
}
{
  const r = await api('POST', 'songs/distance/remove', admin, { rev: view.rev });
  view = await r.json();
  const cat = catalogFile(); cat.retired[0].at = new Date(Date.now() - 23.5 * 3600e3).toISOString(); writeFileSync(path.join(r2, 'catalog.json'), JSON.stringify(cat));
  const late = await api('POST', 'restore', admin, { rev: (await get(admin)).rev, file: cat.retired[0].file });
  ok('戻す：23時間を過ぎたら戻せない（削除直前の安全余裕）', late.status === 410);
}
// ── 7. Admin lockout (separate from invitees) ──
{
  const ip = '203.0.113.77';
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await login('/admin/login', `wrong-${i}-xxxxxxxx`, ip)).status);
  ok('管理ロック：5回失敗でロック（429）、6回目も429', codes.slice(0, 4).every(c => c === 401) && codes[4] === 429 && codes[5] === 429, codes.join(','));
  ok('管理ロック：ロック中は正しいパスワードでも入れない', (await login('/admin/login', vars.ADMIN_PASSWORD, ip)).status === 429);
  ok('管理ロック：同じ回線でも招待者の入室には影響しない', (await login('/login', vars.PRIVATE_PASSWORD, ip)).status === 303);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} 件 NG` : '\nすべて合格');
process.exitCode = failures ? 1 : 0;
