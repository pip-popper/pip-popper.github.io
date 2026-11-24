// PIP POPPER 一般視聴の管理 (2026-11-25, Claude Code) — /admin/api/listen/... (admin cookie + X-PP-Admin, like the other admin APIs).
//
// public-manage.json (NOT readable from /listen/): one entry per song.
//   { id, title, reading?, status: 'draft' | 'published' | 'stopped' | 'removed',
//     draft: Version | null,  live: Version | null,  history: Version[] (older published versions, newest first, max 10) }
//   Version = { file, size, sha256, duration, source: 'upload'|'private', items: { lyrics, jacket, impression },
//               lyrics?, impression?, jacketFile?, at }
// Saving (upload, copy from PRIVATE, settings) only changes `draft`. "Publish" copies draft → live and writes
// public-catalog.json (the only file /listen/ reads). Stop/resume only change status. Audio and jacket objects are
// written under new names and never deleted here, so every older version can be restored.
import { HttpError, json } from './common.js';
import { loadCatalog } from './catalog.js';

const MANAGE = 'public-manage.json', CATALOG = 'public-catalog.json';
export const LISTEN_MAX_UPLOAD = 50 * 1024 * 1024;
const ID = /^[a-z0-9-]{1,80}$/;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').toLowerCase();
const random = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

async function loadManage(env) {
  const o = await env.BUCKET.get(MANAGE);
  if (!o) return { data: { version: 1, rev: 0, songs: [] }, etag: null };
  const data = await o.json();
  if (data?.version !== 1 || !Array.isArray(data.songs)) throw new HttpError(500, '一般視聴の管理記録を読めません。');
  return { data, etag: o.etag };
}
// What /listen/ shows: only published songs, built fresh from their published version.
export function catalogOf(data) {
  return { version: 1, updated: new Date().toISOString(), songs: data.songs.filter(s => s.status === 'published' && s.live).map(s => {
    const v = s.live;
    return { id: s.id, title: s.title, ...(s.reading ? { reading: s.reading } : {}), classification: 'general', publicAudioApproved: true,
      audioKey: v.file, size: v.size, ...(v.duration ? { duration: v.duration } : {}),
      ...(v.items.lyrics && v.lyrics ? { lyricsScope: 'public', publicLyricsApproved: true, lyrics: v.lyrics } : {}),
      ...(v.items.impression && v.impression ? { impressionScope: 'public', publicImpressionApproved: true, impression: v.impression } : {}),
      ...(v.items.jacket && v.jacketFile ? { jacketKey: v.jacketFile, publicJacketApproved: true } : {}) };
  }) };
}
// change → write public-manage.json only if nobody changed it meanwhile; the public catalog follows when asked
async function commit(env, rev, change, { republish = false } = {}) {
  const { data, etag } = await loadManage(env);
  if (rev !== data.rev) throw new HttpError(409, '別の画面で先に変更されました。「更新」で読み直してください。');
  const result = change(data);
  data.rev += 1; data.updated = new Date().toISOString();
  const opts = { httpMetadata: { contentType: 'application/json' }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) };
  if (await env.BUCKET.put(MANAGE, JSON.stringify(data, null, 2), opts) === null) throw new HttpError(409, '別の画面で先に変更されました。「更新」で読み直してください。');
  if (republish) await env.BUCKET.put(CATALOG, JSON.stringify(catalogOf(data), null, 2), { httpMetadata: { contentType: 'application/json' } });
  return { rev: data.rev, result };
}
const entryOf = (data, id) => { const s = data.songs.find(x => x.id === id); if (!s) throw new HttpError(404, 'この曲は一般視聴に登録されていません。'); return s; };
const view = s => ({ id: s.id, title: s.title, status: s.status, draft: s.draft && strip(s.draft), live: s.live && strip(s.live), history: s.history.map(strip), changed: !!s.draft && JSON.stringify(s.draft) !== JSON.stringify(s.live) });
const strip = v => ({ file: v.file, size: v.size, duration: v.duration ?? null, source: v.source, items: v.items, hasLyrics: !!v.lyrics, hasImpression: !!v.impression, hasJacket: !!v.jacketFile, at: v.at });
const blank = () => ({ items: { lyrics: false, jacket: false, impression: false } });
function ensure(data, id, title) {
  let s = data.songs.find(x => x.id === id);
  if (!s) { s = { id, title, status: 'draft', draft: null, live: null, history: [] }; data.songs.push(s); }
  if (title) s.title = title;
  if (s.status === 'removed') s.status = s.live ? 'stopped' : 'draft';
  return s;
}
const isMp3 = b => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

export async function listenApi(request, env, url, path) {
  const method = request.method;
  const body = async () => { try { return await request.json(); } catch { throw new HttpError(400, '形式が正しくありません。'); } };
  if (path === 'listen' && method === 'GET') {
    const { data } = await loadManage(env);
    const { cat } = await loadCatalog(env);
    return json(200, { rev: data.rev, songs: data.songs.map(view), privateSongs: cat.songs.map(s => ({ id: s.id, title: s.title, size: s.size, duration: s.duration ?? null })) });
  }
  // the published/draft audio for a preview in the manager (admin only)
  const audio = /^listen\/([a-z0-9-]+)\/audio$/.exec(path);
  if (audio && method === 'GET') {
    const { data } = await loadManage(env); const s = entryOf(data, audio[1]);
    const v = url.searchParams.get('which') === 'live' ? s.live : s.draft ?? s.live;
    if (!v) throw new HttpError(404, '音源がありません。');
    const o = await env.BUCKET.get(v.file); if (!o) throw new HttpError(404, '音源がありません。');
    return new Response(o.body, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(v.size), 'Cache-Control': 'no-store' } });
  }
  const m = /^listen\/([a-z0-9-]+)\/(upload|copy-private|settings|publish|stop|resume|restore|remove|undelete)$/.exec(path);
  if (!m || method !== 'POST') throw new HttpError(404, '見つかりません。');
  const id = m[1], op = m[2];
  if (!ID.test(id)) throw new HttpError(400, '曲IDが正しくありません。');

  if (op === 'upload') {
    // raw MP3 body; headers carry the check values (the manager computed them from the original file)
    const rev = Number(request.headers.get('X-Rev')), length = Number(request.headers.get('Content-Length'));
    const sha256 = (request.headers.get('X-Sha256') ?? '').toLowerCase(), duration = Number(request.headers.get('X-Duration'));
    const title = decodeURIComponent(request.headers.get('X-Title') ?? '');
    if (!Number.isSafeInteger(rev) || !length || !/^[0-9a-f]{64}$/.test(sha256) || !title || title.length > 150) throw new HttpError(400, '確認用の情報が足りません。');
    if (length > LISTEN_MAX_UPLOAD) throw new HttpError(413, `ファイルが大きすぎます（上限 ${LISTEN_MAX_UPLOAD / 1048576}MB）。`);
    const key = `public-audio/${id}-${stamp()}-${random()}.mp3`;
    const fail = async msg => { await env.BUCKET.delete(key).catch(() => {}); return new HttpError(422, msg); };
    try { await env.BUCKET.put(key, request.body, { sha256, httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { song: id, sha256, purpose: 'public-listening' } }); }
    catch { throw await fail('アップロードした音源が元のファイルと一致しませんでした。'); }
    const head = await env.BUCKET.head(key);
    if (!head || head.size !== length) throw await fail('アップロードした音源の大きさが元のファイルと一致しませんでした。');
    const first = await env.BUCKET.get(key, { range: { offset: 0, length: 3 } });
    if (!isMp3(new Uint8Array(await new Response(first?.body ?? null).arrayBuffer()))) throw await fail('MP3ファイルではないようです。');
    const r = await commit(env, rev, d => { const s = ensure(d, id, title); s.draft = { ...(s.draft ?? s.live ?? blank()), file: key, size: length, sha256, duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null, source: 'upload', at: new Date().toISOString() }; return view(s); });
    return json(200, { rev: r.rev, song: r.result, message: '音源を登録しました（まだ公開していません）。' });
  }
  const b = await body();
  const rev = b?.rev;
  if (!Number.isSafeInteger(rev)) throw new HttpError(400, '確認用の情報が足りません。');

  if (op === 'copy-private') {
    // only when the Producer named this song and confirmed in words: PRIVATE audio becomes a separate public copy
    if (b.confirm !== 'PRIVATEの音源を一般視聴用にコピーする') throw new HttpError(400, '確認の言葉が違います。');
    const { cat } = await loadCatalog(env);
    const p = cat.songs.find(s => s.id === id);
    if (!p || !/\.mp3$/.test(p.file ?? '')) throw new HttpError(404, 'PRIVATEにこの曲のMP3がありません。');
    const src = await env.BUCKET.get(p.file); if (!src) throw new HttpError(404, 'PRIVATEの音源が見つかりません。');
    const key = `public-audio/${id}-${stamp()}-${random()}.mp3`;
    await env.BUCKET.put(key, src.body, { ...(p.sha256 ? { sha256: p.sha256 } : {}), httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { song: id, purpose: 'public-listening', copiedFrom: 'private' } });
    const head = await env.BUCKET.head(key);
    if (!head || head.size !== p.size) { await env.BUCKET.delete(key).catch(() => {}); throw new HttpError(422, 'コピーした音源の大きさが一致しませんでした。'); }
    const r = await commit(env, rev, d => { const s = ensure(d, id, typeof b.title === 'string' && b.title ? b.title.slice(0, 150) : p.title); s.draft = { ...(s.draft ?? s.live ?? blank()), file: key, size: p.size, sha256: p.sha256 ?? null, duration: p.duration ?? null, source: 'private', at: new Date().toISOString() }; return view(s); });
    return json(200, { rev: r.rev, song: r.result, message: 'PRIVATEの音源を一般視聴用にコピーしました（まだ公開していません。PRIVATEは変わりません）。' });
  }
  if (op === 'settings') {
    const items = { lyrics: b.items?.lyrics === true, jacket: b.items?.jacket === true, impression: b.items?.impression === true };
    const text = (v, name) => { if (v == null || v === '') return null; if (typeof v !== 'string' || v.length > 100000) throw new HttpError(400, `${name}を確認してください。`); return v; };
    const lyrics = items.lyrics ? text(b.lyrics, '歌詞') : null, impression = items.impression ? text(b.impression, 'AIの感想') : null;
    if (items.lyrics && !lyrics) throw new HttpError(400, '公開する歌詞がありません（公式HPの曲に歌詞が登録されていません）。');
    if (items.impression && !impression) throw new HttpError(400, '公開するAIの感想がありません。');
    let jacketFile = null;
    if (items.jacket) {
      if (typeof b.jacket !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.jacket) || b.jacket.length > 3e6) throw new HttpError(400, 'ジャケット画像を確認してください。');
      const bytes = Uint8Array.from(atob(b.jacket), c => c.charCodeAt(0));
      if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) throw new HttpError(400, 'ジャケットはJPEGのみです。');
      jacketFile = `public-jackets/${id}-${stamp()}-${random()}.jpg`;
      await env.BUCKET.put(jacketFile, bytes, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { song: id, purpose: 'public-listening' } });
    }
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 150) : null;
    const reading = typeof b.reading === 'string' && b.reading.length <= 100 ? b.reading.trim() : undefined;
    const r = await commit(env, rev, d => { const s = ensure(d, id, title); if (reading !== undefined) s.reading = reading || undefined;
      const base = s.draft ?? s.live; if (!base?.file) throw new HttpError(400, '先に一般視聴用のMP3を登録してください。');
      s.draft = { ...base, items, lyrics, impression, jacketFile: jacketFile ?? (items.jacket ? base.jacketFile ?? null : null), at: new Date().toISOString() };
      if (items.jacket && !s.draft.jacketFile) throw new HttpError(400, 'ジャケット画像がありません。');
      return view(s); });
    return json(200, { rev: r.rev, song: r.result, message: '公開する項目を保存しました（まだ公開していません）。' });
  }
  if (op === 'publish') {
    if (b.confirm !== true) throw new HttpError(400, '公開前の確認が必要です。');
    const r = await commit(env, rev, d => { const s = entryOf(d, id); const v = s.draft ?? s.live;
      if (!v?.file) throw new HttpError(400, '公開する音源がありません。');
      if (s.live && JSON.stringify(s.live) !== JSON.stringify(v)) s.history = [s.live, ...s.history].slice(0, 10);
      s.live = v; s.draft = null; s.status = 'published'; s.publishedAt = new Date().toISOString(); return view(s); }, { republish: true });
    return json(200, { rev: r.rev, song: r.result, message: '一般視聴に公開しました。' });
  }
  if (op === 'stop' || op === 'resume' || op === 'remove' || op === 'undelete') {
    if (op === 'remove' && b.confirm !== true) throw new HttpError(400, '確認が必要です。');
    const r = await commit(env, rev, d => { const s = entryOf(d, id);
      if (op === 'stop') { if (s.status !== 'published') throw new HttpError(409, '公開中ではありません。'); s.status = 'stopped'; }
      if (op === 'resume') { if (!s.live) throw new HttpError(409, '公開したことのある版がありません。先に「公開」してください。'); s.status = 'published'; }
      if (op === 'remove') s.status = 'removed';
      if (op === 'undelete') { if (s.status !== 'removed') throw new HttpError(409, '削除されていません。'); s.status = s.live ? 'stopped' : 'draft'; }
      return view(s); }, { republish: true });
    return json(200, { rev: r.rev, song: r.result, message: { stop: '一般視聴の掲載を停止しました。', resume: '一般視聴の掲載を再開しました。', remove: '一般視聴の一覧から外しました（音源は残っています。戻せます）。', undelete: '一般視聴の一覧に戻しました。' }[op] });
  }
  if (op === 'restore') {
    // an older published version (or the current published one) becomes the draft again; publish to make it live
    const r = await commit(env, rev, d => { const s = entryOf(d, id); const v = b.which === 'live' ? s.live : s.history[b.index];
      if (!v) throw new HttpError(404, 'その版がありません。'); s.draft = { ...v, at: new Date().toISOString() }; return view(s); });
    return json(200, { rev: r.rev, song: r.result, message: '以前の版を下書きに戻しました（「公開」で公開されます）。' });
  }
  throw new HttpError(404, '見つかりません。');
}
