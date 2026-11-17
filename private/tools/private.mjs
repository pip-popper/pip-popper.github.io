// PIP POPPER PRIVATE — song list and files for the private library.
//
//   node private/tools/private.mjs assets                 copy site.css / stage.jpg into the Worker (same look as the site)
//   node private/tools/private.mjs build [--audio <dir>]  check the audio folder and make the R2 contents in private/.r2/
//   node private/tools/private.mjs upload [--dry-run]     build, then send only changed files to the R2 bucket
//
// Audio folder (default: ..\PIP POPPER PRIVATE音源, next to this repository; never put in GitHub):
//   曲目.txt     one song ID per line (= tracks/<id>/ of the official site). Lines starting with # are ignored.
//                Order in the file = order in the library. Only songs the Producer has allowed go here.
//   <id>.mp3     the audio file for each listed ID.
// private/.r2/ then holds exactly what the R2 bucket must contain: catalog.json and audio/<id>.mp3.
// private/.r2-state.json remembers what was last sent (SHA-256 per file), so unchanged audio is not sent again.
import { readFile, writeFile, mkdir, copyFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workerDir = path.join(root, 'private', 'worker');
const SITE = 'https://pip-popper.github.io/';
const BUCKET = 'pip-popper-private-audio';                      // same as wrangler.toml bucket_name
const [command, ...rest] = process.argv.slice(2);
const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const fail = message => { console.error(`エラー: ${message}`); process.exit(1); };
const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');

async function build() {
  const audioDir = path.resolve(option('--audio') ?? path.join(root, '..', 'PIP POPPER PRIVATE音源'));
  const out = path.resolve(option('--out') ?? path.join(root, 'private', '.r2'));
  const listFile = path.join(audioDir, '曲目.txt');
  if (!existsSync(listFile)) fail(`曲目.txt がありません: ${listFile}`);
  const ids = (await readFile(listFile, 'utf8')).replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (new Set(ids).size !== ids.length) fail('曲目.txt に同じ曲IDが2回書かれています。');
  const songs = [];
  for (const id of ids) {
    if (!/^[a-z0-9-]+$/.test(id)) fail(`曲IDの形式が違います: ${id}`);
    const test = id.startsWith('test-');                   // test-… = verification file only (no official track, no jacket)
    const meta = path.join(root, 'tracks', id, 'track.json');
    if (!test && !existsSync(meta)) fail(`公式サイトにない曲IDです: ${id}（tracks/${id}/track.json がありません）`);
    const title = test ? `検証用の無音MP3（${id}）` : JSON.parse(await readFile(meta, 'utf8')).title;
    const file = path.join(audioDir, `${id}.mp3`);
    if (!existsSync(file)) fail(`音源ファイルがありません: ${file}`);
    const head = (await readFile(file)).subarray(0, 3);
    const isMp3 = head.toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    if (!isMp3) fail(`MP3ではないようです: ${file}`);
    songs.push({ id, title, file: `audio/${id}.mp3`, size: (await stat(file)).size, type: 'audio/mpeg', cover: test ? '' : `${SITE}assets/covers/${id}-640.jpg` });
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'audio'), { recursive: true });
  for (const s of songs) await copyFile(path.join(audioDir, `${s.id}.mp3`), path.join(out, s.file));
  await writeFile(path.join(out, 'catalog.json'), JSON.stringify({ updated: new Date().toISOString(), songs }, null, 2) + '\n');
  console.log(`${songs.length} 曲を登録用にまとめました → ${out}`);
  for (const s of songs) console.log(`  ${s.id}  ${s.title}  ${(s.size / 1048576).toFixed(1)}MB`);
  console.log(`合計 ${(songs.reduce((n, s) => n + s.size, 0) / 1073741824).toFixed(2)}GB（R2無料枠 10GB）`);
  return { out, songs };
}

function wrangler(args) {
  const bin = path.join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(bin)) fail('wrangler が未導入です（private/worker で npm install を実行）。');
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: workerDir, stdio: 'inherit' });
  if (r.status !== 0) fail(`wrangler ${args.slice(0, 3).join(' ')} が失敗しました。`);
}

async function upload() {
  const dry = rest.includes('--dry-run');
  const { out, songs } = await build();
  const stateFile = path.join(root, 'private', '.r2-state.json');
  const sent = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, 'utf8')) : {};
  const now = {};
  for (const s of songs) now[s.file] = await sha256(path.join(out, s.file));
  const toSend = songs.filter(s => sent[s.file] !== now[s.file]);
  const toDelete = Object.keys(sent).filter(k => k.startsWith('audio/') && !(k in now));
  console.log(`送信: ${toSend.length} 曲 / 変更なし: ${songs.length - toSend.length} 曲 / R2から外す: ${toDelete.length} 曲`);
  for (const s of toSend) console.log(`  送信 ${s.file}`);
  for (const k of toDelete) console.log(`  外す ${k}`);
  if (dry) { console.log('（--dry-run のため送信していません）'); return; }
  const save = () => writeFile(stateFile, JSON.stringify(sent, null, 2) + '\n');
  // Audio first, then the song list, then removals: the library never lists a file that is not there yet.
  for (const s of toSend) {
    wrangler(['r2', 'object', 'put', `${BUCKET}/${s.file}`, '--file', path.join(out, s.file), '--content-type', 'audio/mpeg', '--remote']);
    sent[s.file] = now[s.file]; await save();
  }
  wrangler(['r2', 'object', 'put', `${BUCKET}/catalog.json`, '--file', path.join(out, 'catalog.json'), '--content-type', 'application/json', '--remote']);
  for (const k of toDelete) {
    wrangler(['r2', 'object', 'delete', `${BUCKET}/${k}`, '--remote']);
    delete sent[k]; await save();
  }
  console.log('R2 への反映が完了しました。原本は PIP POPPER PRIVATE音源 フォルダーにあります。');
}

if (command === 'assets') {
  const dest = path.join(workerDir, 'public', 'assets');
  await mkdir(dest, { recursive: true });
  for (const f of ['site.css', 'stage.jpg']) await copyFile(path.join(root, 'src', f), path.join(dest, f));
  console.log('site.css / stage.jpg を Worker 用にコピーしました。');
} else if (command === 'build') {
  await build();
} else if (command === 'upload') {
  await upload();
} else {
  console.log('使い方: node private/tools/private.mjs assets | build [--audio <フォルダー>] | upload [--dry-run]');
  process.exit(command ? 1 : 0);
}
