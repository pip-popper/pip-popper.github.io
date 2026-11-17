// PIP POPPER PRIVATE — audio delivery from the private R2 bucket (range requests for seeking, ?download=1).
// Callers check the invitee or admin cookie first. Responses are never stored by browsers or caches (no-store),
// and pages add ?v=<audio version> to the address, so a replaced song is always heard in its new version.
import { text } from './common.js';
import { loadCatalog } from './catalog.js';

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

export async function serveAudio(request, env, id, url) {
  const song = (await loadCatalog(env)).cat.songs.find(s => s.id === id);
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
