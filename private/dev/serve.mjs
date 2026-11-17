// Local test server for the PIP POPPER PRIVATE Worker — no Cloudflare, no extra packages.
//   node private/dev/serve.mjs --vars <file> [--port 8788] [--r2 <folder>] [--works <works.json>]
// <file> holds the secrets as KEY=VALUE lines (PRIVATE_PASSWORD, SESSION_KEY, ADMIN_PASSWORD). Keep it outside GitHub.
// --works: a works.json (made by build.mjs) served at /__works.json for the admin "add a song" list.
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker from '../worker/src/index.js';
import { mockEnv } from './mock-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(option('--port') ?? 8788);
const varsFile = option('--vars');
if (!varsFile || !existsSync(varsFile)) { console.error('--vars で秘密の設定ファイルを指定してください。'); process.exit(1); }
const vars = Object.fromEntries(readFileSync(varsFile, 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const worksFile = option('--works');
const env = mockEnv({
  r2Dir: path.resolve(option('--r2') ?? path.join(here, '..', '.r2')),
  publicDir: path.join(here, '..', 'worker', 'public'),
  vars,
  worksUrl: worksFile ? `http://localhost:${port}/__works.json` : undefined,
});

http.createServer(async (req, res) => {
  if (req.url === '/__works.json' && worksFile) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(readFileSync(worksFile)); return; }
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body, duplex: 'half' });
  const response = await worker.fetch(request, env);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? response.headers.getSetCookie() : v; });
  res.writeHead(response.status, headers);
  if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body).pipe(res); else res.end();
}).listen(port, () => console.log(`PIP POPPER PRIVATE（ローカル検証）: http://localhost:${port}/  管理: http://localhost:${port}/admin`));
