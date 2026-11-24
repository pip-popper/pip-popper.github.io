// 一般視聴の管理 — transport to the PRIVATE Worker's /admin/api/listen/... (2026-11-25, Claude Code).
// Same rule as the PRIVATE lyrics/password screens: the administrator password is used for one request cycle only
// (sign in → call → sign out). Nothing is stored; no Cloudflare API token is used or kept.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const OPS = ['copy-private', 'settings', 'publish', 'stop', 'resume', 'restore', 'remove', 'undelete'];
const error = (status, message) => ({ status, body: { error: message } });

async function withAdmin(base, password, fn, request = fetch) {
  if (typeof password !== 'string' || !password || password.length > 200) return error(400, '管理者パスワードを入力してください。');
  let cookie;
  try {
    const login = await request(new URL('admin/login', base), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
    if (login.status === 401) return error(403, '管理者パスワードが違います。');
    if (login.status === 429) return error(429, '一時的にロックされています。しばらく時間をおいてください。');
    cookie = login.status === 303 ? (login.headers.getSetCookie?.() ?? []).map(v => v.split(';')[0]).find(v => /^pp_admin=.+/.test(v)) : null;
    if (!cookie) return error(502, 'PRIVATE管理画面に接続できませんでした。');
    return await fn((route, init = {}) => request(new URL(`admin/api/${route}`, base), { redirect: 'error', signal: AbortSignal.timeout(120000), ...init,
      headers: { Cookie: cookie, 'X-PP-Admin': '1', ...(init.headers ?? {}) } }));
  } catch {
    return error(502, 'PRIVATEに接続できませんでした。結果は「読み込む」で確認してください。');
  } finally {
    if (cookie) try { await request(new URL('admin/logout', base), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Cookie: cookie } }); } catch {}
  }
}
const asJson = async r => { let data; try { data = await r.json(); } catch { return error(502, 'PRIVATEの応答を読み取れませんでした。'); }
  return r.ok ? { status: 200, body: data } : error(r.status, r.status === 404 && !data?.error ? 'PRIVATE側がまだ一般視聴の管理に対応していません（Workerの更新前）。' : data?.error ?? 'PRIVATEで処理できませんでした。'); };

// songs already on the official site: the only ones offered for listening (their public texts and jacket)
export async function officialSongs(root) {
  const ids = JSON.parse(await readFile(path.join(root, 'docs', 'works.json'), 'utf8')).map(s => s.id);
  const out = [];
  for (const id of ids) {
    try { const t = JSON.parse(await readFile(path.join(root, 'tracks', id, 'track.json'), 'utf8'));
      if (t.hidden === true) continue;
      out.push({ id, title: t.title, reading: t.reading ?? null, hasLyrics: !!t.lyrics, hasImpression: !!t.aiImpression, audioPrivate: t.audioRelease === 'private' }); } catch {}
  }
  return out;
}

export async function listenList(root, base, body) {
  const r = await withAdmin(base, body?.adminPassword, async call => asJson(await call('listen')));
  if (r.status !== 200) return r;
  return { status: 200, body: { ...r.body, official: await officialSongs(root) } };
}
export async function listenUpload(root, base, password, meta, bytes) {
  if (!/^[a-z0-9-]+$/.test(meta.id ?? '') || !Number.isSafeInteger(meta.rev) || !/^[0-9a-f]{64}$/.test(meta.sha256 ?? '') || !bytes?.length) return error(400, '登録する内容を確認してください。');
  const song = (await officialSongs(root)).find(s => s.id === meta.id);
  if (!song) return error(400, '公式サイトに掲載中の曲だけ登録できます。');
  return withAdmin(base, password, async call => asJson(await call(`listen/${meta.id}/upload`, { method: 'POST', body: bytes,
    headers: { 'Content-Type': 'audio/mpeg', 'X-Rev': String(meta.rev), 'X-Sha256': meta.sha256, 'X-Duration': String(Number(meta.duration) || ''), 'X-Title': encodeURIComponent(song.title) } })));
}
export async function listenAction(root, base, body) {
  const { id, op } = body ?? {};
  if (!/^[a-z0-9-]+$/.test(id ?? '') || !OPS.includes(op) || !Number.isSafeInteger(body.rev)) return error(400, '操作を確認してください。');
  const song = (await officialSongs(root)).find(s => s.id === id);
  let payload = { rev: body.rev };
  if (op === 'settings') {
    if (!song) return error(400, '公式サイトに掲載中の曲だけ設定できます。');
    const t = JSON.parse(await readFile(path.join(root, 'tracks', id, 'track.json'), 'utf8'));
    const items = { lyrics: body.items?.lyrics === true, jacket: body.items?.jacket === true, impression: body.items?.impression === true };
    let jacket = null;
    if (items.jacket) { try { jacket = (await readFile(path.join(root, 'tracks', id, 'cover-640.jpg'))).toString('base64'); } catch { return error(400, '公式サイトのジャケット画像が見つかりません。'); } }
    // only texts that the official site already shows
    payload = { ...payload, items, title: t.title, reading: t.reading ?? '', lyrics: items.lyrics ? t.lyrics ?? null : null, impression: items.impression ? t.aiImpression ?? null : null, jacket };
  }
  if (op === 'copy-private') { if (body.confirm !== true) return error(400, '確認が必要です。'); payload = { ...payload, confirm: 'PRIVATEの音源を一般視聴用にコピーする', title: song?.title }; }
  if (op === 'publish' || op === 'remove') payload.confirm = body.confirm === true;
  if (op === 'restore') { payload.which = body.which === 'live' ? 'live' : undefined; payload.index = Number.isInteger(body.index) ? body.index : undefined; }
  return withAdmin(base, body.adminPassword, async call => asJson(await call(`listen/${id}/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })));
}
// a draft/published MP3 for listening in the manager before publishing (bytes come back in this one call)
export async function listenAudio(base, body) {
  if (!/^[a-z0-9-]+$/.test(body?.id ?? '')) return error(400, '曲を確認してください。');
  return withAdmin(base, body.adminPassword, async call => {
    const r = await call(`listen/${body.id}/audio${body.which === 'live' ? '?which=live' : ''}`);
    if (!r.ok) return asJson(r);
    return { status: 200, audio: Buffer.from(await r.arrayBuffer()) };
  });
}
