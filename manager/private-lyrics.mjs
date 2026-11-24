// PRIVATE lyrics transport. The administrator credential is used for one request
// cycle only; no local file, logs, browser storage or Cloudflare API token.
export async function privateLyricsCall(base, body, save = false, request = fetch) {
  const password = body?.adminPassword;
  const error = (status, message) => ({ status, body: { error: message } });
  if (typeof password !== 'string' || !password || password.length > 200) return error(400, '管理者パスワードを入力してください。');
  const hasLyrics = Object.hasOwn(body, 'lyrics'), hasReading = Object.hasOwn(body, 'reading');
  if (save && (!/^[a-z0-9-]+$/.test(body.id ?? '') || !Number.isSafeInteger(body.rev) || body.rev < 0 || (!hasLyrics && !hasReading) || (hasLyrics && (typeof body.lyrics !== 'string' || body.lyrics.length > 100000)) || (hasReading && (typeof body.reading !== 'string' || body.reading.length > 100)) || body.confirm !== true))
    return error(400, '曲・歌詞・確認内容を確認してください。');
  let cookie;
  try {
    const login = await request(new URL('admin/login', base), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
    if (login.status === 401) return error(403, '管理者パスワードが違います。');
    if (login.status === 429) return error(429, '一時的にロックされています。しばらく時間をおいてください。');
    cookie = login.status === 303 ? (login.headers.getSetCookie?.() ?? []).map(v => v.split(';')[0]).find(v => /^pp_admin=.+/.test(v)) : null;
    if (!cookie) return error(502, 'PRIVATE管理画面に接続できませんでした。');
    const route = save ? `songs/${body.id}/lyrics` : 'lyrics';
    const response = await request(new URL(`admin/api/${route}`, base), { method: save ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Cookie: cookie, 'X-PP-Admin': '1', ...(save ? { 'Content-Type': 'application/json' } : {}) },
      ...(save ? { body: JSON.stringify({ id: body.id, rev: body.rev, ...(hasLyrics ? {lyrics:body.lyrics} : {}), ...(hasReading ? {reading:body.reading} : {}), confirm: true }) } : {}) });
    let data; try { data = await response.json(); } catch { return error(502, 'PRIVATEの応答を読み取れませんでした。'); }
    if (!response.ok) return error(response.status, response.status === 404 ? '曲が見つからないか、PRIVATE側がまだ歌詞管理に対応していません。' : data?.error ?? 'PRIVATEで処理できませんでした。');
    if (save) {
      if (data?.song?.id !== body.id || (hasLyrics && data.song.lyrics !== body.lyrics) || (hasReading && data.song.reading !== body.reading.trim()) || !Number.isSafeInteger(data.rev)) return error(502, '保存結果を確認できませんでした。再読込みして状態を確認してください。');
      return { status: 200, body: { ok: true, rev: data.rev, song: data.song, orderedIds:data.orderedIds, message: data.message } };
    }
    if (!Number.isSafeInteger(data?.rev) || !Array.isArray(data.songs)) return error(502, 'PRIVATEの曲一覧を読み取れませんでした。');
    return { status: 200, body: { rev: data.rev, songs: data.songs } };
  } catch {
    return error(502, save ? 'PRIVATEに接続できませんでした。保存結果は再読込みして確認してください。' : 'PRIVATEに接続できませんでした。');
  } finally {
    if (cookie) try { await request(new URL('admin/logout', base), { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Cookie: cookie } }); } catch {}
  }
}
