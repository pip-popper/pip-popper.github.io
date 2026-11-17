// PIP POPPER PRIVATE — Cloudflare Worker (invitation-only audio library)
//
// Never written in code or GitHub (Worker secrets only):
//   PRIVATE_PASSWORD  the shared password
//   SESSION_KEY       random string (32+ chars) used to sign the entry cookie
// Bindings (wrangler.toml): BUCKET = private R2 bucket, ASSETS = ./public, LOGIN_GUARD = login lockout (Durable Object).
// R2 layout: catalog.json (made by private/tools/private.mjs) and audio/<id>.mp3. The bucket has no public URL;
// every audio byte goes through this Worker, which checks the signed cookie on every request.
import { loginPage, libraryPage, messagePage } from './pages.js';

const COOKIE = 'pp_private';
const SESSION_DAYS = 30;
const MAX_PASSWORD = 200;
// Login lockout: 5 wrong passwords from one connection within 10 minutes -> no entry for 15 minutes,
// even with the right password. Counted strictly by a Durable Object (one per connection; IPv6 per /64).
const MAX_FAILS = 5;
const FAIL_WINDOW = 10 * 60e3;
const LOCK_TIME = 15 * 60e3;
const enc = new TextEncoder();

const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'", "img-src 'self' https://pip-popper.github.io", "media-src 'self'", "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
  ].join('; '),
};

// ── Signing helpers ────────────────────────────────────────────────────
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
function sameBytes(a, b) {          // constant time for equal lengths
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
// Changes whenever the password changes, so a new password signs everyone out.
const passwordVersion = async env => b64u(await hmac(env.SESSION_KEY, `version:${env.PRIVATE_PASSWORD}`)).slice(0, 16);
const passwordMatches = async (env, input) =>
  sameBytes(await hmac(env.SESSION_KEY, `check:${input}`), await hmac(env.SESSION_KEY, `check:${env.PRIVATE_PASSWORD}`));

async function newSession(env) {
  const payload = b64u(enc.encode(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5, v: await passwordVersion(env) })));
  return `${payload}.${b64u(await hmac(env.SESSION_KEY, `session:${payload}`))}`;
}
async function hasSession(request, env) {
  const value = (request.headers.get('Cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [payload, sig] = (value ?? '').split('.');
  if (!payload || !sig) return false;
  try {
    if (!sameBytes(fromB64u(sig), await hmac(env.SESSION_KEY, `session:${payload}`))) return false;
    const data = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    return data.exp > Date.now() && data.v === await passwordVersion(env);
  } catch { return false; }
}
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

// ── Responses ──────────────────────────────────────────────────────────
const html = (status, body, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const redirect = (location, headers = {}) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } });
function secure(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}
// Forms are only accepted from this site's own pages.
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === url.origin;
  const site = request.headers.get('Sec-Fetch-Site');
  return !site || site === 'same-origin';
}

// One Durable Object per connection keeps its own failure count, so the limit is exact (no per-location guessing).
export class LoginGuard {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch(request) {
    const action = new URL(request.url).pathname.slice(1);     // check | fail | success
    const now = Date.now();
    const saved = await this.storage.get('state');
    const state = saved ? { fails: saved.fails.filter(t => now - t < FAIL_WINDOW), until: saved.until } : { fails: [], until: 0 };
    const locked = () => state.until > now;
    if (!locked() && action === 'fail') {
      state.fails.push(now);
      if (state.fails.length >= MAX_FAILS) { state.until = now + LOCK_TIME; state.fails = []; }
    }
    if (!locked() && action === 'success') state.fails = [];
    const keep = locked() || state.fails.length > 0;
    if (keep && JSON.stringify(state) !== JSON.stringify(saved)) await this.storage.put('state', state);
    else if (!keep && saved) await this.storage.deleteAll();     // nothing left to remember
    return Response.json({ locked: locked(), retryAfter: locked() ? Math.ceil((state.until - now) / 1000) : 0 });
  }
}
// IPv4 as is; IPv6 by its /64 network (one home or phone line), so changing the last part does not reset the count.
export function clientKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).map(x => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
const lockMessage = seconds => `入力の回数が多すぎるため、一時的に入室できません。約${Math.max(1, Math.ceil(seconds / 60))}分後にもう一度お試しください。`;

async function readCatalog(env) {
  const object = await env.BUCKET.get('catalog.json');
  if (!object) return { songs: [] };
  const data = await object.json();
  return { songs: Array.isArray(data.songs) ? data.songs : [] };
}

// Single byte range "bytes=a-b", "bytes=a-" or "bytes=-n". null = whole file, 'bad' = 416.
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return header.includes(',') ? null : 'bad';
  let start, end;
  if (!m[1]) { const n = Number(m[2]); if (!n) return 'bad'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start >= size || end < start) return 'bad';
  return { offset: start, length: end - start + 1 };
}

async function serveAudio(request, env, id, url) {
  const song = (await readCatalog(env)).songs.find(s => s.id === id);
  if (!song) return text(404, '見つかりません。');
  const range = parseRange(request.headers.get('Range'), song.size);
  if (range === 'bad') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${song.size}` } });
  const object = await env.BUCKET.get(song.file, range ? { range } : undefined);
  if (!object) return text(404, '見つかりません。');
  const headers = {
    'Content-Type': song.type || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(range ? range.length : song.size),
  };
  if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${song.size}`;
  if (url.searchParams.get('download') === '1') {
    const name = `PIP POPPER - ${song.title}.mp3`.replace(/[\\/:*?"<>|]/g, '_');
    headers['Content-Disposition'] = `attachment; filename="pip-popper-${song.id}.mp3"; filename*=UTF-8''${encodeURIComponent(name)}`;
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /\n');
  if (pathname.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) return env.ASSETS.fetch(request);
  // Fail closed: without both secrets nobody can enter.
  if (!env.PRIVATE_PASSWORD || !env.SESSION_KEY || env.SESSION_KEY.length < 32 || !env.LOGIN_GUARD) return html(503, messagePage('準備中です。しばらくしてからお越しください。'));

  if (pathname === '/login' && method === 'POST') {
    if (!sameOrigin(request, url)) return text(403, '受け付けられないリクエストです。');
    const guard = env.LOGIN_GUARD.get(env.LOGIN_GUARD.idFromName(clientKey(request.headers.get('CF-Connecting-IP') ?? 'local')));
    const ask = async action => (await guard.fetch(`https://guard/${action}`, { method: 'POST' })).json();
    const before = await ask('check');                        // locked = refused before the password is even looked at
    if (before.locked) return html(429, loginPage({ error: lockMessage(before.retryAfter) }), { 'Retry-After': String(before.retryAfter) });
    const form = await request.formData().catch(() => null);
    const input = String(form?.get('password') ?? '');
    if (!input || input.length > MAX_PASSWORD || !await passwordMatches(env, input)) {
      const after = await ask('fail');
      await new Promise(r => setTimeout(r, 1000));          // slows guessing (wait time is not CPU time)
      if (after.locked) return html(429, loginPage({ error: lockMessage(after.retryAfter) }), { 'Retry-After': String(after.retryAfter) });
      return html(401, loginPage({ error: 'パスワードが違います。' }));
    }
    await ask('success');
    return redirect('/', { 'Set-Cookie': cookie(await newSession(env), SESSION_DAYS * 86400) });
  }
  if (pathname === '/logout' && method === 'POST') {
    if (!sameOrigin(request, url)) return text(403, '受け付けられないリクエストです。');
    return redirect('/', { 'Set-Cookie': cookie('', 0) });
  }

  const audio = /^\/audio\/([a-z0-9-]+)$/.exec(pathname);
  if (audio) {
    if (method !== 'GET') return text(405, '受け付けられないリクエストです。');
    if (!await hasSession(request, env)) return text(401, '入室が必要です。');
    return serveAudio(request, env, audio[1], url);
  }
  if (pathname === '/' && method === 'GET') {
    if (!await hasSession(request, env)) return html(200, loginPage({}));
    return html(200, libraryPage(await readCatalog(env)));
  }
  return html(404, messagePage('ページが見つかりません。'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Always encrypted: plain http is sent to https (except the local test server).
    if (url.protocol === 'http:' && url.hostname !== 'localhost') { url.protocol = 'https:'; return Response.redirect(url.href, 301); }
    try { return secure(await route(request, env, url)); }
    catch (error) { console.error(error); return secure(html(500, messagePage('エラーが発生しました。時間をおいてもう一度お試しください。'))); }
  },
};
