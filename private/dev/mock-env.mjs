// Imitation of the Cloudflare environment for local tests (no Cloudflare, no extra packages).
//   R2 (BUCKET): files in <r2Dir>, details in <r2Dir>/.meta/. Supports get (range), head, put (sha256 check,
//                onlyIf.etagMatches -> null on mismatch), delete, list (prefix). Same behaviour the Worker relies on.
//   ASSETS: files in private/worker/public.  LOGIN_GUARD: in-memory Durable Objects.
import { createReadStream, existsSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { LoginGuard } from '../worker/src/index.js';

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };

export function mockBucket(r2Dir, hooks = {}) {
  const metaDir = path.join(r2Dir, '.meta');
  const fileOf = key => { const f = path.join(r2Dir, key); if (!f.startsWith(r2Dir + path.sep)) throw new Error('bad key'); return f; };
  const metaOf = key => path.join(metaDir, `${encodeURIComponent(key)}.json`);
  const info = key => {
    const f = fileOf(key);
    if (!existsSync(f)) return null;
    const st = statSync(f);
    const m = existsSync(metaOf(key)) ? JSON.parse(readFileSync(metaOf(key), 'utf8')) : { etag: `legacy-${st.size}-${st.mtimeMs}`, uploaded: st.mtime.toISOString() };
    return { key, size: st.size, etag: m.etag, httpEtag: `"${m.etag}"`, uploaded: new Date(m.uploaded), customMetadata: m.customMetadata ?? {}, checksums: { sha256: m.sha256 } };
  };
  const toBuffer = async body => {
    if (body == null) return Buffer.alloc(0);
    if (typeof body === 'string') return Buffer.from(body);
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return Buffer.from(body.buffer ? body.buffer : body);
    return Buffer.from(await new Response(body).arrayBuffer());
  };
  return {
    async head(key) { return info(key); },
    async get(key, options) {
      const i = info(key);
      if (!i) return null;
      const f = fileOf(key);
      const start = options?.range?.offset ?? 0;
      const end = options?.range ? Math.min(start + options.range.length - 1, i.size - 1) : i.size - 1;
      return { ...i, get body() { return Readable.toWeb(createReadStream(f, { start, end })); },
        json: async () => JSON.parse(readFileSync(f, 'utf8')), text: async () => readFileSync(f, 'utf8') };
    },
    async put(key, body, options = {}) {
      if (hooks.beforePut) await hooks.beforePut(key, options);
      const current = info(key);
      if (options.onlyIf?.etagMatches && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
      const data = await toBuffer(body);
      if (hooks.corrupt?.(key)) data[data.length - 1] ^= 0xff;            // simulate damage in transit
      const sha = createHash('sha256').update(data).digest('hex');
      if (options.sha256 && options.sha256 !== sha) throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
      const f = fileOf(key);
      mkdirSync(path.dirname(f), { recursive: true }); mkdirSync(metaDir, { recursive: true });
      writeFileSync(f, data);
      const meta = { etag: randomBytes(8).toString('hex'), uploaded: new Date(Date.now()).toISOString(), customMetadata: options.customMetadata, sha256: sha };
      writeFileSync(metaOf(key), JSON.stringify(meta));
      return info(key);
    },
    async delete(keys) {
      for (const key of [].concat(keys)) { const f = fileOf(key); rmSync(f, { force: true }); rmSync(metaOf(key), { force: true }); }
    },
    async list({ prefix = '' } = {}) {
      const out = [];
      const walk = dir => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.meta') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else { const key = path.relative(r2Dir, full).split(path.sep).join('/'); if (key.startsWith(prefix)) out.push(info(key)); }
      } };
      walk(r2Dir);
      return { objects: out, truncated: false };
    },
  };
}

export function mockEnv({ r2Dir, publicDir, vars, worksUrl, hooks }) {
  const guards = new Map();
  const guardFor = name => {
    if (!guards.has(name)) {
      const data = new Map();
      guards.set(name, new LoginGuard({ storage: { get: async k => structuredClone(data.get(k)), put: async (k, v) => { data.set(k, structuredClone(v)); }, deleteAll: async () => data.clear() } }));
    }
    return guards.get(name);
  };
  return {
    ...vars,
    WORKS_URL: worksUrl,
    LOGIN_GUARD: { idFromName: name => name, get: id => ({ fetch: (url, init) => guardFor(id).fetch(new Request(url, init)) }) },
    BUCKET: mockBucket(r2Dir, hooks),
    ASSETS: {
      async fetch(request) {
        const rel = decodeURIComponent(new URL(request.url).pathname);
        const file = path.join(publicDir, rel);
        if (!file.startsWith(publicDir) || !existsSync(file) || !statSync(file).isFile()) return new Response('Not found', { status: 404 });
        return new Response(readFileSync(file), { headers: { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' } });
      },
    },
  };
}
