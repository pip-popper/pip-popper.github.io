// 一般視聴（/listen/）の公開データを、Producer が承認した曲だけで作る道具（2026-11-24、Claude Code）。
//
//   node public-listening/stage.mjs prepare <承認ファイル> [--source-dir <フォルダー>]   … ローカルに公開候補を作る（本番に触れない）
//   node public-listening/stage.mjs verify  <公開候補フォルダー>                        … 模擬環境の /listen/ で表示・再生・遮断を確認
//   node public-listening/stage.mjs upload  <公開候補フォルダー> --approved              … 本番R2へ書き込む（Producer承認後のみ）
//   node public-listening/stage.mjs rollback <公開候補フォルダー> --approved             … 書き込み前の公開カタログに戻す
//
// 承認ファイル（Git対象外の .manager/public-listening/approvals.json などに置く）：
//   { "approvedBy": "Producer", "approvedAt": "2026-11-24", "songs": [ { "id": "manner", "lyrics": true, "jacket": true, "impression": false } ] }
// 対象にできるのは「公式サイトですでに公開している曲」だけ（docs/works.json にあり、音源非公開の曲ではない）。
// 歌詞・ジャケット・AIの感想は公式サイトで公開済みのものを、承認した項目だけ載せる。音源は PRIVATE の R2 から
// 読み取って公開用の場所（public-audio/）へ複製する（PRIVATE の音源・曲目は変更しない）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedSongs } from './worker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = path.join(ROOT, 'private', 'worker');
const BUCKET = 'pip-popper-private-audio';
const sha = b => createHash('sha256').update(b).digest('hex');
const die = m => { console.error(`中止：${m}`); process.exit(1); };
function wrangler(args) {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: WORKER_DIR, encoding: 'utf8', shell: true, windowsHide: true, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const r2get = (key, file) => wrangler(['r2', 'object', 'get', `"${BUCKET}/${key}"`, '--remote', '--file', `"${file}"`]);
const r2put = (key, file, type) => wrangler(['r2', 'object', 'put', `"${BUCKET}/${key}"`, '--remote', '--file', `"${file}"`, '--content-type', type]);

async function prepare(approvalFile, sourceDir) {
  const approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
  if (approval.approvedBy !== 'Producer' || !/^\d{4}-\d{2}-\d{2}$/.test(approval.approvedAt ?? '') || !Array.isArray(approval.songs) || !approval.songs.length) die('承認ファイルの形式（approvedBy・approvedAt・songs）を確認してください。');
  const published = new Set(JSON.parse(readFileSync(path.join(ROOT, 'docs', 'works.json'), 'utf8')).map(s => s.id));
  const out = path.join(ROOT, '.manager', 'public-listening', `stage-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(path.join(out, 'public-audio'), { recursive: true }); mkdirSync(path.join(out, 'public-jackets'), { recursive: true });
  let privateCatalog = null;
  if (!sourceDir) {
    const f = path.join(out, 'private-catalog-readonly.json');
    if (!r2get('catalog.json', f).ok) die('PRIVATEの曲目を読み取れませんでした。');
    privateCatalog = JSON.parse(readFileSync(f, 'utf8'));
    rmSync(f);
  }
  const songs = [], seen = new Set();
  for (const a of approval.songs) {
    const id = a?.id;
    if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) die(`曲IDを確認してください：${id}`);
    seen.add(id);
    if (!published.has(id)) die(`${id} は公式サイトでまだ公開していない曲です（一般視聴は公開済みの曲だけ）。`);
    const track = JSON.parse(readFileSync(path.join(ROOT, 'tracks', id, 'track.json'), 'utf8'));
    if (track.audioRelease === 'private') die(`${id} は「音源非公開」の曲です。`);
    const audioFile = path.join(out, 'public-audio', `${id}.mp3`);
    if (sourceDir) copyFileSync(path.join(sourceDir, `${id}.mp3`), audioFile);
    else {
      const p = privateCatalog.songs.find(s => s.id === id);
      if (!p || !/\.mp3$/.test(p.file ?? '')) die(`${id} の音源がPRIVATEにありません（MP3のみ対応）。`);
      if (!r2get(p.file, audioFile).ok) die(`${id} の音源を読み取れませんでした。`);
      if (p.sha256 && sha(readFileSync(audioFile)) !== p.sha256) die(`${id} の音源の指紋が曲目と一致しません。`);
    }
    const bytes = readFileSync(audioFile);
    if (bytes.length < 1000) die(`${id} の音源が小さすぎます。`);
    const row = { id, title: track.title, classification: 'general', publicAudioApproved: true, audioKey: `public-audio/${id}.mp3`, size: bytes.length, sha256: sha(bytes) };
    if (track.reading) row.reading = track.reading;
    if (a.lyrics === true) { if (!track.lyrics) die(`${id} には公開中の歌詞がありません。`); Object.assign(row, { lyricsScope: 'public', publicLyricsApproved: true, lyrics: track.lyrics }); }
    if (a.impression === true) { if (!track.aiImpression) die(`${id} には公開中のAIの感想がありません。`); Object.assign(row, { impressionScope: 'public', publicImpressionApproved: true, impression: track.aiImpression }); }
    if (a.jacket === true) { copyFileSync(path.join(ROOT, 'tracks', id, 'cover-640.jpg'), path.join(out, 'public-jackets', `${id}.jpg`)); Object.assign(row, { jacketKey: `public-jackets/${id}.jpg`, publicJacketApproved: true }); }
    songs.push(row);
  }
  const catalog = { version: 1, approvedBy: approval.approvedBy, approvedAt: approval.approvedAt, songs };
  if (approvedSongs(catalog).length !== songs.length) die('公開カタログの検査に通らない曲があります。');
  writeFileSync(path.join(out, 'public-catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  const list = [];
  for (const dir of ['public-audio', 'public-jackets']) for (const f of readdirSync(path.join(out, dir))) list.push(`${sha(readFileSync(path.join(out, dir, f)))}  ${dir}/${f}`);
  list.push(`${sha(readFileSync(path.join(out, 'public-catalog.json')))}  public-catalog.json`);
  writeFileSync(path.join(out, 'SHA256SUMS.txt'), list.join('\n') + '\n');
  console.log(`公開候補を作りました：${out}\n曲：${songs.map(s => `${s.title}（${s.id}${s.lyrics ? '・歌詞' : ''}${s.jacketKey ? '・ジャケット' : ''}${s.impression ? '・感想' : ''}）`).join('、')}\n本番には書き込んでいません。`);
}

async function verify(stage) {
  const { mockEnv } = await import('../private/dev/mock-env.mjs');
  const worker = (await import('../private/worker/src/index.js')).default;
  const catalog = JSON.parse(readFileSync(path.join(stage, 'public-catalog.json'), 'utf8'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pp-listen-verify-'));
  try {
    const env = mockEnv({ r2Dir: tmp, publicDir: path.join(WORKER_DIR, 'public'), vars: { PRIVATE_PASSWORD: 'x'.repeat(12), SESSION_KEY: 'k'.repeat(48), ADMIN_PASSWORD: 'y'.repeat(12) } });
    const raw = env.BUCKET.get.bind(env.BUCKET);
    env.BUCKET.get = async (k, o) => { const x = await raw(k, o); if (x && k.endsWith('.jpg')) x.httpMetadata = { contentType: 'image/jpeg' }; return x; };
    await env.BUCKET.put('public-catalog.json', readFileSync(path.join(stage, 'public-catalog.json')));
    for (const s of catalog.songs) {
      await env.BUCKET.put(s.audioKey, readFileSync(path.join(stage, s.audioKey)));
      if (s.jacketKey) await env.BUCKET.put(s.jacketKey, readFileSync(path.join(stage, s.jacketKey)));
    }
    const get = (p, h = {}) => worker.fetch(new Request('https://pip-popper-private.pip-popper-private.workers.dev' + p, { headers: h }), env);
    const page = await (await get('/listen/')).text();
    let bad = 0;
    const check = (c, m) => { console.log(`${c ? 'OK ' : 'NG '} ${m}`); if (!c) bad++; };
    check((page.match(/class="pv-item"/g) || []).length === catalog.songs.length, `一般視聴ページに ${catalog.songs.length} 曲`);
    for (const s of catalog.songs) {
      check((await get(`/listen/audio/${s.id}.mp3`, { Range: 'bytes=0-99' })).status === 206, `${s.title}：再生できる`);
      if (s.jacketKey) check((await get(`/listen/jacket/${s.id}`)).status === 200, `${s.title}：ジャケット`);
      check(!s.lyrics || page.includes(s.lyrics.split('\n')[0].replace(/&/g, '&amp;').replace(/</g, '&lt;')), `${s.title}：歌詞${s.lyrics ? 'あり' : 'なし'}`);
    }
    check((await get('/listen/catalog.json')).status === 404 && (await get('/audio/' + catalog.songs[0].id)).status === 401, 'PRIVATEの曲目・音源には届かない');
    console.log(bad ? `不合格 ${bad}` : '確認合格（模擬環境）');
    process.exitCode = bad ? 1 : 0;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function upload(stage) {
  const catalog = JSON.parse(readFileSync(path.join(stage, 'public-catalog.json'), 'utf8'));
  // keep what is live now, so it can be put back
  const backup = path.join(stage, 'backup-public-catalog.json');
  if (!existsSync(backup)) { const r = r2get('public-catalog.json', backup); if (!r.ok) writeFileSync(backup, JSON.stringify({ version: 1, songs: [] }) + '\n'); }
  for (const s of catalog.songs) {
    if (!r2put(s.audioKey, path.join(stage, s.audioKey), 'audio/mpeg').ok) die(`${s.id} の音源を書き込めませんでした（公開カタログは未更新）。`);
    if (s.jacketKey && !r2put(s.jacketKey, path.join(stage, s.jacketKey), 'image/jpeg').ok) die(`${s.id} のジャケットを書き込めませんでした（公開カタログは未更新）。`);
  }
  // the catalog goes last: until it is written, nothing new is visible
  if (!r2put('public-catalog.json', path.join(stage, 'public-catalog.json'), 'application/json').ok) die('公開カタログを書き込めませんでした。');
  console.log(`本番に反映しました（${catalog.songs.length} 曲）。戻すとき：node public-listening/stage.mjs rollback "${stage}" --approved`);
}
function rollback(stage) {
  const backup = path.join(stage, 'backup-public-catalog.json');
  if (!existsSync(backup)) die('このフォルダーには書き込み前の控えがありません。');
  if (!r2put('public-catalog.json', backup, 'application/json').ok) die('戻せませんでした。');
  console.log('公開カタログを書き込み前に戻しました（公開用の音源ファイルは残るが、カタログにない曲は表示・再生されない）。');
}

const [cmd, target, ...rest] = process.argv.slice(2);
const flag = n => rest.includes(n), opt = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd === 'prepare' && target) await prepare(target, opt('--source-dir'));
else if (cmd === 'verify' && target) await verify(target);
else if (cmd === 'upload' && target && flag('--approved')) upload(target);
else if (cmd === 'rollback' && target && flag('--approved')) rollback(target);
else die('使い方はファイル先頭の説明を見てください（本番への書き込みは --approved が必要）。');
