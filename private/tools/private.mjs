// PIP POPPER PRIVATE — local helper. Songs are managed on the admin screen (/admin); this tool never changes R2.
//
//   node private/tools/private.mjs assets   copy site.css / stage.jpg into the Worker (same look as the site)
//   node private/tools/private.mjs backup   copy every PRIVATE song from R2 to a NEW dated folder
//                                           ..\PIP POPPER PRIVATE音源\R2バックアップ\<日時>\ (needs `wrangler login`)
//
// Safety: the backup only creates a new folder. It never deletes, moves or overwrites any existing file,
// so the originals and earlier backups stay untouched whatever happens in R2.
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workerDir = path.join(root, 'private', 'worker');
const BUCKET = 'pip-popper-private-audio';                 // same as wrangler.toml bucket_name
const [command, ...rest] = process.argv.slice(2);
const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const fail = message => { console.error(`エラー: ${message}`); process.exit(1); };

function wranglerGet(key, file) {
  const bin = path.join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(bin)) fail('wrangler が未導入です（private/worker で npm install を実行）。');
  const r = spawnSync(process.execPath, [bin, 'r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, '--remote'], { cwd: workerDir, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) fail(`R2 から取得できませんでした: ${key}`);
}

if (command === 'assets') {
  const dest = path.join(workerDir, 'public', 'assets');
  await mkdir(dest, { recursive: true });
  for (const f of ['site.css', 'stage.jpg']) await copyFile(path.join(root, 'src', f), path.join(dest, f));
  console.log('site.css / stage.jpg を Worker 用にコピーしました。');
} else if (command === 'backup') {
  const base = path.resolve(option('--to') ?? path.join(root, '..', 'PIP POPPER PRIVATE音源', 'R2バックアップ'));
  const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const dir = path.join(base, stamp);
  if (existsSync(dir)) fail(`同じ名前のフォルダーがすでにあります（上書きしません）: ${dir}`);
  await mkdir(dir, { recursive: true });
  wranglerGet('catalog.json', path.join(dir, 'catalog.json'));
  const catalog = JSON.parse(await readFile(path.join(dir, 'catalog.json'), 'utf8'));
  const lines = [];
  for (const [i, song] of (catalog.songs ?? []).entries()) {
    const name = `${String(i + 1).padStart(2, '0')}_${song.id}.mp3`;
    wranglerGet(song.file, path.join(dir, name));
    const data = await readFile(path.join(dir, name));
    const sha = createHash('sha256').update(data).digest('hex');
    const ok = data.length === song.size && (!song.sha256 || song.sha256 === sha);
    lines.push(`${ok ? 'OK' : 'NG'}  ${name}  ${song.title}  ${(data.length / 1048576).toFixed(1)}MB`);
    if (!ok) console.error(`一致しません: ${name}`);
  }
  await writeFile(path.join(dir, '一覧.txt'), lines.join('\r\n') + '\r\n');
  console.log(`${lines.length} 曲をバックアップしました → ${dir}`);
  console.log(lines.join('\n'));
} else {
  console.log('使い方: node private/tools/private.mjs assets | backup [--to <フォルダー>]');
  console.log('曲の追加・差し替え・並べ替え・削除は管理画面（/admin）で行います。');
  process.exit(command ? 1 : 0);
}
