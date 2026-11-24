// PRIVATE display order only. Never sort or mutate the stored R2 catalog array.
// NFKC folds half-width kana and full-width letters/numbers; katakana shares
// the equivalent hiragana key. The Producer may supply a reading for kanji.
const japanese = new Intl.Collator('ja', { usage: 'sort', sensitivity: 'base', numeric: true });
const detail = new Intl.Collator('ja', { usage: 'sort', sensitivity: 'variant', numeric: true });
const normalize = text => String(text ?? '').normalize('NFKC').trim().toLowerCase()
  .replace(/[\u30a1-\u30f6\u30fd\u30fe]/g, c=>String.fromCharCode(c.charCodeAt(0)-0x60));

export function validReading(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\r\n\u0000-\u001f\u007f]/.test(value)) return false;
  const norm = value.normalize('NFKC').trim();
  return !norm || (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Mark}A-Za-z0-9ー・ .'’\-]+$/u.test(norm) && /[\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/u.test(norm));
}

function keyFor(song, mode) {
  const reading = mode !== 'az' && typeof song.reading === 'string' && validReading(song.reading) ? song.reading.trim() : '';
  const key = normalize(reading || song.title).replace(/^[\p{P}\p{S}\s]+/u, '');
  // Kana → A–Z → numbers (natural numeric order) → unassigned kanji/other.
  const group = /^[\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(key) ? 0 : /^[a-z]/.test(key) ? 1 : /^[0-9]/.test(key) ? 2 : 3;
  return { song, key, group };
}

export function sortedSongs(songs, mode = 'kana') {
  const rank = mode === 'az' ? [2,0,1,3] : [0,1,2,3];
  return songs.map(s=>keyFor(s,mode)).sort((a,b)=>rank[a.group]-rank[b.group] || japanese.compare(a.key,b.key) || detail.compare(a.key,b.key) ||
    japanese.compare(normalize(a.song.title),normalize(b.song.title)) || String(a.song.id).localeCompare(String(b.song.id),'en')).map(x=>x.song);
}
