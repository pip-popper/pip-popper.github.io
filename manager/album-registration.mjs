// Album registration (2026-11-24, Claude Code). Same model as the song registration (song-registration.mjs):
// a non-public draft with saved versions under .manager/album-registrations/<ID>/ (Git-ignored), restore from
// history, logical delete (deleted.json, restorable), and "adopt" which the server turns into an albums.json entry.
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, copyFile, rm, access } from 'node:fs/promises';
import { images } from './song-registration.mjs';

const ID = /^album-[a-f0-9]{24}$/, REV = /^[a-f0-9-]{36}$/;
export const ALBUM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const states = ['draft', 'ready'], sections = ['history', 'other'];
const dir = root => path.join(root, '.manager', 'album-registrations');
const file = (root, id, ...parts) => { if (!ID.test(id)) throw new Error('アルバムIDが正しくありません。'); return path.join(dir(root), id, ...parts); };
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
const exists = f => access(f).then(() => true, () => false);
const problem = (status, error) => ({ status, body: { error } });
const ok = body => ({ status: 200, body });
const str = (v, max, name, required = false) => { if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw new Error(`${name}を確認してください。`); return v; };

async function fields(root, d) {
  if (!d || typeof d !== 'object') throw new Error('登録内容を確認してください。');
  if (!sections.includes(d.section) || !states.includes(d.state)) throw new Error('掲載ページ・登録状態を確認してください。');
  if (!Array.isArray(d.tracks) || d.tracks.length > 100) throw new Error('収録曲を確認してください（100曲まで）。');
  const tracks = [];
  for (const t of d.tracks) {
    const title = str(t?.title, 150, '収録曲の曲名', true).trim();
    const music = typeof t?.music === 'string' && t.music ? t.music : null;
    if (music && (!/^[a-z0-9-]+$/.test(music) || !await exists(path.join(root, 'tracks', music, 'track.json')))) throw new Error(`公式サイトの曲「${music}」が見つかりません。`);
    tracks.push(music ? { title, music } : { title });
  }
  if (!Array.isArray(d.urls) || d.urls.length > 10) throw new Error('配信先URLを確認してください。');
  const links = d.urls.map(u => { let url; try { url = new URL(u); } catch { throw new Error('配信先URLは https:// で入力してください。'); } if (url.protocol !== 'https:' || url.username || url.password) throw new Error('配信先URLは https のみです。'); return url.href; });
  return { title: str(d.title, 150, 'アルバム名', true).trim(), subtitle: str(d.subtitle ?? '', 150, '副題').trim(), section: d.section, kind: str(d.kind ?? '', 40, '区分').trim() || 'Album',
    year: str(d.year ?? '', 20, '年').trim(), dateLabel: str(d.dateLabel ?? '', 40, '公開日').trim(), intro: str(d.intro ?? '', 20000, '紹介文'), story: str(d.story ?? '', 20000, '制作秘話'),
    tracks, links, state: d.state, memo: str(d.memo ?? '', 10000, '管理メモ') };
}
async function current(root, id) { try { const p = await readJson(file(root, id, 'current.json')); if (!REV.test(p.rev)) throw new Error('保存記録を確認できません。'); return p.rev; } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function record(root, id, rev) { if (!REV.test(rev)) throw new Error('保存版を確認してください。'); const r = await readJson(file(root, id, 'versions', rev, 'record.json')); if (r.id !== id || r.rev !== rev) throw new Error('アルバムと保存版が一致しません。'); return r; }
const thumb = async (root, r) => r.image ? `data:image/jpeg;base64,${(await readFile(file(root, r.id, 'versions', r.rev, 'cover-640.jpg'))).toString('base64')}` : null;
async function history(root, id) { const rows = []; for (const rev of await readdir(file(root, id, 'versions'))) { if (!REV.test(rev)) continue; try { const r = await record(root, id, rev); rows.push({ rev, updatedAt: r.updatedAt, title: r.title }); } catch {} } return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
async function marker(root, id, name) { try { return await readJson(file(root, id, name)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function writeMarker(root, id, name, value) { const tmp = file(root, id, `${name}-${randomUUID()}.tmp`); await writeFile(tmp, JSON.stringify(value) + '\n', { flag: 'wx' }); await rename(tmp, file(root, id, name)); }
// adopted → albums.json has it here; published → GitHub main has it (server supplies ctx.albumPublished)
async function publication(root, id, ctx) {
  const a = await marker(root, id, 'adopted.json');
  if (!a || !ALBUM_SLUG.test(a.slug)) return { state: 'not-adopted' };
  const here = ctx.albumHere ? await ctx.albumHere(a.slug) : false;
  const live = ctx.albumPublished ? await ctx.albumPublished(a.slug) : false;
  return { state: live ? 'published' : here ? 'adopted' : 'withdrawn', slug: a.slug, at: a.at };
}
export async function listAlbumRegistrations(root, ctx = {}, { deleted = false } = {}) {
  let ids; try { ids = await readdir(dir(root)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const id of ids) {
    if (!ID.test(id)) continue;
    const rev = await current(root, id); if (!rev) continue;
    const del = await marker(root, id, 'deleted.json');
    if (!!del !== deleted) continue;
    const r = await record(root, id, rev);
    rows.push({ id, rev, title: r.title, section: r.section, state: r.state, image: !!r.image, tracks: r.tracks.length, updatedAt: r.updatedAt, deletedAt: del?.at ?? null, publication: await publication(root, id, ctx) });
  }
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function get(root, id, ctx) { const rev = await current(root, id); if (!rev) return problem(404, 'アルバムの登録が見つかりません。'); const r = await record(root, id, rev); return ok({ record: r, thumbnail: await thumb(root, r), history: await history(root, id), publication: await publication(root, id, ctx), deleted: !!await marker(root, id, 'deleted.json') }); }
async function writeVersion(root, id, expected, data, source, upload, ctx) {
  const rev = randomUUID(), base = file(root, id, 'versions', rev); await mkdir(base, { recursive: true });
  let image = null;
  if (upload) { const originalName = upload.original.mime === 'image/png' ? 'original.png' : 'original.jpg'; await writeFile(path.join(base, originalName), upload.original.bytes, { flag: 'wx' }); await writeFile(path.join(base, 'cover-web.jpg'), upload.web.bytes, { flag: 'wx' }); await writeFile(path.join(base, 'cover-640.jpg'), upload.thumb.bytes, { flag: 'wx' }); image = { originalName, width: upload.original.width, height: upload.original.height }; }
  else if (source?.image) { image = source.image; for (const name of [image.originalName, 'cover-web.jpg', 'cover-640.jpg']) await copyFile(file(root, id, 'versions', source.rev, name), path.join(base, name)); }
  await writeFile(path.join(base, 'record.json'), JSON.stringify({ ...data, id, rev, image, updatedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  if (await current(root, id) !== expected) return problem(409, '別の画面で変更されています。再読み込みしてください。');
  const tmp = file(root, id, `current-${rev}.tmp`); await writeFile(tmp, JSON.stringify({ rev }), { flag: 'wx' }); await rename(tmp, file(root, id, 'current.json'));
  return get(root, id, ctx);
}
// What the server needs to add the album to albums.json (only for the current, ready, saved version)
export async function adoptionSource(root, id, rev) {
  const cur = await current(root, id);
  if (!cur || cur !== rev) return { error: problem(409, '対象アルバムの保存版が変わりました。再読み込みしてください。') };
  const r = await record(root, id, rev);
  if (r.state !== 'ready' || !r.image || !r.tracks.length) return { error: problem(400, '公式HPへ取り込めるのは「公開準備完了」で保存し、ジャケットと収録曲を登録したアルバムだけです。') };
  return { record: r, web: file(root, id, 'versions', rev, 'cover-web.jpg'), thumb: file(root, id, 'versions', rev, 'cover-640.jpg') };
}
export const markAlbumAdopted = (root, id, slug) => writeMarker(root, id, 'adopted.json', { slug, at: new Date().toISOString() });
export const albumPublication = publication;
export const albumGet = get;

export async function albumRegistrationAction(root, action, input = {}, ctx = {}) {
  try {
    if (action === 'list') return ok({ albums: await listAlbumRegistrations(root, ctx), deleted: await listAlbumRegistrations(root, ctx, { deleted: true }) });
    if (action === 'get') return await get(root, input.id, ctx);
    if (action === 'save') {
      if (input.confirm !== true) return problem(400, '保存前の確認が必要です。');
      const data = await fields(root, input.fields), upload = images(input.image);
      const id = input.id ?? `album-${randomBytes(12).toString('hex')}`; if (!ID.test(id)) return problem(400, 'アルバムIDが正しくありません。');
      const rev = await current(root, id);
      if (input.id && (!rev || input.rev !== rev)) return problem(409, '対象アルバムまたは保存版が変わりました。再読み込みしてください。');
      if (!input.id && rev) return problem(409, '新しいアルバムIDを作れませんでした。');
      if (input.id && await marker(root, id, 'deleted.json')) return problem(409, '削除済みのアルバムです。先に復元してください。');
      const old = rev ? await record(root, id, rev) : null;
      if (rev && data.state !== 'ready' && ['adopted', 'published'].includes((await publication(root, id, ctx)).state)) return problem(409, '公式HPへ取り込み済み・公開済みのアルバムは「下書き」に戻せません（登録状態は公開準備完了のまま）。');
      if (data.state === 'ready' && ((!upload && !old?.image) || !data.tracks.length)) return problem(400, '公開準備完了にはジャケットと収録曲が必要です。');
      return await writeVersion(root, id, rev, data, old, upload, ctx);
    }
    if (action === 'restore') {
      if (input.confirm !== true) return problem(400, '復元前の確認が必要です。');
      const rev = await current(root, input.id); if (!rev || rev !== input.rev) return problem(409, '対象アルバムの保存版が変わりました。');
      const old = await record(root, input.id, input.restoreRev); const { id, rev: oldRev, image, updatedAt, ...data } = old;
      return await writeVersion(root, input.id, rev, data, old, null, ctx);
    }
    if (action === 'delete' || action === 'undelete') {
      if (input.confirm !== true) return problem(400, '確認が必要です。');
      if (!await current(root, input.id)) return problem(404, 'アルバムの登録が見つかりません。');
      const pub = await publication(root, input.id, ctx);
      if (action === 'delete' && ['adopted', 'published'].includes(pub.state)) return problem(409, '公式HPに取り込み済みのアルバムです。先にアルバムの編集画面で「掲載を停止」してください。');
      if (action === 'delete') await writeMarker(root, input.id, 'deleted.json', { at: new Date().toISOString() });
      else await rm(file(root, input.id, 'deleted.json'), { force: true });
      return await get(root, input.id, ctx);
    }
    return problem(404, '見つかりません。');
  } catch (e) { return problem(e.code ? 500 : 400, e.code ? '保存・読込みを完了できませんでした。以前の保存内容を保持しています。' : (e.message || '登録内容を確認してください。')); }
}
