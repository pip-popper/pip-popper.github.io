// Automated checks for the invitee password change (manager tool → Worker → private R2), on the local imitation.
//   node private/dev/test-password.mjs
// Uses a temporary folder only; real R2 and the real passwords are never touched.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { mockEnv } from './mock-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pp-password-test-'));
const r2 = path.join(tmp, 'r2');
let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? 'OK ' : 'NG '} ${name}${cond || !detail ? '' : `  → ${detail}`}`); if (!cond) failures++; };
const mp3 = Buffer.concat(Array(400).fill(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0xc0]), Buffer.alloc(413)])));
mkdirSync(path.join(r2, 'audio'), { recursive: true });
writeFileSync(path.join(r2, 'audio', 'manner.mp3'), mp3);
writeFileSync(path.join(r2, 'catalog.json'), JSON.stringify({ updated: '2026-11-17T14:54:09.574Z', songs: [
  { id: 'manner', title: 'Manner', file: 'audio/manner.mp3', size: mp3.length, type: 'audio/mpeg', cover: 'https://pip-popper.github.io/assets/covers/manner-640.jpg' }] }));
const OLD = 'member-pass-123456', NEW = 'brand-new-pass-7890', ADMIN = 'admin-pass-abcdef';
let failRead = false;
const env = mockEnv({ r2Dir: r2, publicDir: path.join(here, '..', 'worker', 'public'),
  vars: { PRIVATE_PASSWORD: OLD, SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: ADMIN },
  hooks: { beforeGet: key => { if (failRead && key.startsWith('auth/')) throw new Error('R2 unavailable'); } } });

const O = 'http://localhost';
const call = (method, p, { cookie, headers = {}, body, ip = '198.51.100.20', origin = O } = {}) => worker.fetch(new Request(O + p, { method, body,
  headers: { ...(origin ? { Origin: origin } : {}), 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers } }), env);
const cookieOf = res => (res.headers.get('set-cookie') ?? '').split(';')[0];
const login = (p, pw, ip) => call('POST', p, { body: new URLSearchParams({ password: pw }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ip });
const pwApi = (p, admin, data, extra = {}) => call(p === 'status' ? 'GET' : 'POST', `/admin/api/private-password${p === 'restore' ? '/restore' : ''}`,
  { cookie: admin, headers: { 'X-PP-Admin': '1', 'Content-Type': 'application/json', ...(extra.headers ?? {}) }, body: p === 'status' ? undefined : JSON.stringify(data), ...extra });
const entered = async c => (await call('GET', '/audio/manner', { cookie: c })).status === 200;
const credFile = path.join(r2, 'auth', 'private-password.json');

console.log('1. 初期状態（R2に照合情報なし）');
const m0 = await login('/login', OLD);
const member0 = cookieOf(m0);
ok('今のパスワード（Cloudflareのシークレット）で入室できる', m0.status === 303 && member0.startsWith('pp_private='));
ok('入室後に音源が再生できる', await entered(member0));
const admin = cookieOf(await login('/admin/login', ADMIN, '198.51.100.30'));
ok('管理者として入室できる', admin.startsWith('pp_admin='));
let r = await pwApi('status', admin);
ok('状態：Cloudflareのパスワードを使用中', r.status === 200 && (await r.json()).mode === 'secret');
ok('R2に照合情報のファイルはない', !existsSync(credFile));

console.log('2. 不正な要求は拒否');
ok('管理Cookieなしは401', (await pwApi('change', '', { newPassword: NEW, adminPassword: ADMIN })).status === 401);
ok('招待者のCookieでは401', (await pwApi('change', member0, { newPassword: NEW, adminPassword: ADMIN })).status === 401);
ok('ほかのサイトからの要求（Origin違い）は403', (await pwApi('change', admin, { newPassword: NEW, adminPassword: ADMIN }, { origin: 'https://evil.example' })).status === 403);
ok('画面の専用ヘッダーなしは403', (await call('POST', '/admin/api/private-password', { cookie: admin, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: NEW, adminPassword: ADMIN }) })).status === 403);
r = await pwApi('change', admin, { newPassword: NEW, adminPassword: 'wrong-admin-password' });
ok('管理者パスワードが違うと変更できない（403）', r.status === 403 && /管理者パスワードが違います/.test((await r.json()).error));
ok('短すぎるパスワードは拒否', (await pwApi('change', admin, { newPassword: 'short', adminPassword: ADMIN })).status === 400);
ok('前後の空白は拒否', (await pwApi('change', admin, { newPassword: ` ${NEW}`, adminPassword: ADMIN })).status === 400);
ok('管理者パスワードと同じものは拒否', (await pwApi('change', admin, { newPassword: ADMIN, adminPassword: ADMIN })).status === 400);
ok('ここまでで何も変わっていない（R2なし・今のパスワードで入れる）', !existsSync(credFile) && (await login('/login', OLD, '198.51.100.21')).status === 303);

console.log('3. 変更');
r = await pwApi('change', admin, { newPassword: NEW, adminPassword: ADMIN });
const changed = await r.json();
ok('新しいパスワードへの変更が成功', r.status === 200 && changed.ok && changed.mode === 'r2');
const stored = readFileSync(credFile, 'utf8');
ok('R2の照合情報にパスワードそのものは入っていない', !stored.includes(NEW) && !stored.includes(OLD) && /"hash"/.test(stored) && /"salt"/.test(stored));
ok('変更前のログインCookieは直ちに無効（音源401）', (await call('GET', '/audio/manner', { cookie: member0 })).status === 401);
ok('変更前のCookieではライブラリでなく入室画面', /type="password"/.test(await (await call('GET', '/', { cookie: member0 })).text()));
ok('古いパスワードでは新規入室できない（401）', (await login('/login', OLD, '198.51.100.22')).status === 401);
const m1 = await login('/login', NEW, '198.51.100.23');
const member1 = cookieOf(m1);
ok('新しいパスワードで直ちに入室できる', m1.status === 303 && member1.startsWith('pp_private='));
ok('入り直した後、音源が再生できる', await entered(member1));
const ranged = await call('GET', '/audio/manner', { cookie: member1, headers: { Range: 'bytes=0-99' } });
ok('シーク用の範囲取得も正常（206）', ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100);
ok('管理者のログインは続いている', (await pwApi('status', admin)).status === 200);
r = await pwApi('status', admin);
ok('状態：管理ツールで設定したパスワードを使用中', (await r.json()).mode === 'r2');

console.log('4. 照合情報は公開されない');
for (const p of ['/auth/private-password.json', '/audio/auth', '/admin/api/private-password.json', '/r2/auth/private-password.json'])
  ok(`${p} では読めない`, !(await (await call('GET', p, { cookie: member1 })).text()).includes(JSON.parse(stored).hash));
const catalogView = await (await call('GET', '/admin/api/catalog', { cookie: admin, headers: { 'X-PP-Admin': '1' } })).text();
ok('管理画面の曲一覧にも出ない', !catalogView.includes('private-password') && !catalogView.includes(JSON.parse(stored).hash));
ok('状態の応答にも照合値は含まれない', !(await (await pwApi('status', admin)).text()).includes(JSON.parse(stored).hash));

console.log('5. 2回目の変更・読み込み失敗時');
const NEW2 = 'second-pass-24680';
ok('2回目の変更も成功', (await pwApi('change', admin, { newPassword: NEW2, adminPassword: ADMIN })).status === 200);
ok('1回目のパスワードのCookieも無効になる', !await entered(member1));
ok('1回目のパスワードでは入れない', (await login('/login', NEW, '198.51.100.24')).status === 401);
const member2 = cookieOf(await login('/login', NEW2, '198.51.100.25'));
ok('2回目のパスワードで入れる', await entered(member2));
failRead = true;
ok('R2が読めないときは入室させない（古いパスワードに戻らない）', (await login('/login', OLD, '198.51.100.26')).status === 500);
ok('R2が読めないときは音源も出さない', (await call('GET', '/audio/manner', { cookie: member2 })).status === 500);
failRead = false;
const goodCred = readFileSync(credFile);
writeFileSync(credFile, '{"format":1,"broken":true}');
ok('照合情報が壊れていても古いパスワードに戻らない', (await login('/login', OLD, '198.51.100.27')).status === 500);
writeFileSync(credFile, goodCred);

console.log('6. 旧パスワード（Cloudflareのシークレット）に戻す');
ok('確認の言葉がないと戻らない', (await pwApi('restore', admin, { adminPassword: ADMIN })).status === 400 && existsSync(credFile));
ok('管理者パスワードが違うと戻らない', (await pwApi('restore', admin, { adminPassword: 'wrong', confirm: '旧パスワードに戻す' })).status === 403 && existsSync(credFile));
r = await pwApi('restore', admin, { adminPassword: ADMIN, confirm: '旧パスワードに戻す' });
ok('確認の言葉と管理者パスワードで戻せる', r.status === 200 && !existsSync(credFile));
ok('戻した後はCloudflareのパスワードで入れる', (await login('/login', OLD, '198.51.100.28')).status === 303);
ok('戻した後は管理ツールのパスワードでは入れない', (await login('/login', NEW2, '198.51.100.29')).status === 401);
ok('戻す前のCookieは無効', !await entered(member2));
ok('もう一度戻そうとすると「すでに使っています」', (await pwApi('restore', admin, { adminPassword: ADMIN, confirm: '旧パスワードに戻す' })).status === 409);

console.log('7. 試行回数の制限');
let last;
for (let i = 0; i < 12; i++) last = await pwApi('change', admin, { newPassword: 'x', adminPassword: ADMIN });
ok('短時間に何度も要求すると一時的にロック（429）', last.status === 429);
ok('ロック中は正しい内容でも変更できない', (await pwApi('change', admin, { newPassword: NEW, adminPassword: ADMIN })).status === 429 && !existsSync(credFile));
ok('ロックは招待者の入室には影響しない', (await login('/login', OLD, '198.51.100.31')).status === 303);
ok('音源の管理（曲一覧）は使える', (await call('GET', '/admin/api/catalog', { cookie: admin, headers: { 'X-PP-Admin': '1' }, ip: '198.51.100.40' })).status === 200);
ok('音源ファイルは変わっていない', readFileSync(path.join(r2, 'audio', 'manner.mp3')).equals(mp3));

console.log('8. 照合情報が壊れていても「戻す」で復旧できる（別の環境で）');
{
  const r2b = path.join(tmp, 'r2b');
  mkdirSync(path.join(r2b, 'auth'), { recursive: true });
  writeFileSync(path.join(r2b, 'catalog.json'), readFileSync(path.join(r2, 'catalog.json')));
  writeFileSync(path.join(r2b, 'auth', 'private-password.json'), '{"format":1,"broken":true}');
  const env2 = mockEnv({ r2Dir: r2b, publicDir: path.join(here, '..', 'worker', 'public'), vars: { PRIVATE_PASSWORD: OLD, SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: ADMIN } });
  const call2 = (method, p, opt = {}) => worker.fetch(new Request(O + p, { method, body: opt.body, headers: { Origin: O, 'CF-Connecting-IP': '198.51.100.50', ...(opt.cookie ? { Cookie: opt.cookie } : {}), ...(opt.headers ?? {}) } }), env2);
  const form = pw => ({ body: new URLSearchParams({ password: pw }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  ok('壊れている間は入室できない', (await call2('POST', '/login', form(OLD))).status === 500);
  const adm2 = cookieOf(await call2('POST', '/admin/login', form(ADMIN)));
  const res = await call2('POST', '/admin/api/private-password/restore', { cookie: adm2, headers: { 'X-PP-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ adminPassword: ADMIN, confirm: '旧パスワードに戻す' }) });
  ok('「戻す」で壊れたファイルを消せる', res.status === 200 && !existsSync(path.join(r2b, 'auth', 'private-password.json')));
  ok('戻した後はCloudflareのパスワードで入れる', (await call2('POST', '/login', form(OLD))).status === 303);
  // 10 attempts per hour are allowed, the 11th is refused: counted in one step, so a burst of concurrent calls cannot exceed it
  const burst = await Promise.all(Array.from({ length: 15 }, () => call2('POST', '/admin/api/private-password', { cookie: adm2, headers: { 'X-PP-Admin': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: 'x', adminPassword: ADMIN }) })));
  const passed = burst.filter(x => x.status !== 429).length;
  ok('同時に15件送っても、通るのは上限内（9件：既に1回使用済み）', passed === 9, `passed=${passed}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} 件 NG` : '\nすべて合格');
process.exitCode = failures ? 1 : 0;
