// node private/dev/test-listen-admin.mjs — 一般視聴の管理 API (/admin/api/listen/...) on the mock Worker (2026-11-25).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { mockEnv } from './mock-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pp-listen-admin-')), r2 = path.join(tmp, 'r2');
mkdirSync(path.join(r2, 'audio'), { recursive: true });
let fail = 0;
const ok = (c, name) => { console.log(`${c ? 'OK ' : 'NG '} ${name}`); if (!c) fail++; };
const O = 'https://pip-popper-private.pip-popper-private.workers.dev', ADMIN = 'admin-pass-123';
const env = mockEnv({ r2Dir: r2, publicDir: path.join(here, '..', 'worker', 'public'), vars: { PRIVATE_PASSWORD: 'member-pass-1', SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: ADMIN } });
const raw = env.BUCKET.get.bind(env.BUCKET);
env.BUCKET.get = async (k, o) => { const x = await raw(k, o); if (x && k.endsWith('.jpg')) x.httpMetadata = { contentType: 'image/jpeg' }; return x; };
const req = (method, p, { cookie, headers = {}, body } = {}) => worker.fetch(new Request(O + p, { method, body, duplex: 'half', headers: { 'CF-Connecting-IP': '198.51.100.7', ...(cookie ? { Cookie: cookie } : {}), ...headers } }), env);
const mp3 = n => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4000, n)]);
const sha = b => createHash('sha256').update(b).digest('hex');
try {
  // PRIVATE: one song whose audio must stay private unless copied on purpose
  const pAudio = mp3(9); writeFileSync(path.join(r2, 'audio', 'manner-1.mp3'), pAudio);
  writeFileSync(path.join(r2, 'catalog.json'), JSON.stringify({ version: 2, rev: 3, songs: [{ id: 'manner', title: 'Manner', file: 'audio/manner-1.mp3', size: pAudio.length, type: 'audio/mpeg', sha256: sha(pAudio), duration: 200, lyrics: 'PRIVATE_ONLY_LYRIC' }], retired: [] }));
  const privateBefore = readFileSync(path.join(r2, 'catalog.json'), 'utf8');
  const login = await req('POST', '/admin/login', { headers: { Origin: O, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `password=${ADMIN}` });
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const api = async (method, p, data, extra = {}) => { const r = await req(method, '/admin/api/' + p, { cookie, headers: { 'X-PP-Admin': '1', ...(data ? { 'Content-Type': 'application/json' } : {}), ...extra.headers }, body: extra.body ?? (data ? JSON.stringify(data) : undefined) }); return { status: r.status, data: await r.json().catch(() => null) }; };

  console.log('1. 管理者以外は使えない');
  ok((await req('GET', '/admin/api/listen')).status === 401, '管理Cookieなしは401');
  ok((await req('GET', '/admin/api/listen', { cookie })).status === 403, '画面の印（X-PP-Admin）なしは403');
  let l = await api('GET', 'listen');
  ok(l.status === 200 && l.data.songs.length === 0 && l.data.privateSongs[0].id === 'manner', '一覧：一般視聴0曲、PRIVATEの曲名だけ（音源は出さない）');
  let body = await (await req('GET', '/listen/')).text();
  ok(body.includes('一般視聴は準備中です') && !body.includes('Manner'), '0曲の間は「準備中」の案内');

  console.log('2. MP3を登録しても公開されない');
  const a1 = mp3(1);
  let r = await api('POST', 'listen/manner/upload', null, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(a1.length), 'X-Sha256': sha(a1), 'X-Rev': String(l.data.rev), 'X-Duration': '95.4', 'X-Title': encodeURIComponent('Manner（短縮版）') }, body: a1 });
  ok(r.status === 200 && r.data.song.status === 'draft' && r.data.song.draft.duration === 95 && r.data.song.draft.file.startsWith('public-audio/manner-'), '登録（下書き・再生時間95秒）');
  ok(!(await (await req('GET', '/listen/')).text()).includes('Manner'), '登録しただけでは一般視聴に出ない');
  ok((await api('POST', 'listen/manner/upload', null, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '5', 'X-Sha256': sha(Buffer.from('hello')), 'X-Rev': String(r.data ? 1 : 0), 'X-Title': 'x' }, body: Buffer.from('hello') })).status === 422, 'MP3でないファイルは拒否');
  let rev = (await api('GET', 'listen')).data.rev;
  ok((await api('POST', 'listen/manner/settings', { rev: rev - 1, items: {} })).status === 409, '古い画面からの保存は拒否');
  const jpg = Buffer.from([255, 216, 255, 224, 0, 16, 1, 2, 3, 255, 217]).toString('base64');
  r = await api('POST', 'listen/manner/settings', { rev, items: { lyrics: true, jacket: true, impression: false }, lyrics: 'PUBLIC_LYRIC_LINE', impression: 'IMPRESSION_NOT_SHOWN', jacket: jpg });
  ok(r.status === 200 && r.data.song.draft.items.lyrics && r.data.song.draft.hasJacket && !r.data.song.draft.hasImpression, '公開項目：歌詞・ジャケットは公開、AIの感想は非公開');
  ok(!(await (await req('GET', '/listen/')).text()).includes('Manner'), '項目を保存しても公開されない');

  console.log('3. 公開・停止・再開');
  ok((await api('POST', 'listen/manner/publish', { rev: r.data ? (await api('GET', 'listen')).data.rev : 0 })).status === 400, '確認なしでは公開しない');
  rev = (await api('GET', 'listen')).data.rev;
  r = await api('POST', 'listen/manner/publish', { rev, confirm: true });
  body = await (await req('GET', '/listen/')).text();
  ok(r.status === 200 && r.data.song.status === 'published' && body.includes('Manner（短縮版）') && body.includes('PUBLIC_LYRIC_LINE') && !body.includes('IMPRESSION_NOT_SHOWN') && !body.includes('PRIVATE_ONLY_LYRIC'), '公開：曲名・歌詞が出る（感想・PRIVATEの歌詞は出ない）');
  let audio = await req('GET', '/listen/audio/manner.mp3', { headers: { Range: 'bytes=0-9' } });
  ok(audio.status === 206 && Buffer.from(await audio.arrayBuffer()).equals(a1.subarray(0, 10)), '誰でも再生できる（一般視聴用の音源。PRIVATEの音源ではない）');
  ok((await req('GET', '/listen/jacket/manner')).status === 200, 'ジャケットが出る');
  rev = (await api('GET', 'listen')).data.rev;
  r = await api('POST', 'listen/manner/stop', { rev });
  ok(r.status === 200 && !(await (await req('GET', '/listen/')).text()).includes('Manner') && (await req('GET', '/listen/audio/manner.mp3')).status === 404, '掲載停止：ページから消え、音源も聴けない');
  r = await api('POST', 'listen/manner/resume', { rev: r.data.rev });
  ok(r.status === 200 && (await (await req('GET', '/listen/')).text()).includes('Manner（短縮版）'), '掲載再開');

  console.log('4. 差し替え・以前の版に戻す');
  const a2 = mp3(2);
  r = await api('POST', 'listen/manner/upload', null, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(a2.length), 'X-Sha256': sha(a2), 'X-Rev': String(r.data.rev), 'X-Duration': '120', 'X-Title': encodeURIComponent('Manner（編集版）') }, body: a2 });
  audio = await req('GET', '/listen/audio/manner.mp3');
  ok(r.status === 200 && r.data.song.changed && Buffer.from(await audio.arrayBuffer()).equals(a1), '差し替えの音源は下書き：公開中は前の音源のまま');
  r = await api('POST', 'listen/manner/publish', { rev: r.data.rev, confirm: true });
  audio = await req('GET', '/listen/audio/manner.mp3');
  ok(r.status === 200 && Buffer.from(await audio.arrayBuffer()).equals(a2) && r.data.song.history.length === 1 && r.data.song.live.items.lyrics, '公開で新しい音源に（前の版は履歴に残る、公開項目も引き継ぐ）');
  r = await api('POST', 'listen/manner/restore', { rev: r.data.rev, index: 0 });
  ok(r.status === 200 && r.data.song.draft.duration === 95, '履歴の版を下書きに戻す');
  r = await api('POST', 'listen/manner/publish', { rev: r.data.rev, confirm: true });
  ok(Buffer.from(await (await req('GET', '/listen/audio/manner.mp3')).arrayBuffer()).equals(a1), '戻した版を公開');

  console.log('5. 一覧から外す・戻す／PRIVATEからのコピー');
  ok((await api('POST', 'listen/manner/remove', { rev: r.data.rev })).status === 400, '確認なしでは外さない');
  r = await api('POST', 'listen/manner/remove', { rev: r.data.rev, confirm: true });
  ok(r.status === 200 && r.data.song.status === 'removed' && !(await (await req('GET', '/listen/')).text()).includes('Manner'), '外す（一般視聴に出ない、データは残る）');
  r = await api('POST', 'listen/manner/undelete', { rev: r.data.rev });
  ok(r.status === 200 && r.data.song.status === 'stopped', '戻す（停止中として戻る。再開で公開）');
  ok((await api('POST', 'listen/manner/copy-private', { rev: r.data.rev, confirm: 'はい' })).status === 400, 'PRIVATEのコピーは確認の言葉が必要');
  r = await api('POST', 'listen/manner/copy-private', { rev: r.data.rev, confirm: 'PRIVATEの音源を一般視聴用にコピーする' });
  ok(r.status === 200 && r.data.song.draft.source === 'private' && r.data.song.draft.file !== 'audio/manner-1.mp3' && existsSync(path.join(r2, r.data.song.draft.file)), 'PRIVATEの音源を別ファイルとしてコピー（下書き）');
  ok(readFileSync(path.join(r2, 'catalog.json'), 'utf8') === privateBefore && readFileSync(path.join(r2, 'audio', 'manner-1.mp3')).equals(pAudio), 'PRIVATEの曲目と音源は変わらない');
  ok((await req('GET', '/listen/audio/manner.mp3')).status === 404 && (await req('GET', '/audio/manner')).status === 401, '停止中は一般から聴けない・PRIVATEは入室が必要なまま');
  ok((await req('GET', '/listen/public-manage.json')).status === 404, '管理記録は一般から読めない');
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(fail ? `不合格 ${fail}` : 'すべて合格');
process.exitCode = fail ? 1 : 0;
