// PIP POPPER PRIVATE — audio delivery from the private R2 bucket (range requests for seeking, ?download=1).
// Callers check the invitee or admin cookie first. Responses are never stored by browsers or caches (no-store),
// and pages add ?v=<audio version> to the address, so a replaced song is always heard in its new version.
import { text } from './common.js';
import { loadCatalog } from './catalog.js';

// Keep the URL, browser filename, label and response MIME type in agreement.
// Production uses MP3. WAV is also supported for the isolated preview fixtures.
export function audioFormat(song) {
  const suffix = /\.([a-z0-9]+)$/i.exec(song.file ?? '')?.[1]?.toLowerCase();
  const media = String(song.type ?? '').toLowerCase();
  const byType = !media ? null : ['audio/mpeg', 'audio/mp3'].includes(media) ? 'mp3' : ['audio/wav', 'audio/x-wav', 'audio/wave'].includes(media) ? 'wav' : 'unsupported';
  if ((suffix && !['mp3', 'wav'].includes(suffix)) || byType === 'unsupported' || (suffix && byType && suffix !== byType)) return null;
  const ext = suffix ?? byType ?? 'mp3';
  const safeTitle = [...String(song.title ?? song.id).toWellFormed()].slice(0, 100).join('').replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '') || song.id;
  return { ext, mime: ext === 'wav' ? 'audio/wav' : 'audio/mpeg', label: ext.toUpperCase(),
    filename: `PIP POPPER - ${safeTitle}.${ext}`, asciiFilename: `pip-popper-${String(song.id).replace(/[^a-z0-9-]/g, '_')}.${ext}` };
}
const encodedFilename = name => encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

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

export async function serveAudio(request, env, id, url, expectedExt) {
  const song = (await loadCatalog(env)).cat.songs.find(s => s.id === id);
  if (!song) return text(404, '見つかりません。');
  return streamAudio(request, env.BUCKET, song, url, expectedExt);
}

// Shared streaming helper; the caller supplies an already-authorized song and bucket.
export async function streamAudio(request, bucket, song, url, expectedExt, allowDownload=true) {
  const format = audioFormat(song);
  if (!format || (expectedExt && format.ext !== expectedExt)) return text(404, '音源の形式を確認できませんでした。');
  const range = parseRange(request.headers.get('Range'), song.size);
  if (range === 'bad') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${song.size}` } });
  const object = await bucket.get(song.file, range ? { range } : undefined);
  if (!object) return text(404, '見つかりません。');
  const headers = {
    'Content-Type': format.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(range ? range.length : song.size),
  };
  if (range) headers['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${song.size}`;
  headers['Content-Disposition'] = `${allowDownload && url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${format.asciiFilename}"; filename*=UTF-8''${encodedFilename(format.filename)}`;
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
