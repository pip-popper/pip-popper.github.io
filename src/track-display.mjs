// 2026-11-25: what the official site shows for each song (track.json "display"), shared by build.mjs and the manager.
// No "display" = everything shown (the state every song had before). Nothing is ever deleted: unchecked items
// are only left out of the pages, and come back when checked again.
export const LYRICS_NOTICES = [
  { value: 'general', label: '① 一般的な案内', text: 'この楽曲には一部不適切な表現が含まれるため、歌詞の掲載を控えています。' },
  { value: 'women', label: '② 女性の理解を得るのが難しい', text: 'この楽曲の歌詞は、女性の皆さまからご理解をいただくことが難しいと判断したため、掲載を控えています。' },
  { value: 'broadminded', label: '③ 心の広い人限定', text: 'この楽曲の歌詞は、非常に心の広い方にしか受け止めていただけない可能性があるため、掲載を控えています。' },
];
export const noticeText = value => LYRICS_NOTICES.find(n => n.value === value)?.text ?? null;

// returns { lyrics, jacket, impression, lyricsNotice } or throws on a value the site does not know
export function readDisplay(display) {
  if (display === undefined || display === null) return { lyrics: true, jacket: true, impression: true, lyricsNotice: null };
  if (typeof display !== 'object' || Array.isArray(display)) throw new Error('display の形式が正しくありません');
  const known = new Set(['lyrics', 'jacket', 'impression', 'lyricsNotice']);
  for (const k of Object.keys(display)) if (!known.has(k)) throw new Error(`display に不明な項目があります: ${k}`);
  for (const k of ['lyrics', 'jacket', 'impression']) if (k in display && typeof display[k] !== 'boolean') throw new Error(`display.${k} は true か false にしてください`);
  const n = display.lyricsNotice ?? null;
  if (n !== null && !noticeText(n)) throw new Error('歌詞を掲載しない理由が正しくありません');
  const lyrics = display.lyrics !== false;
  return { lyrics, jacket: display.jacket !== false, impression: display.impression !== false, lyricsNotice: lyrics ? null : n };
}

// what is written to track.json: nothing when everything is shown, so untouched songs stay byte-identical
export function storedDisplay(d) {
  const v = readDisplay(d);
  if (v.lyrics && v.jacket && v.impression) return undefined;
  return { lyrics: v.lyrics, jacket: v.jacket, impression: v.impression, ...(v.lyrics ? {} : { lyricsNotice: v.lyricsNotice }) };
}
