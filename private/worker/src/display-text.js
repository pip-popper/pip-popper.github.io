// Display-only clean-up of the Markdown that ChatGPT adds to an "AIの感想" text (2026-11-24).
// The stored text (registration, track.json, catalog) is never changed; only what the page shows.
//  - a first line that is a Markdown heading ("### AIの感想｜曲名") repeats the page's own "AIの感想"
//    heading, so it is left out together with the blank lines after it;
//  - other heading marks at the start of a line ("## ") and bold marks ("**…**") are removed, the words stay.
export function displayText(text) {
  if (typeof text !== 'string' || !text) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (/^#{1,6}\s/.test(lines[0])) {
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
  }
  return lines.map(line => line.replace(/^#{1,6}\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1')).join('\n');
}
