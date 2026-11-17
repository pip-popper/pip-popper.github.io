// PIP POPPER PRIVATE — administrator screen (/admin) and its API (/admin/api/...).
// Secret (Cloudflare only, never in code/GitHub): ADMIN_PASSWORD — 12+ characters and different from PRIVATE_PASSWORD.
import { SITE, MAX_PASSWORD, HttpError, html, json, text, redirect, sameOrigin, signValue, readSigned, secretMatches,
  secretVersion, guard, connection, lockMessage, wait } from './common.js';
import { loadCatalog, commit, storeUpload, cleanup, RETIRE_GRACE, RESTORE_LIMIT, MAX_UPLOAD } from './catalog.js';
import { adminLoginPage, adminPage, messagePage } from './pages.js';
import { serveAudio } from './audio.js';

const ADMIN_COOKIE = 'pp_admin';
const ADMIN_HOURS = 12;
const adminCookie = (value, maxAge) => `${ADMIN_COOKIE}=${value}; Path=/admin; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
const adminReady = env => env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 12 && env.ADMIN_PASSWORD !== env.PRIVATE_PASSWORD;
const version = env => secretVersion(env, env.ADMIN_PASSWORD, 'admin-version');

async function isAdmin(request, env) {
  const data = await readSigned(request, env, ADMIN_COOKIE, 'admin-session');
  return !!data && data.role === 'admin' && data.exp > Date.now() && data.v === await version(env);
}

// What the screen needs: the list, its rev, and removed songs that can still be restored.
function view(cat) {
  const now = Date.now();
  return {
    rev: cat.rev,
    songs: cat.songs.map(s => ({ id: s.id, title: s.title, cover: s.cover, size: s.size, duration: s.duration ?? null,
      audioUpdatedAt: s.audioUpdatedAt, v: (s.sha256 ?? s.audioUpdatedAt ?? '').slice(0, 16) })),
    removed: cat.retired.filter(r => r.reason === 'removed' && now - Date.parse(r.at) < RESTORE_LIMIT)
      .map(r => ({ file: r.file, id: r.entry.id, title: r.entry.title, cover: r.entry.cover, at: r.at, until: new Date(Date.parse(r.at) + RETIRE_GRACE).toISOString() })),
    pendingDelete: cat.retired.length,
    totalSize: cat.songs.reduce((n, s) => n + (s.size || 0), 0),
    maxUpload: MAX_UPLOAD,
  };
}
const rev = url => { const r = Number(url.searchParams.get('rev')); if (!Number.isInteger(r) || r < 0) throw new HttpError(400, '画面を再読み込みしてからお試しください。'); return r; };
const duration = request => { const d = Number(request.headers.get('X-Duration')); return Number.isFinite(d) && d > 0 && d < 36000 ? Math.round(d * 10) / 10 : null; };
async function bodyJson(request) { try { return await request.json(); } catch { throw new HttpError(400, '送信内容を読み取れませんでした。'); } }

async function works(env) {
  const res = await fetch(env.WORKS_URL || `${SITE}works.json`, { cf: { cacheTtl: 300 } }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, '公式サイトの作品一覧を読み込めませんでした。時間をおいてお試しください。');
  const list = await res.json();
  return (Array.isArray(list) ? list : []).filter(w => /^[a-z0-9-]+$/.test(w.id) && w.title);
}
// After every change: delete only what is certainly unused (see cleanup), then return the newest view.
async function done(env, extra = {}) {
  try { await cleanup(env); } catch (error) { console.error('cleanup', error); }
  return json(200, { ok: true, ...extra, ...view((await loadCatalog(env)).cat) });
}

async function api(request, env, url, path) {
  const method = request.method;
  if (path === 'catalog' && method === 'GET') return json(200, view((await loadCatalog(env)).cat));
  if (path === 'works' && method === 'GET') return json(200, { works: await works(env) });

  let m;
  if ((m = /^songs\/([a-z0-9-]+)\/audio$/.exec(path)) && method === 'GET') return serveAudio(request, env, m[1], url);

  // Replace the audio of an existing song: title, jacket and order stay; only the audio changes.
  if ((m = /^songs\/([a-z0-9-]+)\/audio$/.exec(path)) && method === 'PUT') {
    const id = m[1], expected = rev(url);
    const { cat } = await loadCatalog(env);
    if (cat.rev !== expected) throw new HttpError(409, '別の画面（または別の端末）で先に変更されたため、今回の操作は行いませんでした。最新の状態を表示します。');
    if (!cat.songs.some(s => s.id === id)) throw new HttpError(404, 'この曲は登録されていません。');
    const up = await storeUpload(request, env, id);
    try {
      await commit(env, expected, c => {
        const song = c.songs.find(s => s.id === id);
        if (!song) throw new HttpError(404, 'この曲は登録されていません。');
        c.retired.push({ file: song.file, at: new Date().toISOString(), reason: 'replaced', song: id });
        Object.assign(song, { file: up.key, size: up.size, sha256: up.sha256, type: 'audio/mpeg', duration: duration(request), audioUpdatedAt: new Date().toISOString() });
      });
    } catch (error) { await env.BUCKET.delete(up.key).catch(() => {}); throw error; }   // list unchanged -> current audio keeps playing
    return done(env, { message: '音源を差し替えました。' });
  }

  // Add a song: one of the official site's works, or a work that is not on the site (title only, no jacket).
  if (path === 'songs' && method === 'POST') {
    const expected = rev(url);
    const workId = url.searchParams.get('work') ?? '';
    let id, title, cover;
    if (workId) {
      const work = (await works(env)).find(w => w.id === workId);
      if (!work) throw new HttpError(404, '公式サイトの作品一覧にない曲です。');
      ({ id, title } = work); cover = work.cover ?? '';
    } else {
      title = (url.searchParams.get('title') ?? '').trim().slice(0, 100);
      if (!title) throw new HttpError(400, '曲名を入力してください。');
      id = `song-${[...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
      cover = '';
    }
    const { cat } = await loadCatalog(env);
    if (cat.rev !== expected) throw new HttpError(409, '別の画面（または別の端末）で先に変更されたため、今回の操作は行いませんでした。最新の状態を表示します。');
    if (cat.songs.some(s => s.id === id)) throw new HttpError(409, 'この曲はすでに登録されています。');
    const up = await storeUpload(request, env, id);
    try {
      await commit(env, expected, c => {
        if (c.songs.some(s => s.id === id)) throw new HttpError(409, 'この曲はすでに登録されています。');
        const now = new Date().toISOString();
        c.songs.push({ id, title, cover, file: up.key, size: up.size, sha256: up.sha256, type: 'audio/mpeg', duration: duration(request), audioUpdatedAt: now, addedAt: now });
      });
    } catch (error) { await env.BUCKET.delete(up.key).catch(() => {}); throw error; }
    return done(env, { message: `「${title}」を追加しました。` });
  }

  if (path === 'order' && method === 'POST') {
    const body = await bodyJson(request);
    await commit(env, Number(body.rev), c => {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (ids.length !== c.songs.length || new Set(ids).size !== ids.length || !ids.every(i => c.songs.some(s => s.id === i)))
        throw new HttpError(409, '曲の一覧が変わっています。最新の状態を表示します。');
      c.songs = ids.map(i => c.songs.find(s => s.id === i));
    });
    return done(env, { message: '並び順を保存しました。' });
  }

  // Remove from PRIVATE: the song disappears at once; its audio stays 24 h so it can be restored, then is deleted.
  if ((m = /^songs\/([a-z0-9-]+)\/remove$/.exec(path)) && method === 'POST') {
    const body = await bodyJson(request);
    let title;
    await commit(env, Number(body.rev), c => {
      const index = c.songs.findIndex(s => s.id === m[1]);
      if (index < 0) throw new HttpError(404, 'この曲はすでに一覧にありません。');
      const [song] = c.songs.splice(index, 1);
      title = song.title;
      c.retired.push({ file: song.file, at: new Date().toISOString(), reason: 'removed', song: song.id, entry: song, index });
    });
    return done(env, { message: `「${title}」をPRIVATEから外しました（24時間以内なら戻せます）。` });
  }
  if (path === 'restore' && method === 'POST') {
    const body = await bodyJson(request);
    let title;
    await commit(env, Number(body.rev), c => {
      const i = c.retired.findIndex(r => r.reason === 'removed' && r.file === body.file);
      if (i < 0 || Date.now() - Date.parse(c.retired[i].at) >= RESTORE_LIMIT) throw new HttpError(410, '戻せる期限を過ぎています。');
      const r = c.retired[i];
      if (c.songs.some(s => s.id === r.entry.id)) throw new HttpError(409, '同じ曲がすでに登録されています。');
      c.retired.splice(i, 1);
      c.songs.splice(Math.min(r.index ?? c.songs.length, c.songs.length), 0, r.entry);
      title = r.entry.title;
    });
    return done(env, { message: `「${title}」を戻しました。` });
  }
  throw new HttpError(404, '見つかりません。');
}

export async function adminRoute(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  if (!adminReady(env)) return html(503, messagePage('管理画面は準備中です（管理者パスワードが未設定です）。'));

  if (pathname === '/admin/login' && method === 'POST') {
    if (!sameOrigin(request, url)) return text(403, '受け付けられないリクエストです。');
    const mine = guard(env, `admin:${connection(request)}`, 'admin');
    const all = guard(env, 'admin-all', 'adminAll');
    const [a, b] = [await mine('check'), await all('check')];
    if (a.locked || b.locked) { const s = Math.max(a.retryAfter, b.retryAfter); return html(429, adminLoginPage({ error: lockMessage(s) }), { 'Retry-After': String(s) }); }
    const form = await request.formData().catch(() => null);
    const input = String(form?.get('password') ?? '');
    if (!input || input.length > MAX_PASSWORD || !await secretMatches(env, input, env.ADMIN_PASSWORD, 'admin-check')) {
      const [c, d] = [await mine('fail'), await all('fail')];
      await wait(1000);
      if (c.locked || d.locked) { const s = Math.max(c.retryAfter, d.retryAfter); return html(429, adminLoginPage({ error: lockMessage(s) }), { 'Retry-After': String(s) }); }
      return html(401, adminLoginPage({ error: 'パスワードが違います。' }));
    }
    await mine('success');
    const value = await signValue(env, 'admin-session', { role: 'admin', exp: Date.now() + ADMIN_HOURS * 3600e3, v: await version(env) });
    return redirect('/admin', { 'Set-Cookie': adminCookie(value, ADMIN_HOURS * 3600) });
  }
  if (pathname === '/admin/logout' && method === 'POST') {
    if (!sameOrigin(request, url)) return text(403, '受け付けられないリクエストです。');
    return redirect('/admin', { 'Set-Cookie': adminCookie('', 0) });
  }
  if ((pathname === '/admin' || pathname === '/admin/') && method === 'GET') {
    return html(200, await isAdmin(request, env) ? adminPage() : adminLoginPage({}));
  }
  if (pathname.startsWith('/admin/api/')) {
    // Every API call: valid admin cookie + this site's own page + the screen's own header (blocks forged requests).
    if (!await isAdmin(request, env)) return json(401, { error: '管理画面にもう一度入室してください（12時間で自動的に退室します）。' });
    if (!sameOrigin(request, url) || request.headers.get('X-PP-Admin') !== '1') return json(403, { error: '受け付けられないリクエストです。' });
    try { return await api(request, env, url, pathname.slice('/admin/api/'.length)); }
    catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      console.error(error);
      return json(500, { error: 'エラーが発生しました。今の音源と曲の一覧は変わっていません。' });
    }
  }
  return html(404, messagePage('ページが見つかりません。'));
}
