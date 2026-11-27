// 2026-11-27: the song's category on the official site's song list (track.json "category"), shared by build.mjs and the manager.
// Only two: PIP POPPER and ソロ曲 (solo songs are not split by member). No "category" = PIP POPPER, the value every
// song had before, so untouched songs stay byte-identical; only "solo" is written to track.json.
export const CATEGORIES = [
  { value: 'pip-popper', label: 'PIP POPPER' },
  { value: 'solo', label: 'ソロ曲' },
];
export const categoryLabel = value => CATEGORIES.find(c => c.value === (value ?? 'pip-popper'))?.label ?? null;

// returns 'pip-popper' or 'solo', or throws on a value the site does not know
export function readCategory(category) {
  if (category === undefined || category === null) return 'pip-popper';
  if (!CATEGORIES.some(c => c.value === category)) throw new Error('category は pip-popper か solo にしてください');
  return category;
}

// what is written to track.json: nothing for PIP POPPER
export const storedCategory = value => readCategory(value) === 'solo' ? 'solo' : undefined;
