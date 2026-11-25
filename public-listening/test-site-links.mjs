// node public-listening/test-site-links.mjs — the official site's "▶ 試聴する" links (2026-11-25).
// Builds the site into a temporary folder (docs/ is not touched) and runs assets/listen-links.js against fake ID lists.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(os.tmpdir(), 'pp-site-links-'));
let fail = 0;
const ok = (c, name) => { console.log(`${c ? 'OK ' : 'NG '} ${name}`); if (!c) fail++; };
try {
  const b = spawnSync(process.execPath, ['build.mjs', '--out', out], { cwd: root, encoding: 'utf8' });
  ok(b.status === 0, `サイトを一時フォルダーに生成 ${b.status === 0 ? '' : b.stderr.slice(-300)}`);
  const { url } = JSON.parse(readFileSync(path.join(root, 'content', 'public-listening.json'), 'utf8'));
  const ids = readdirSync(path.join(root, 'tracks'), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  const privateAudio = new Set(ids.filter(id => JSON.parse(readFileSync(path.join(root, 'tracks', id, 'track.json'), 'utf8')).audioRelease === 'private'));
  const home = readFileSync(path.join(out, 'index.html'), 'utf8');
  const linksIn = html => [...html.matchAll(/<a class="[^"]*\b(?:work-trial|listen-trial)\b[^"]*" data-listen-id="([^"]+)" href="([^"]+)"[^>]*>/g)].map(m => ({ id: m[1], href: m[2].replaceAll('&amp;', '&'), hidden: / hidden>$/.test(m[0]) }));

  console.log('1. 生成されたページ');
  const homeLinks = linksIn(home);
  ok(homeLinks.length === ids.length - privateAudio.size, `楽曲一覧：音源非公開以外の曲に1つずつ（${homeLinks.length}件）`);
  ok(homeLinks.every(l => !privateAudio.has(l.id)) && [...privateAudio].every(id => !home.includes(`data-listen-id="${id}"`)), '音源非公開の曲にはリンクを作らない');
  ok(homeLinks.every(l => l.hidden), '最初はすべて非表示（公開中かどうかを確かめてから出す）');
  ok(homeLinks.every(l => l.href === `${url}#song-${l.id}`), '行き先は一般視聴ページのその曲（#song-<曲ID>）');
  ok(home.includes(`assets/listen-links.js" data-src="${new URL('available.json', url).href}"`), '公開中の曲ID一覧の取得先は一般視聴（/listen/available.json）');
  let pages = 0, pageOk = true;
  for (const id of ids) {
    const l = linksIn(readFileSync(path.join(out, 'tracks', id, 'index.html'), 'utf8'));
    pages++;
    if (privateAudio.has(id) ? l.length !== 0 : !(l.length === 1 && l[0].id === id && l[0].hidden)) pageOk = false;
  }
  ok(pageOk, `各曲の紹介ページ：その曲だけのリンク（非表示で用意、音源非公開の曲はなし）${pages}ページ`);

  console.log('2. 表示の切り替え（listen-links.js）');
  const script = readFileSync(path.join(out, 'assets', 'listen-links.js'), 'utf8');
  const run = async fetchImpl => {
    const links = homeLinks.map(l => ({ hidden: true, dataset: { listenId: l.id } }));
    const document = { currentScript: { dataset: { src: 'https://example.invalid/listen/available.json' } }, querySelectorAll: () => links };
    const window = { fetch: fetchImpl, AbortController };
    vm.runInNewContext(script, { document, window, fetch: fetchImpl, AbortController, setTimeout, clearTimeout, Set, Array, Promise, String, Error });
    await new Promise(r => setTimeout(r, 30));
    return links.filter(l => !l.hidden).map(l => l.dataset.listenId).sort();
  };
  const json = (body, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });
  const [a, b2] = homeLinks.map(l => l.id);
  ok((await run(json({ version: 1, ids: [a] }))).join() === a, '公開中の曲だけ「試聴する」を表示');
  ok((await run(json({ version: 1, ids: [a, b2] }))).join() === [a, b2].sort().join(), '一般視聴に曲を公開すると自動で表示が増える');
  ok((await run(json({ version: 1, ids: [] }))).length === 0, '掲載を停止・削除すると自動で非表示');
  if (privateAudio.size) ok((await run(json({ version: 1, ids: [...privateAudio] }))).length === 0, '一覧に音源非公開の曲IDが来ても表示しない（リンク自体がない）');
  ok((await run(json({ version: 1, ids: ['Manner', a.toUpperCase(), `${a} `, ''] }))).length === 0, 'IDが完全に一致しないもの（曲名・大文字・空白付き）は表示しない');
  ok((await run(async () => { throw new TypeError('network'); })).length === 0, '通信できないときは表示しない');
  ok((await run(json({ version: 1, ids: [a] }, 503))).length === 0, '一般視聴がエラー（503）のときは表示しない');
  ok((await run(json('{"version":1,"ids":"' + a + '"}'))).length === 0 && (await run(json({ version: 2, ids: [a] }))).length === 0, '形式が違う応答では表示しない');
  ok((await run(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }))).length === 0, 'JSONとして読めない応答では表示しない');
} finally { rmSync(out, { recursive: true, force: true }); }
console.log(fail ? `不合格 ${fail}` : 'すべて合格');
process.exitCode = fail ? 1 : 0;
