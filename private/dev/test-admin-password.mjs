// node private/dev/test-admin-password.mjs — changing the administrator password (2026-11-25), on the mock Worker.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { mockEnv } from './mock-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pp-adminpw-')), r2 = path.join(tmp, 'r2');
mkdirSync(path.join(r2, 'audio'), { recursive: true });
writeFileSync(path.join(r2, 'catalog.json'), JSON.stringify({ version: 2, rev: 1, songs: [], retired: [] }));
let fail = 0, ip = 10;
const ok = (c, name) => { console.log(`${c ? 'OK ' : 'NG '} ${name}`); if (!c) fail++; };
const O = 'https://pip-popper-private.pip-popper-private.workers.dev';
const MEMBER = 'member-pass-0001', OLD = 'admin-cloudflare-01', NEW = 'admin-changed-pass-02', NEWER = 'admin-third-pass-0003';
let env = mockEnv({ r2Dir: r2, publicDir: path.join(here, '..', 'worker', 'public'), vars: { PRIVATE_PASSWORD: MEMBER, SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: OLD } });
const req = (method, p, { cookie, headers = {}, body } = {}) => worker.fetch(new Request(O + p, { method, body, headers: { Origin: O, 'CF-Connecting-IP': `198.51.100.${ip}`, ...(cookie ? { Cookie: cookie } : {}), ...headers } }), env);
const form = pw => ({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pw }) });
const adminLogin = async pw => { const r = await req('POST', '/admin/login', form(pw)); return { status: r.status, cookie: (r.headers.get('Set-Cookie') ?? '').split(';')[0] }; };
const api = async (cookie, method, p, body) => { const r = await req(method, '/admin/api/' + p, { cookie, headers: { 'X-PP-Admin': '1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
try {
  console.log('1. 変更前');
  let a = await adminLogin(OLD);
  ok(a.status === 303, 'Cloudflareの管理者パスワードで入れる');
  ok((await api(a.cookie, 'GET', 'admin-password')).data.mode === 'secret', '状態：Cloudflareのパスワードを使用中');

  console.log('2. 入力の確認');
  ok((await api(a.cookie, 'POST', 'admin-password', { adminPassword: 'wrong-admin-password', newPassword: NEW })).status === 403, '今の管理者パスワードが違うと変更しない');
  ip++;
  ok((await api(a.cookie, 'POST', 'admin-password', { adminPassword: OLD, newPassword: 'short-pass' })).status === 400, '12文字未満は拒否');
  ok((await api(a.cookie, 'POST', 'admin-password', { adminPassword: OLD, newPassword: ' ' + NEW })).status === 400, '前後の空白は拒否');
  ok((await api(a.cookie, 'POST', 'admin-password', { adminPassword: OLD, newPassword: OLD })).status === 400, '今と同じパスワードは拒否');
  ok((await api(a.cookie, 'POST', 'admin-password', { adminPassword: OLD, newPassword: MEMBER })).status === 400, '招待者のパスワードと同じものは拒否');
  ok((await api(null, 'POST', 'admin-password', { adminPassword: OLD, newPassword: NEW })).status === 401, '管理画面に入っていなければ拒否');

  console.log('3. 変更');
  let r = await api(a.cookie, 'POST', 'admin-password', { adminPassword: OLD, newPassword: NEW });
  ok(r.status === 200 && r.data.mode === 'r2', '変更できる');
  const file = readFileSync(path.join(r2, 'auth', 'admin-password.json'), 'utf8');
  ok(!file.includes(NEW) && !file.includes(OLD) && /"hash"/.test(file), 'R2には照合値だけ（パスワードの平文はない）');
  ok((await api(a.cookie, 'GET', 'admin-password')).status === 401, '変更前の管理Cookieはすぐ使えなくなる');
  ip++;
  ok((await adminLogin(OLD)).status === 401, '古い（Cloudflareの）パスワードでは入れない');
  ip++;
  a = await adminLogin(NEW);
  ok(a.status === 303 && (await api(a.cookie, 'GET', 'listen')).status === 200 && (await api(a.cookie, 'GET', 'lyrics')).status === 200, '新しいパスワードで入れて、管理操作（一般視聴・歌詞）ができる');
  ok((await req('POST', '/login', form(MEMBER))).status === 303, '招待者のパスワードは変わらない');
  ok((await api(a.cookie, 'POST', 'private-password', { adminPassword: OLD, newPassword: 'member-new-0002' })).status === 403 && (await api(a.cookie, 'POST', 'private-password', { adminPassword: NEW, newPassword: NEW })).status === 400, '招待者パスワードの変更も新しい管理者パスワードで確認（管理者と同じものは不可）');

  console.log('4. 戻す・もう一度変える');
  ok((await api(a.cookie, 'POST', 'admin-password/restore', { adminPassword: NEW, confirm: 'ちがう' })).status === 400, '確認の言葉が違うと戻さない');
  r = await api(a.cookie, 'POST', 'admin-password/restore', { adminPassword: NEW, confirm: 'Cloudflareの管理者パスワードに戻す' });
  ip++;
  ok(r.status === 200 && !existsSync(path.join(r2, 'auth', 'admin-password.json')) && (await adminLogin(OLD)).status === 303 && (await adminLogin(NEW)).status === 401, 'Cloudflareの管理者パスワードに戻せる');
  // the change limit (10 attempts an hour, shared with the invitee password) has been used up above: start a new hour
  env = mockEnv({ r2Dir: r2, publicDir: path.join(here, '..', 'worker', 'public'), vars: { PRIVATE_PASSWORD: MEMBER, SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: OLD } });
  a = await adminLogin(OLD);
  await api(a.cookie, 'POST', 'admin-password', { adminPassword: OLD, newPassword: NEW });
  a = await adminLogin(NEW);
  r = await api(a.cookie, 'POST', 'admin-password', { adminPassword: NEW, newPassword: NEWER });
  ip++;
  ok(r.status === 200 && (await adminLogin(NEWER)).status === 303 && (await adminLogin(NEW)).status === 401, `変更後にもう一度変えられる（ひとつ前は使えない） ${r.status} ${r.data?.error ?? ''}`);

  console.log('5. 壊れたとき・忘れたとき');
  writeFileSync(path.join(r2, 'auth', 'admin-password.json'), '{"format":1,"broken":true}');
  ip++;
  ok((await adminLogin(NEWER)).status === 500 && (await adminLogin(OLD)).status === 500, '照合ファイルが壊れていたら、管理者は誰も入れない（安全側）');
  ok((await req('POST', '/login', form(MEMBER))).status === 303, 'そのときも招待者は入れる');
  rmSync(path.join(r2, 'auth', 'admin-password.json'));            // = deleting the file in the Cloudflare dashboard
  ok((await adminLogin(OLD)).status === 303, '最終手段：照合ファイルを消すと、Cloudflareの管理者パスワードで入れる');
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(fail ? `不合格 ${fail}` : 'すべて合格');
process.exitCode = fail ? 1 : 0;
