// Local test server for the PIP POPPER PRIVATE Worker — no Cloudflare, no extra packages.
// R2 is imitated by the folder private/.r2/ (made by `private.mjs build`), static files by private/worker/public/.
//
//   node private/dev/serve.mjs --vars <file> [--port 8788] [--r2 <folder>]
//
// <file> holds the two secrets as KEY=VALUE lines (PRIVATE_PASSWORD=..., SESSION_KEY=...). Keep it outside GitHub.
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import worker, { LoginGuard } from '../worker/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(option('--port') ?? 8788);
const r2Dir = path.resolve(option('--r2') ?? path.join(here, '..', '.r2'));
const publicDir = path.join(here, '..', 'worker', 'public');
const varsFile = option('--vars');
if (!varsFile || !existsSync(varsFile)) { console.error('--vars で秘密の設定ファイルを指定してください。'); process.exit(1); }
const vars = Object.fromEntries(readFileSync(varsFile, 'utf8').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };
// Durable Object imitation: one LoginGuard per name, storage kept in memory.
const guards = new Map();
const guardFor = name => {
  if (!guards.has(name)) {
    const data = new Map();
    guards.set(name, new LoginGuard({ storage: { get: async k => structuredClone(data.get(k)), put: async (k, v) => { data.set(k, structuredClone(v)); }, deleteAll: async () => data.clear() } }));
  }
  return guards.get(name);
};
const env = {
  ...vars,
  LOGIN_GUARD: { idFromName: name => name, get: id => ({ fetch: (url, init) => guardFor(id).fetch(new Request(url, init)) }) },
  BUCKET: {
    async get(key, options) {
      const file = path.join(r2Dir, key);
      if (!file.startsWith(r2Dir) || !existsSync(file)) return null;
      const size = statSync(file).size;
      const start = options?.range?.offset ?? 0;
      const end = options?.range ? start + options.range.length - 1 : size - 1;
      return { size, get body() { return Readable.toWeb(createReadStream(file, { start, end })); },
        json: async () => JSON.parse(readFileSync(file, 'utf8')) };
    },
  },
  ASSETS: {
    async fetch(request) {
      const rel = decodeURIComponent(new URL(request.url).pathname);
      const file = path.join(publicDir, rel);
      if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) return new Response('Not found', { status: 404 });
      return new Response(readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' } });
    },
  },
};

http.createServer(async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body, duplex: 'half' });
  const response = await worker.fetch(request, env);
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = k === 'set-cookie' ? response.headers.getSetCookie() : v; });
  res.writeHead(response.status, headers);
  if (response.body && req.method !== 'HEAD') Readable.fromWeb(response.body).pipe(res); else res.end();
}).listen(port, () => console.log(`PIP POPPER PRIVATE（ローカル検証）: http://localhost:${port}/`));
