// node private/dev/test-listen.mjs — the no-password listening page at /listen/ of the PRIVATE Worker (2026-11-24).
// Only the public catalog and the approved public copies may be reachable; PRIVATE data must stay behind the login.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { mockEnv } from './mock-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pp-listen-'));
const r2 = path.join(tmp, 'r2');
mkdirSync(r2, { recursive: true });
let fail = 0;
const ok = (c, name) => { console.log(`${c ? 'OK ' : 'NG '} ${name}`); if (!c) fail++; };
const O = 'https://pip-popper-private.pip-popper-private.workers.dev';
const env = mockEnv({ r2Dir: r2, publicDir: path.join(here, '..', 'worker', 'public'), vars: { PRIVATE_PASSWORD: 'member-pass-1', SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: 'admin-pass-1' } });
// the mock bucket keeps no content type; real R2 returns the one given at upload
const rawGet = env.BUCKET.get.bind(env.BUCKET);
env.BUCKET.get = async (k, o) => { const x = await rawGet(k, o); if (x && k.endsWith('.jpg')) x.httpMetadata = { contentType: 'image/jpeg' }; return x; };
const get = (p, headers = {}) => worker.fetch(new Request(O + p, { headers: { 'CF-Connecting-IP': '198.51.100.9', ...headers } }), env);
const available = async () => { const r = await get('/listen/available.json'); return { status: r.status, cors: r.headers.get('Access-Control-Allow-Origin'), text: await r.text() }; };
const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 1)]);
const put = (key, body, type) => env.BUCKET.put(key, body, { httpMetadata: { contentType: type } });

try {
  // PRIVATE side: one song with lyrics that must never appear on the public page
  await put('audio/secret-song-1.mp3', mp3, 'audio/mpeg');
  await put('catalog.json', JSON.stringify({ version: 2, rev: 1, songs: [{ id: 'secret-song', title: 'PRIVATE_ONLY_TITLE', file: 'audio/secret-song-1.mp3', size: mp3.length, type: 'audio/mpeg', lyrics: 'PRIVATE_ONLY_LYRIC', cover: null }], retired: [] }), 'application/json');

  console.log('1. 公開カタログがない間');
  let r = await get('/listen/');
  let body = await r.text();
  ok(r.status === 200 && !body.includes('type="password"') && !body.includes('PRIVATE_ONLY'), 'パスワードなしで開け、曲は0件（PRIVATEの曲は出ない）');
  ok((await get('/listen')).status === 303 || (await get('/listen')).status === 302, '/listen は /listen/ へ案内');
  let a = await available();
  ok(a.status === 200 && JSON.parse(a.text).ids.length === 0 && !a.text.includes('secret-song'), '公式サイト用の公開中ID一覧：0曲（PRIVATEの曲は入らない）');

  console.log('2. 承認済みの公開コピーだけが出る');
  await put('public-audio/manner.mp3', mp3, 'audio/mpeg');
  await put('public-jackets/manner.jpg', Buffer.from([255, 216, 255, 217]), 'image/jpeg');
  await put('public-catalog.json', JSON.stringify({ version: 1, songs: [
    { id: 'manner', title: 'Manner', classification: 'general', publicAudioApproved: true, audioKey: 'public-audio/manner.mp3', size: mp3.length, lyricsScope: 'public', publicLyricsApproved: true, lyrics: 'PUBLIC_LYRIC', jacketKey: 'public-jackets/manner.jpg', publicJacketApproved: true },
    { id: 'not-approved', title: 'NOT_APPROVED_TITLE', classification: 'general', publicAudioApproved: false, audioKey: 'public-audio/not-approved.mp3', size: 10 },
    { id: 'secret-song', title: 'POINTS_AT_PRIVATE', classification: 'general', publicAudioApproved: true, audioKey: 'audio/secret-song-1.mp3', size: mp3.length },
  ] }), 'application/json');
  body = await (await get('/listen/')).text();
  ok(body.includes('Manner') && body.includes('PUBLIC_LYRIC') && (body.match(/class="pv-item"/g) || []).length === 1, '承認済みの1曲（歌詞つき）だけ表示');
  ok(!body.includes('NOT_APPROVED_TITLE') && !body.includes('POINTS_AT_PRIVATE') && !body.includes('PRIVATE_ONLY'), '未承認の曲・PRIVATEの場所を指す曲・PRIVATEの曲名と歌詞は出ない');
  r = await get('/listen/audio/manner.mp3', { Range: 'bytes=0-9' });
  ok(r.status === 206 && r.headers.get('Content-Type') === 'audio/mpeg' && !/attachment/.test(r.headers.get('Content-Disposition') ?? ''), '公開音源は再生できる（Range対応・ダウンロード指定なし）');
  ok((await get('/listen/audio/manner.mp3?download=1')).headers.get('Content-Disposition')?.startsWith('inline'), 'download=1 でも保存用にはならない');
  ok((await get('/listen/jacket/manner')).status === 200, '承認済みのジャケットは表示できる');
  a = await available();
  ok(a.status === 200 && a.cors === '*' && a.text === '{"version":1,"ids":["manner"]}', '公開中ID一覧：承認済みの曲のIDだけ（曲名・歌詞・未承認・PRIVATEを指す曲は入らない）');
  ok(body.includes('id="song-manner"'), '一般視聴ページの曲に #song-<ID> の目印がある（公式サイトの「試聴する」の行き先）');

  console.log('2b. 公開・停止に合わせて自動で切り替わる');
  await put('public-catalog.json', JSON.stringify({ version: 1, songs: [] }), 'application/json');
  ok(JSON.parse((await available()).text).ids.length === 0, '掲載を停止すると一覧から消える');
  const broken = env.BUCKET.get; env.BUCKET.get = async k => k === 'public-catalog.json' ? { json: async () => ({ version: 9 }) } : broken(k);
  a = await available();
  ok(a.status === 503 && !a.cors, '公開カタログが壊れていたら503（公式サイトはリンクを出さない）');
  env.BUCKET.get = broken;
  await put('public-catalog.json', JSON.stringify({ version: 1, songs: [
    { id: 'manner', title: 'Manner', classification: 'general', publicAudioApproved: true, audioKey: 'public-audio/manner.mp3', size: mp3.length, lyricsScope: 'public', publicLyricsApproved: true, lyrics: 'PUBLIC_LYRIC', jacketKey: 'public-jackets/manner.jpg', publicJacketApproved: true },
  ] }), 'application/json');
  ok(JSON.parse((await available()).text).ids.join() === 'manner', '再び公開すると一覧に戻る');

  console.log('3. 公開側からPRIVATEには届かない');
  ok((await get('/listen/audio/secret-song.mp3')).status === 404, 'PRIVATEの曲IDを指定しても404');
  ok((await get('/listen/audio/not-approved.mp3')).status === 404, '未承認の曲は404');
  for (const p of ['/listen/catalog.json', '/listen/public-catalog.json', '/listen/admin', '/listen/admin/api/private-password', '/listen/audio/secret-song-1.mp3', '/listen/../audio/secret-song', '/listen/%2e%2e/audio/secret-song'])
    ok([400, 401, 404, 405].includes((await get(p)).status), `取得不可：${p}`);   // '..' is resolved to a PRIVATE path, which asks for the login (401)
  const { publicOnly } = await import('../worker/src/index.js');
  const view = publicOnly(env.BUCKET);
  ok(await view.get('catalog.json') === null && await view.get('audio/secret-song-1.mp3') === null && await view.get('auth/private-password.json') === null && await view.get('public-catalog.json') !== null, '公開用の読み取り口は public-* 以外を返さない');

  console.log('4. PRIVATEは今までどおり');
  ok((await get('/audio/secret-song')).status === 401, 'PRIVATEの音源は入室なしで401');
  body = await (await get('/')).text();
  ok(body.includes('type="password"') && !body.includes('PRIVATE_ONLY_TITLE'), 'PRIVATEの入口はパスワード欄（曲は見えない）');
  const login = await worker.fetch(new Request(O + '/login', { method: 'POST', headers: { Origin: O, 'CF-Connecting-IP': '198.51.100.9', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=member-pass-1' }), env);
  const cookie = (login.headers.get('Set-Cookie') ?? '').split(';')[0];
  body = await (await get('/', { Cookie: cookie })).text();
  ok(login.status === 303 && body.includes('PRIVATE_ONLY_TITLE') && !body.includes('Manner'), '入室するとPRIVATEの曲だけ（公開カタログは混ざらない）');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fail ? `不合格 ${fail}` : 'すべて合格');
process.exitCode = fail ? 1 : 0;
