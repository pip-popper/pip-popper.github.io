// PIP POPPER PRIVATE — Cloudflare Worker (invitation-only audio library + administrator screen)
//
// Never written in code or GitHub (Worker secrets only):
//   PRIVATE_PASSWORD  the shared password for invitees (used until the first change from the manager tool;
//                     after that the check value in R2 auth/private-password.json is used — see credential.js)
//   SESSION_KEY       random string (32+ chars) used to sign the entry cookies
//   ADMIN_PASSWORD    administrator password (12+ chars, different from PRIVATE_PASSWORD); without it /admin stays closed
// Bindings (wrangler.toml): BUCKET = private R2 bucket, ASSETS = ./public, LOGIN_GUARD = login lockout (Durable Object).
// R2 layout: catalog.json (see catalog.js) and audio/*.mp3. The bucket has no public URL;
// every audio byte goes through this Worker, which checks a signed cookie on every request.
import { MAX_PASSWORD, html, text, redirect, secure, sameOrigin, signValue, readSigned,
  guard, connection, lockMessage, wait } from './common.js';
import { loadCredential, memberPasswordMatches, memberVersion } from './credential.js';
import { loadCatalog } from './catalog.js';
import { serveAudio } from './audio.js';
import { adminRoute } from './admin.js';
import { loginPage, libraryPage, messagePage } from './pages.js';

export { LoginGuard, clientKey } from './common.js';
export { parseRange } from './audio.js';

const COOKIE = 'pp_private';
const SESSION_DAYS = 30;
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
// The cookie's version follows the current password (R2 check value if set, else PRIVATE_PASSWORD): read every time.
async function hasSession(request, env) {
  const data = await readSigned(request, env, COOKIE, 'session');
  return !!data && data.exp > Date.now() && data.v === await memberVersion(env, await loadCredential(env));
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /\n');
  if ((pathname.startsWith('/assets/') || pathname === '/favicon.ico') && (method === 'GET' || method === 'HEAD')) return env.ASSETS.fetch(request);
  // Fail closed: without both secrets nobody can enter.
  if (!env.PRIVATE_PASSWORD || !env.SESSION_KEY || env.SESSION_KEY.length < 32 || !env.LOGIN_GUARD) return html(503, messagePage('準備中です。しばらくしてからお越しください。'));
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return adminRoute(request, env, url);

  if (pathname === '/login' && method === 'POST') {
    if (!sameOrigin(request, url)) return text(403, '受け付けられないリクエストです。');
    const ask = guard(env, connection(request), 'member');
    const before = await ask('check');                        // locked = refused before the password is even looked at
    if (before.locked) return html(429, loginPage({ error: lockMessage(before.retryAfter) }), { 'Retry-After': String(before.retryAfter) });
    const form = await request.formData().catch(() => null);
    const input = String(form?.get('password') ?? '');
    const cred = await loadCredential(env);
    if (!input || input.length > MAX_PASSWORD || !await memberPasswordMatches(env, input, cred)) {
      const after = await ask('fail');
      await wait(1000);                                       // slows guessing (wait time is not CPU time)
      if (after.locked) return html(429, loginPage({ error: lockMessage(after.retryAfter) }), { 'Retry-After': String(after.retryAfter) });
      return html(401, loginPage({ error: 'パスワードが違います。' }));
    }
    await ask('success');
    const value = await signValue(env, 'session', { exp: Date.now() + SESSION_DAYS * 864e5, v: await memberVersion(env, cred) });
    return redirect('/', { 'Set-Cookie': cookie(value, SESSION_DAYS * 86400) });
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
    return html(200, libraryPage((await loadCatalog(env)).cat));
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
