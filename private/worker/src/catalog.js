// PIP POPPER PRIVATE — the song list (R2 "catalog.json") and safe changes to it.
//
// catalog.json { version: 2, rev, updated, songs: [...], retired: [...] }
//   songs[]   { id, title, cover, file, size, type, sha256, duration, audioUpdatedAt, addedAt }
//   retired[] audio no longer used by any song: { file, at, reason: 'replaced' | 'removed', song, entry?, index? }
//             A file is deleted from R2 only after RETIRE_GRACE has passed (a removed song can be restored until then).
// Every change is "read rev+etag -> change -> write only if the etag is unchanged" (R2 conditional write),
// and the screen must send the rev it was showing, so two screens or two devices can never overwrite each other.
import { HttpError } from './common.js';

export const CATALOG = 'catalog.json';
export const RETIRE_GRACE = 24 * 3600e3;          // old/removed audio is kept 24 h before deletion
export const RESTORE_LIMIT = 23 * 3600e3;          // restore allowed for 23 h (1 h margin before deletion)
export const MAX_UPLOAD = 50 * 1024 * 1024;

export function normalize(data) {
  const songs = (Array.isArray(data?.songs) ? data.songs : []).map(s => ({ ...s, audioUpdatedAt: s.audioUpdatedAt ?? data.updated ?? null }));
  return { version: 2, rev: Number.isInteger(data?.rev) ? data.rev : 0, updated: data?.updated ?? null, songs, retired: Array.isArray(data?.retired) ? data.retired : [] };
}
export async function loadCatalog(env) {
  const object = await env.BUCKET.get(CATALOG);
  if (!object) return { cat: normalize({}), etag: null };
  return { cat: normalize(await object.json()), etag: object.etag };
}
// Write only if nobody changed the file since it was read. Returns false on a conflict.
async function saveCatalog(env, cat, etag) {
  cat.rev += 1;
  cat.updated = new Date().toISOString();
  const options = { httpMetadata: { contentType: 'application/json' } };
  if (etag) options.onlyIf = { etagMatches: etag };
  const result = await env.BUCKET.put(CATALOG, JSON.stringify(cat, null, 2), options);
  return result !== null;
}
export const conflict = () => new HttpError(409, '別の画面（または別の端末）で先に変更されたため、今回の操作は行いませんでした。最新の状態を表示します。');

// Apply `change` to the newest list, only if it is still the version the screen showed (expectedRev).
export async function commit(env, expectedRev, change) {
  const { cat, etag } = await loadCatalog(env);
  if (expectedRev !== null && expectedRev !== cat.rev) throw conflict();
  const result = change(cat);
  if (!await saveCatalog(env, cat, etag)) throw conflict();
  return { cat, result };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const random = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

// Store an uploaded MP3 under a NEW name and prove it arrived intact. Nothing in the song list changes here,
// so until the list is switched, every listener keeps getting the current audio.
export async function storeUpload(request, env, id) {
  const length = Number(request.headers.get('Content-Length'));
  if (!length) throw new HttpError(411, 'ファイルの大きさが分かりませんでした。もう一度お試しください。');
  if (length > MAX_UPLOAD) throw new HttpError(413, `ファイルが大きすぎます（上限 ${MAX_UPLOAD / 1048576}MB）。`);
  const sha256 = (request.headers.get('X-Sha256') ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, '確認用の情報が足りません。画面を再読み込みしてからお試しください。');
  const key = `audio/${id}-${stamp()}-${random()}.mp3`;
  const failed = async message => { await env.BUCKET.delete(key).catch(() => {}); return new HttpError(422, message); };
  try {
    // R2 checks the SHA-256 the browser computed from the original file; a damaged upload is refused.
    await env.BUCKET.put(key, request.body, { sha256, httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { song: id, sha256 } });
  } catch {
    throw await failed('アップロードした音源が元のファイルと一致しませんでした（通信の途中で壊れた可能性があります）。');
  }
  const head = await env.BUCKET.head(key);
  if (!head || head.size !== length) throw await failed('アップロードした音源の大きさが元のファイルと一致しませんでした。');
  const first = await env.BUCKET.get(key, { range: { offset: 0, length: 3 } });
  const bytes = new Uint8Array(await new Response(first?.body ?? null).arrayBuffer());
  const isMp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!isMp3) throw await failed('MP3ファイルではないようです。');
  return { key, size: length, sha256 };
}

// Deletes audio that no song uses any more — only when it is certainly safe:
//  * retired files older than 24 h (replaced audio, or removed songs past their restore time), and
//  * stray uploads older than 24 h that never became part of the list (e.g. a closed browser mid-way).
// A file still named by any song is never deleted. Runs after a change, never just because a screen was opened.
export async function cleanup(env, now = Date.now()) {
  const { cat, etag } = await loadCatalog(env);
  const used = new Set(cat.songs.map(s => s.file));
  const due = cat.retired.filter(r => now - Date.parse(r.at) >= RETIRE_GRACE && !used.has(r.file));
  const listed = new Set(cat.retired.map(r => r.file));
  const stray = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: 'audio/', cursor });
    for (const o of page.objects) {
      const uploaded = o.uploaded instanceof Date ? o.uploaded.getTime() : Date.parse(o.uploaded);
      if (!used.has(o.key) && !listed.has(o.key) && now - uploaded >= RETIRE_GRACE) stray.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (!due.length && !stray.length) return { deleted: 0 };
  for (const key of [...due.map(r => r.file), ...stray]) await env.BUCKET.delete(key);
  if (due.length) {
    const gone = new Set(due.map(r => r.file));
    cat.retired = cat.retired.filter(r => !gone.has(r.file));
    await saveCatalog(env, cat, etag);                // a conflict here is harmless: the files are already gone
  }
  return { deleted: due.length + stray.length };
}
