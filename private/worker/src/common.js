// PIP POPPER PRIVATE — shared helpers (signing, responses, login lockout).
export const enc = new TextEncoder();
export const SITE = 'https://pip-popper.github.io/';
export const MAX_PASSWORD = 200;

export const SECURITY_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'", "img-src 'self' https://pip-popper.github.io", "media-src 'self' blob:", "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "connect-src 'self'",
    "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
  ].join('; '),
};

// ── Signing ────────────────────────────────────────────────────────────
export const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
export async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
export function sameBytes(a, b) {          // constant time for equal lengths
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
// A signed cookie value: base64url(JSON payload) + "." + HMAC. `purpose` keeps member and admin cookies apart.
export async function signValue(env, purpose, data) {
  const payload = b64u(enc.encode(JSON.stringify(data)));
  return `${payload}.${b64u(await hmac(env.SESSION_KEY, `${purpose}:${payload}`))}`;
}
export async function readSigned(request, env, cookieName, purpose) {
  const value = (request.headers.get('Cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const [payload, sig] = (value ?? '').split('.');
  if (!payload || !sig) return null;
  try {
    if (!sameBytes(fromB64u(sig), await hmac(env.SESSION_KEY, `${purpose}:${payload}`))) return null;
    return JSON.parse(new TextDecoder().decode(fromB64u(payload)));
  } catch { return null; }
}
export const secretMatches = async (env, input, secret, label) =>
  sameBytes(await hmac(env.SESSION_KEY, `${label}:${input}`), await hmac(env.SESSION_KEY, `${label}:${secret}`));
// Changes whenever the password changes, so a new password signs everyone out.
export const secretVersion = async (env, secret, label) => b64u(await hmac(env.SESSION_KEY, `${label}:${secret}`)).slice(0, 16);

// ── Responses ──────────────────────────────────────────────────────────
export const html = (status, body, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
export const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
export const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
export const redirect = (location, headers = {}) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...headers } });
export function secure(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}
// Forms and API calls are only accepted from this site's own pages.
export function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === url.origin;
  const site = request.headers.get('Sec-Fetch-Site');
  return !site || site === 'same-origin';
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── Login lockout (Durable Object, one per connection or per counter) ──
// member:   invitees, per connection: 5 wrong passwords in 10 min -> 15 min lock
// admin:    administrator, per connection: 5 in 10 min -> 60 min lock
// adminAll: administrator, all connections together: 20 in 60 min -> 60 min lock (admin screen only)
export const PROFILES = {
  member: { max: 5, window: 10 * 60e3, lock: 15 * 60e3 },
  admin: { max: 5, window: 10 * 60e3, lock: 60 * 60e3 },
  adminAll: { max: 20, window: 60 * 60e3, lock: 60 * 60e3 },
  // invitee password changes / restores (manager tool): 10 attempts in 60 min -> 60 min lock, all connections together
  pwChange: { max: 10, window: 60 * 60e3, lock: 60 * 60e3 },
};
export class LoginGuard {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);                       // check | fail | success
    const rule = PROFILES[url.searchParams.get('p') ?? 'member'] ?? PROFILES.member;
    const now = Date.now();
    const saved = await this.storage.get('state');
    const state = saved ? { fails: saved.fails.filter(t => now - t < rule.window), until: saved.until } : { fails: [], until: 0 };
    const locked = () => state.until > now;
    if (!locked() && action === 'fail') {
      state.fails.push(now);
      if (state.fails.length >= rule.max) { state.until = now + rule.lock; state.fails = []; }
    }
    if (!locked() && action === 'success') state.fails = [];
    const keep = locked() || state.fails.length > 0;
    if (keep && JSON.stringify(state) !== JSON.stringify(saved)) await this.storage.put('state', state);
    else if (!keep && saved) await this.storage.deleteAll();     // nothing left to remember
    return Response.json({ locked: locked(), retryAfter: locked() ? Math.ceil((state.until - now) / 1000) : 0 });
  }
}
export function guard(env, name, profile) {
  const stub = env.LOGIN_GUARD.get(env.LOGIN_GUARD.idFromName(name));
  return async action => (await stub.fetch(`https://guard/${action}?p=${profile}`, { method: 'POST' })).json();
}
// IPv4 as is; IPv6 by its /64 network (one home or phone line), so changing the last part does not reset the count.
export function clientKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${full.slice(0, 4).map(x => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
export const connection = request => clientKey(request.headers.get('CF-Connecting-IP') ?? 'local');
export const lockMessage = seconds => `入力の回数が多すぎるため、一時的に入室できません。約${Math.max(1, Math.ceil(seconds / 60))}分後にもう一度お試しください。`;
export const wait = ms => new Promise(r => setTimeout(r, ms));
