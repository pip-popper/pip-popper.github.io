// node manager/test-update-restart.mjs — after taking in an update at startup, the manager runs the updated code
// at once (2026-11-25). Uses temporary copies and a local bare repository only (no GitHub, no PRIVATE).
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'ppm-update-'));
const BARE = path.join(TMP, 'remote.git'), WORK = path.join(TMP, 'work'), OTHER = path.join(TMP, 'other');
let fail = 0;
const ok = (c, name) => { console.log(`${c ? 'OK ' : 'NG '} ${name}`); if (!c) fail++; };
const g = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=Producer', '-c', 'user.email=test@example.invalid', ...a], { cwd, encoding: 'utf8' }); return (r.stdout ?? '').trim(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = async port => { try { await fetch(`http://127.0.0.1:${port}/`); return true; } catch { return false; } };

// start the manager the way the EXE does (--launcher: stdin pipe, address read from the output)
function launch() {
  const p = spawn(process.execPath, [path.join(WORK, 'manager', 'server.mjs'), '--port', '0', '--no-open', '--launcher'],
    { cwd: WORK, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PP_MANAGER_NO_SYNC: '', PP_MANAGER_EXPECTED_REMOTE: BARE, PP_MANAGER_NO_OPEN: '1' } });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('startup timed out: ' + out)), 30000);
    p.stdout.on('data', d => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/#t=([0-9a-f]+)/); if (m) { clearTimeout(t); resolve({ port: Number(m[1]), token: m[2] }); } });
    p.once('exit', code => { clearTimeout(t); reject(new Error('exited ' + code + ' ' + out)); });
  });
  return { p, ready, output: () => out };
}
const log = () => { try { return readFileSync(path.join(WORK, '.manager', 'manager.log'), 'utf8'); } catch { return ''; } };

try {
  // A = this working copy's manager (with the restart), B = A + a visible marker in the manager's own code
  g(TMP, 'clone', '-q', REPO, WORK);
  writeFileSync(path.join(WORK, 'manager', 'server.mjs'), readFileSync(path.join(REPO, 'manager', 'server.mjs')));
  g(WORK, 'add', 'manager/server.mjs'); g(WORK, 'commit', '-q', '--allow-empty', '-m', 'A');
  g(TMP, 'clone', '-q', '--bare', WORK, BARE);
  g(WORK, 'remote', 'set-url', 'origin', BARE); g(WORK, 'fetch', '-q', 'origin'); g(WORK, 'branch', '-q', '-u', 'origin/main');
  const A = g(WORK, 'rev-parse', 'HEAD');
  g(TMP, 'clone', '-q', BARE, OTHER);
  const f = path.join(OTHER, 'manager', 'server.mjs');
  writeFileSync(f, readFileSync(f, 'utf8').replace("console.log('PIP POPPER 管理ツールを起動しました。');", "console.log('PIP POPPER 管理ツールを起動しました。'); console.log('UPDATED-VERSION-B');"));
  g(OTHER, 'commit', '-qam', 'B'); g(OTHER, 'push', '-q', 'origin', 'main');
  const B = g(OTHER, 'rev-parse', 'HEAD');

  console.log('1. 起動時に更新を取り込んだとき');
  let m = launch(), info = await m.ready;
  await sleep(300);
  ok(g(WORK, 'rev-parse', 'HEAD') === B && /sync from GitHub ok/.test(log()) && /restart after update/.test(log()), '更新を取り込み（A→B）、新しい版で起動し直した');
  ok(m.output().includes('UPDATED-VERSION-B'), '最初の起動から新しい版のプログラムが動いている（以前は次の起動から）');
  const r = await fetch(`http://127.0.0.1:${info.port}/api/state`, { headers: { 'X-PP-Token': info.token, Origin: `http://127.0.0.1:${info.port}` } });
  ok(r.status === 200, 'EXE と同じ方法でアドレスを受け取り、画面のAPIが使える');
  m.p.stdin.end();                                      // = the EXE goes away
  await sleep(1500);
  ok(m.p.exitCode !== null && !await alive(info.port), 'EXE が終わると、新しい版も含めてすべて終了する（残らない）');

  console.log('2. 更新がないとき');
  m = launch(); info = await m.ready; await sleep(300);
  ok((log().match(/restart after update/g) ?? []).length === 1 && m.output().includes('UPDATED-VERSION-B'), '更新がなければ起動し直さない（そのまま起動）');
  const q = await fetch(`http://127.0.0.1:${info.port}/api/quit`, { method: 'POST', headers: { 'X-PP-Token': info.token, Origin: `http://127.0.0.1:${info.port}`, 'Content-Type': 'application/json' }, body: '{}' });
  await sleep(1500);
  ok(q.status === 200 && m.p.exitCode !== null && !await alive(info.port), '「終了」で終わる');
  ok(A !== B && existsSync(path.join(WORK, 'manager', 'server.mjs')), '作業用の写しだけを使用（本物のGitHubには触れない）');
} catch (e) { fail++; console.log('NG  例外：', e.message.slice(0, 300)); }
finally { await sleep(300); if (!process.env.KEEP) rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
console.log(fail ? `不合格 ${fail}` : 'すべて合格');
process.exitCode = fail ? 1 : 0;
