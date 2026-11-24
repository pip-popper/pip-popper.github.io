// PIP POPPER PRIVATE — administrator screen (/admin) and its API (/admin/api/...).
// Secret (Cloudflare only, never in code/GitHub): ADMIN_PASSWORD — 12+ characters and different from PRIVATE_PASSWORD.
import { listenApi } from './listen-admin.js';
import { SITE, MAX_PASSWORD, HttpError, html, json, text, redirect, sameOrigin, signValue, readSigned, secretMatches,
  secretVersion, guard, connection, lockMessage, wait } from './common.js';
import { loadCatalog, commit, storeUpload, cleanup, RETIRE_GRACE, RESTORE_LIMIT, MAX_UPLOAD } from './catalog.js';
import { adminLoginPage, adminPage, messagePage } from './pages.js';
import { loadCredential, saveCredential, removeCredential, MIN_PASSWORD, CREDENTIAL_KEY } from './credential.js';
import { serveAudio } from './audio.js';
import { validReading, sortedSongs } from './song-order.js';

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

// Invitee password (manager tool). Besides the admin cookie, the screen header and the same-site check that every
// admin API call needs, each change asks for the administrator password again and counts every attempt.
const RESTORE_WORDS = '旧パスワードに戻す';
async function passwordApi(request, env, path) {
  const method = request.method;
  if (path === 'private-password' && method === 'GET') {
    const cred = await loadCredential(env);
    return json(200, { mode: cred ? 'r2' : 'secret', changedAt: cred?.changedAt ?? null });
  }
  if (method !== 'POST' || (path !== 'private-password' && path !== 'private-password/restore')) return null;
  const tries = guard(env, 'pw-change', 'pwChange');
  const mine = guard(env, `admin:${connection(request)}`, 'admin');
  const all = guard(env, 'admin-all', 'adminAll');
  // pwChange: counted and checked in one step (one Durable Object, one request at a time = no race between workers)
  const counted = await tries('fail');                          // every attempt counts (success or not)
  const states = [counted, await mine('check'), await all('check')];
  if (states.some(s => s.locked)) throw new HttpError(429, lockMessage(Math.max(...states.map(s => s.retryAfter))));
  const body = await bodyJson(request);
  const adminPassword = typeof body.adminPassword === 'string' ? body.adminPassword : '';
  if (!adminPassword || adminPassword.length > MAX_PASSWORD || !await secretMatches(env, adminPassword, env.ADMIN_PASSWORD, 'admin-check')) {
    await mine('fail'); await all('fail');
    await wait(1000);
    throw new HttpError(403, '管理者パスワードが違います。');
  }
  if (path === 'private-password/restore') {
    if (body.confirm !== RESTORE_WORDS) throw new HttpError(400, `確認のため「${RESTORE_WORDS}」と入力してください。`);
    if (!await env.BUCKET.head(CREDENTIAL_KEY)) throw new HttpError(409, 'すでにCloudflareに登録されたパスワードを使っています。');
    await removeCredential(env);                                // works even if the file is damaged
    if (await env.BUCKET.head(CREDENTIAL_KEY)) throw new HttpError(500, '元に戻せませんでした。今のパスワードのままです。');
    return json(200, { ok: true, mode: 'secret', message: 'Cloudflareに登録されたパスワードに戻しました。招待者は全員、入り直しになります。' });
  }
  const pw = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (pw.length < MIN_PASSWORD || pw.length > MAX_PASSWORD) throw new HttpError(400, `新しいパスワードは${MIN_PASSWORD}〜${MAX_PASSWORD}文字にしてください。`);
  if (pw !== pw.trim()) throw new HttpError(400, '新しいパスワードの最初と最後に空白を入れないでください。');
  if (await secretMatches(env, pw, env.ADMIN_PASSWORD, 'admin-check')) throw new HttpError(400, '管理者パスワードとは別のパスワードにしてください。');
  const saved = await saveCredential(env, pw);
  return json(200, { ok: true, mode: 'r2', changedAt: saved.changedAt, message: 'パスワードを変更しました。招待者は全員、新しいパスワードで入り直しになります。' });
}

async function api(request, env, url, path) {
  const method = request.method;
  const pw = await passwordApi(request, env, path);
  if (pw) return pw;
  if (path === 'listen' || path.startsWith('listen/')) return listenApi(request, env, url, path);   // 一般視聴の管理 (2026-11-25)
  if (path === 'catalog' && method === 'GET') return json(200, view((await loadCatalog(env)).cat));
  if (path === 'works' && method === 'GET') return json(200, { works: await works(env) });

  // PRIVATE lyrics and optional title reading are keyed by the existing song ID. No audio cleanup
  // is run for this operation; the same conditional catalog write protects edits.
  if (path === 'lyrics' && method === 'GET') {
    const { cat } = await loadCatalog(env);
    return json(200, { rev: cat.rev, songs: sortedSongs(cat.songs).map(s => ({ id: s.id, title: s.title,
      lyrics: typeof s.lyrics === 'string' ? s.lyrics : '', reading: typeof s.reading === 'string' ? s.reading : '', publicWork: typeof s.cover === 'string' && s.cover === `${SITE}assets/covers/${s.id}-640.jpg` })) });
  }
  const lyricMatch = /^songs\/([a-z0-9-]+)\/lyrics$/.exec(path);
  if (lyricMatch && method === 'POST') {
    const body = await bodyJson(request);
    const hasLyrics = body && Object.hasOwn(body, 'lyrics'), hasReading = body && Object.hasOwn(body, 'reading');
    if (!body || !Number.isSafeInteger(body.rev) || body.rev < 0 || body.id !== lyricMatch[1] || (!hasLyrics && !hasReading) || (hasLyrics && (typeof body.lyrics !== 'string' || body.lyrics.length > 100000)) || body.confirm !== true)
      throw new HttpError(400, '曲・歌詞・確認内容を確認してください（歌詞は10万文字以内）。');
    if (hasReading && !validReading(body.reading)) throw new HttpError(400, 'よみがなは100文字以内のひらがな・カタカナ・英数字で入力してください。');
    const { cat, result } = await commit(env, body.rev, c => {
      const song = c.songs.find(s => s.id === lyricMatch[1]);
      if (!song) throw new HttpError(404, 'この曲は登録されていません。');
      if (hasLyrics) song.lyrics = body.lyrics;
      if (hasReading) song.reading = body.reading.trim();
      return { id: song.id, title: song.title, lyrics: typeof song.lyrics === 'string' ? song.lyrics : '', reading: typeof song.reading === 'string' ? song.reading : '' };
    });
    return json(200, { ok: true, rev: cat.rev, song: result, orderedIds: sortedSongs(cat.songs).map(s=>s.id), message: '変更した内容を保存しました。' });
  }

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
    // The screen's own header is required for every call except listening: an <audio> element cannot send custom
    // headers. Listening only reads (never changes anything) and still needs the admin cookie (SameSite=Strict).
    const listening = method === 'GET' && /^\/admin\/api\/songs\/[a-z0-9-]+\/audio$/.test(pathname);
    if (!sameOrigin(request, url) || (!listening && request.headers.get('X-PP-Admin') !== '1')) return json(403, { error: '受け付けられないリクエストです。' });
    try { return await api(request, env, url, pathname.slice('/admin/api/'.length)); }
    catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      console.error(error);
      return json(500, { error: 'エラーが発生しました。今の音源と曲の一覧は変わっていません。' });
    }
  }
  return html(404, messagePage('ページが見つかりません。'));
}
