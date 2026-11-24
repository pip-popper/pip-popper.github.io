// Uses local EXEs and an isolated project copy. No production PRIVATE calls or push.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifecycleOnly = process.argv.includes('--lifecycle-only');
const temp = await mkdtemp(path.join(tmpdir(), 'pip-exe-'));
const moved = path.join(temp, '移動先 空白', 'PIP POPPER公式サイト');
await cp(root, moved, { recursive: true, filter: source =>
  !['.manager', 'preview'].includes(path.relative(root, source).split(path.sep)[0])
});
const env = { ...process.env, PP_MANAGER_NO_OPEN: '1', PP_MANAGER_PRINT_TOKEN: '1',
  PATH: path.join(moved, 'manager', 'runtime', 'git', 'cmd') + ';' + process.env.SystemRoot + '\\System32' };
const heldPort = createServer();
await new Promise((resolve, reject) => { heldPort.once('error', reject); heldPort.listen(18990, '127.0.0.1', resolve); });

async function start(folder) {
  const proc = spawn(path.join(folder, 'PIP POPPER管理ツール.exe'), [], { env, windowsHide: true, cwd: temp });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('EXE startup timed out')), 30000);
    proc.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error('EXE exited before ready: ' + code)); });
    proc.once('error', reject);
  });
  const pid = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server PID timeout')), 5000);
    const check = () => { const match = output.match(/SERVER_PID=(\d+)/); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } };
    proc.stdout.on('data', check);
    check();
  });
  return { proc, url, pid };
}
let running;
try {
  for (const folder of [root, moved]) {
    running = await start(folder);
    const { proc, url } = running;
    const parsed = new URL(url), token = parsed.hash.slice(3);
    if (lifecycleOnly) {
      const duplicate = spawn(path.join(folder, 'PIP POPPER管理ツール.exe'), [], { env, windowsHide: true });
      assert.equal(await new Promise(resolve => duplicate.once('exit', resolve)), 0);
      const serverPid = running.pid;
      proc.kill();
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.throws(() => process.kill(serverPid, 0));
      console.log('PASS: startup, duplicate reuse, launcher-loss cleanup: ' + (folder === root ? 'formal folder' : 'relocated folder'));
      running = null;
      continue;
    }
    const api = (route, body) => fetch(new URL(route, url), {
      method: body ? 'POST' : 'GET',
      headers: { 'X-PP-Token': token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.notEqual(parsed.port, '18990');
    const ui = await fetch(parsed.origin);
    assert.equal(ui.status, 200);
    const state = await (await api('/api/state')).json();
    assert.ok(state.list);
    assert.equal((await fetch(parsed.origin + '/api/state')).status, 403);
    const app = await (await fetch(parsed.origin + '/app.js')).text();
    assert.ok(app.includes('checkbox') && app.includes('password'));
    const duplicate = spawn(path.join(folder, 'PIP POPPER管理ツール.exe'), [], { env, windowsHide: true });
    assert.equal(await new Promise(resolve => duplicate.once('exit', resolve)), 0);
    assert.equal((await api('/api/state')).status, 200);
    assert.equal((await api('/api/quit', {})).status, 200);
    assert.equal(await new Promise(resolve => proc.once('exit', resolve)), 0);
    await assert.rejects(fetch(parsed.origin));
    console.log('PASS: EXE startup, local API/auth, password UI, duplicate reuse, shutdown, port conflict: ' + (folder === root ? 'formal folder' : 'relocated folder without Node/Git on PATH'));
    running = null;
  }
} finally {
  heldPort.close();
  if (running) running.proc.kill();
  await new Promise(resolve => setTimeout(resolve, 500));
  await rm(temp, { recursive: true, force: true });
}
