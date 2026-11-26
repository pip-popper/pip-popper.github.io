// PIP POPPER 管理ツール — 画面の動き。サーバー（manager/server.mjs）とだけ通信する。
(() => {
  'use strict';
  // the per-launch password comes in the address (#t=...) and is kept only in this tab
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash) { try { sessionStorage.setItem('ppm-token', fromHash); } catch {} history.replaceState(null, '', location.pathname); }
  let token = fromHash; try { token = token || sessionStorage.getItem('ppm-token'); } catch {}

  const $ = s => document.querySelector(s);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
  let state = null, current = null, edits = new Map(), privateLyricsDirty = false, privateLyricsBusy = false, releaseDirty = false, releaseBusy = false, registrationDirty=false, registrationBusy=false, registrationId=null;
  let clearPrivateLyricsPassword = () => {};

  async function api(method, url, body) {
    if (method === 'POST') body = body ?? {};                    // the server accepts JSON bodies only
    const r = await fetch(url, { method, headers: { 'X-PP-Token': token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error(data.error || '処理できませんでした。'), { data, status: r.status });
    return data;
  }
  function toast(msg, kind = 'ok', ms = 5000) {
    const t = el('div', { className: `toast ${kind}`, role: 'status', textContent: msg });
    document.body.append(t); setTimeout(() => t.remove(), ms);
  }
  // dialog: returns the value of the pressed button; Cancel is focused first (safe default)
  function ask(title, body, buttons) {
    const d = $('#dlg');
    $('#dlg-title').textContent = title;
    $('#dlg-body').replaceChildren(...[].concat(body));
    // 2026-11-25: the answer is taken from the button press itself. Waiting only for the dialog's "close" event
    // could leave the screen stuck when that event arrives late (e.g. a window in the background).
    return new Promise(res => {
      let done = false;
      const finish = value => { if (done) return; done = true; if (d.open) d.close(value); res(value || 'cancel'); };
      $('#dlg-actions').replaceChildren(...buttons.map(b => el('button', { type: 'button', value: b.value, textContent: b.label, className: b.primary ? 'primary' : '',
        onclick: () => finish(b.value) })));
      d.onclose = () => finish(d.returnValue || 'cancel');          // Esc key or any other way of closing = cancel
      d.oncancel = () => finish('cancel');
      d.returnValue = 'cancel';
      d.showModal();
      d.querySelector('button[value="cancel"]')?.focus();
    });
  }
  const unsaved = () => edits.size > 0 || privateLyricsDirty || releaseDirty || registrationDirty;
  async function guard() {
    if (privateLyricsBusy || releaseBusy || registrationBusy) { toast('処理が終わるまでお待ちください。', 'bad'); return false; }
    if (!unsaved()) return true;
    return (await ask('保存していない入力があります', el('p', { textContent: 'このまま移動すると、保存していない入力は消えます。' }),
      [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '入力を捨てて移動' }])) === 'go';
  }
  window.addEventListener('beforeunload', e => { if (unsaved()) { e.preventDefault(); e.returnValue = ''; } });

  async function refresh() {
    state = await api('GET', '/api/state');
    const n = state.changes.items.length;
    const s = $('#status');
    s.className = 'status' + (n || state.pendingPush ? ' dirty' : '');
    s.textContent = state.pendingPush ? `GitHubへの送信待ちが ${state.pendingPush} 件あります（「公開する」で送信をやり直せます）。`
      : n ? `公開していない変更が ${n} 件あります。` : '公開していない変更はありません。';
    if (state.changes.other.length) s.textContent += `（管理ツール以外の変更 ${state.changes.other.length} 件があるため、今は公開できません）`;
    if (state.otherUnpushed) { s.className = 'status dirty'; s.textContent += `（AI等の作業でまだ公開していない保存点が ${state.otherUnpushed} 件あるため、今は公開できません。保存・プレビュー・破棄は使えます）`; }
    $('#btn-publish').disabled = !(n || state.pendingPush);
    $('#btn-discard').disabled = !n;
    applyPages();
    renderLists();
  }
  // 2026-11-26: whether GitHub Pages delivered what was sent (a GitHub-side failure used to go unnoticed)
  let pages = null, pagesTimer = null;
  async function checkPages(round = 1) {
    clearTimeout(pagesTimer);
    try { pages = await api('GET', '/api/pages-status'); } catch { pages = null; }
    applyPages(round);
    // still being delivered: look again every 30 seconds, for up to about 6 minutes
    if (pages && ['waiting', 'running'].includes(pages.state) && round < 12) pagesTimer = setTimeout(() => checkPages(round + 1), 30000);
  }
  function applyPages(round = 0) {
    const s = $('#status'), failed = pages?.state === 'failed';
    $('#btn-redeploy').hidden = !failed;
    s.querySelector('.pages-note')?.remove();
    if (failed) {
      s.className = 'status dirty';
      s.append(el('span', { className: 'pages-note err', textContent: '　公式サイトに未反映（GitHub側の配信失敗）→「公式サイトへ送り直す」' }));
    } else if (round && round < 12 && pages && ['waiting', 'running'].includes(pages.state)) s.append(el('span', { className: 'pages-note', textContent: '　（公式サイトへ配信中…）' }));
  }
  // 2026-11-24: the side bar = 管理メニュー (always visible) + 曲・アルバム・ページの一覧 (folded, scrolls on its own)
  const openGroups = new Set();
  // on a narrow screen the side bar is above the work area: bring the opened screen into view
  const showMainOnPhone = () => { if (window.matchMedia?.('(max-width: 800px)').matches) $('#main').scrollIntoView?.({ block: 'start' }); };
  function renderMenu() {
    const regs = state.registrations ?? [], albums = state.albumRegistrations ?? [], deleted = (state.deletedRegistrations ?? []).length + (state.archived ?? []).length;
    const item = (icon, label, action, current, extra = '') => el('li', {}, el('button', { type: 'button', className: 'menu-btn', ariaCurrent: String(!!current), onclick: async () => { await action(); showMainOnPhone(); } },
      el('span', { className: 'menu-ic', ariaHidden: 'true', textContent: icon }), el('span', { className: 'menu-label', textContent: label }), extra ? el('span', { className: 'menu-count', textContent: extra }) : ''));
    $('#menu').replaceChildren(el('h2', { textContent: '管理メニュー' }), el('ul', {},
      item('＋', '新曲を登録', () => openRegistration(), privateOpen === 'registration' && !registrationId),
      item('＋', 'アルバムを登録', () => openAlbumRegistration(), privateOpen === 'album' && !albumRegId),
      item('✎', '下書き・登録中の曲とアルバム', openDrafts, privateOpen === 'drafts' || (privateOpen === 'registration' && registrationId) || (privateOpen === 'album' && albumRegId), String([...regs, ...albums].filter(r => r.publication?.state !== 'published').length)),
      item('◎', '楽曲の公開状況', openReleaseStatus, privateOpen === 'release'),
      item('▶', '一般視聴の管理', openListen, privateOpen === 'listen'),
      item('♪', 'PRIVATE音源の登録・管理 ↗', openPrivateAudio, false),
      item('✍', 'PRIVATE歌詞・よみがな', openPrivateLyrics, privateOpen === 'lyrics'),
      item('🔑', 'PRIVATEパスワード', openPrivate, privateOpen === 'password'),
      item('↺', '公開履歴・取り消し', () => $('#btn-history').click(), false),
      ...(deleted ? [item('♻', '削除済み・一覧から外したもの', openDeleted, privateOpen === 'deleted', String(deleted))] : [])));
  }
  function renderLists() {
    renderMenu();
    const q = $('#filter').value.trim().toLowerCase();
    const changedFiles = new Set(state.changes.files);
    const mark = it => {
      if (it.type === 'track') return changedFiles.has(`tracks/${it.id}/track.json`);
      if (it.type === 'site') return changedFiles.has('content/site.json');
      return state.changes.items.some(c => c.item === `アルバム『${it.title}』`);
    };
    const group = (key, title, items) => {
      const shown = items.filter(it => !q || `${it.title} ${it.id}`.toLowerCase().includes(q));
      if (!shown.length) return [];
      const holdsCurrent = !!current && shown.some(it => current.type === it.type && current.id === it.id);
      const d = el('details', { className: 'side-group', open: !!q || holdsCurrent || openGroups.has(key) },
        el('summary', {}, el('span', { textContent: title }), el('span', { className: 'menu-count', textContent: String(shown.length) })),
        el('ul', {}, ...shown.map(it => el('li', {}, el('button', {
          type: 'button', ariaCurrent: String(!!current && current.type === it.type && current.id === it.id),
          onclick: async () => { await openItem(it.type, it.id); showMainOnPhone(); },
        }, el('span', { textContent: `${mark(it) ? '● ' : ''}${it.title}${it.hidden ? '（掲載停止中）' : ''}` }), el('span', { className: 'yr', textContent: it.year ?? '' }))))));
      d.addEventListener('toggle', () => { if (!q) d.open ? openGroups.add(key) : openGroups.delete(key); });
      return [d];
    };
    $('#lists').replaceChildren(el('h2', { textContent: '曲・アルバム・ページの一覧（選んで編集）' }),
      ...group('tracks', '楽曲', state.list.tracks), ...group('history', 'HISTORY（アルバム）', state.list.history),
      ...group('other', 'その他の作品', state.list.other), ...group('site', 'サイトの文言', state.list.site),
      ...(q ? [] : [el('details', { className: 'side-group fixed-group', open: openGroups.has('fixed') }, el('summary', {}, el('span', { textContent: '固定（変更はAIに依頼）' })),
        el('ul', { className: 'fixed' }, ...FIXED.map(([t, why]) => el('li', { title: why }, el('span', { textContent: t }), el('small', { textContent: why })))))]));
  }
  // PRIVATE audio is managed on the PRIVATE admin screen (web, administrator password); the manager only opens it
  function openPrivateAudio() {
    const url = new URL('admin', state?.privateUrl ?? 'https://pip-popper-private.pip-popper-private.workers.dev/').href;
    window.open(url, '_blank', 'noopener');
    toast('PRIVATEの管理画面を別のタブで開きました（音源の追加・差し替え・並べ替え。管理者パスワードで入ります）。');
  }
  // 2026-11-24: read the state again and show the open screen with fresh data. Typed, unsaved input is never thrown
  // away: then only the lists, menu and status are refreshed and the open screen is left as it is.
  async function reloadScreen() {
    if (unsaved()) { await refresh(); return false; }
    const item = current ? { type: current.type, id: current.id } : null, where = privateOpen, rid = registrationId, aid = albumRegId;
    await refresh();
    try {
      if (item) { edits = new Map(); await openItem(item.type, item.id); }
      else if (where === 'registration') await openRegistration(rid);
      else if (where === 'album') await openAlbumRegistration(aid);
      else if (where === 'drafts') await openDrafts();
      else if (where === 'release') await openReleaseStatus();
      else if (where === 'deleted') await openDeleted();
      else if (where === 'listen') await openListen();
    } catch {}
    return true;
  }
  $('#btn-reload').onclick = async () => {
    if (privateLyricsBusy || releaseBusy || registrationBusy) return toast('処理が終わるまでお待ちください。', 'bad');
    if (unsaved()) {
      const ans = await ask('保存していない入力があります', el('p', { textContent: '入力中の内容はそのまま残し、左の一覧・件数・公開状況だけを最新にします（開いている画面は読み直しません）。' }),
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '一覧だけ更新', primary: true }]);
      if (ans !== 'go') return;
    }
    const b = $('#btn-reload'); b.disabled = true;
    try { await api('POST', '/api/fetch-status', {}); } catch {}   // GitHub's latest published state (read only)
    try { const full = await reloadScreen(); toast(full ? '最新の状態にしました。' : '一覧と公開状況を最新にしました（入力中の内容はそのままです）。'); }
    catch (e) { toast(e.message, 'bad'); } finally { b.disabled = false; }
  };
  const isPublished = r => r.publication?.state === 'published';


  // ── 2026-11-25: 一般視聴の管理 (public listening). Works through the PRIVATE Worker's admin API; the
  // administrator password stays only in this screen's field and is cleared when the screen is left. ──
  async function openListen() {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'listen'; privateLyricsDirty = releaseDirty = registrationDirty = false; renderLists();
    const pw = el('input', { type: 'password', id: 'ls-password', autocomplete: 'off', spellcheck: false });
    clearPrivateLyricsPassword = () => { pw.value = ''; };
    const status = el('p', { role: 'status', ariaLive: 'polite', className: 'note' }), show = (m, k = 'note') => { status.textContent = m; status.className = k; };
    const listBox = el('div', {}), detail = el('section', { className: 'listen-detail' });
    let data = null, selected = null, busy = false, pending = null, previewUrl = null;
    const stLabel = { draft: '未公開（下書き）', published: '公開中', stopped: '掲載停止中', removed: '一覧から外した' };
    const mb = n => `${(n / 1048576).toFixed(1)}MB`, sec = s => s ? `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒` : '不明';
    const items = v => v ? ['歌詞', 'ジャケット', 'AIの感想'].filter((_, i) => v.items[['lyrics', 'jacket', 'impression'][i]]).join('・') || 'なし（曲名と音源だけ）' : '';
    const ver = v => v ? `${v.source === 'private' ? 'PRIVATEからコピー' : 'アップロード'}／${mb(v.size)}／${sec(v.duration)}／公開項目：${items(v)}` : 'なし';
    const need = () => { if (!pw.value) { show('管理者パスワードを入力してください。', 'err'); return false; } if (busy) { show('処理中です。', 'err'); return false; } return true; };
    const run = async (label, fn) => { if (!need()) return; busy = true; detail.inert = true; show(`${label}…`); try { await fn(); } catch (e) { show(e.message, 'err'); } finally { busy = false; detail.inert = false; } };
    async function load(keep) {
      data = await api('POST', '/api/listen/list', { adminPassword: pw.value });
      paintList(); if (keep && selected) paintDetail(selected); else detail.replaceChildren(el('p', { className: 'note', textContent: '左の一覧（下）から曲を選んでください。' }));
    }
    const entry = id => data?.songs.find(s => s.id === id);
    function paintList() {
      const rows = data.official.filter(o => !o.audioPrivate).map(o => ({ o, s: entry(o.id) }));
      const pub = rows.filter(r => r.s?.status === 'published').length;
      listBox.replaceChildren(el('p', { className: 'note', textContent: `公式サイトの曲 ${rows.length} 曲のうち、一般視聴で公開中 ${pub} 曲。` }),
        el('ul', { className: 'changes drafts' }, ...rows.map(({ o, s }) => el('li', {}, el('button', { type: 'button', className: 'draft-open', ariaCurrent: String(selected === o.id), onclick: () => paintDetail(o.id) },
          el('span', { className: 'what', textContent: o.title }), el('span', { className: 'draft-meta', textContent: s ? `${stLabel[s.status]}${s.changed ? '（公開前の変更あり）' : ''}` : '未登録' }))))));
    }
    function paintDetail(id) {
      selected = id; paintList();
      const o = data.official.find(x => x.id === id), s = entry(id), p = data.privateSongs.find(x => x.id === id), v = s?.draft ?? s?.live;
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; } pending = null;
      const player = el('audio', { controls: true, preload: 'metadata', className: 'listen-player', hidden: true });
      const file = el('input', { type: 'file', accept: 'audio/mpeg,.mp3', id: 'ls-file' }), fileInfo = el('p', { className: 'note' });
      file.onchange = async () => {
        const f = file.files?.[0]; pending = null; if (!f) return;
        if (f.size > 50 * 1048576) return show('MP3は50MBまでです。', 'err');
        if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(f); player.src = previewUrl; player.hidden = false;
        const duration = await new Promise(r => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => r(a.duration); a.onerror = () => r(null); a.src = previewUrl; });
        if (!duration) { show('MP3として読めませんでした。', 'err'); return; }
        pending = { file: f, duration }; fileInfo.textContent = `選んだMP3：${f.name}／${mb(f.size)}／${sec(duration)}（上で試聴できます）`; show('試聴して問題なければ「この音源を登録（まだ公開しない）」を押してください。');
      };
      const upload = el('button', { type: 'button', className: 'primary', textContent: 'この音源を登録（まだ公開しない）', onclick: () => run('登録しています', async () => {
        if (!pending) throw new Error('先にMP3を選んでください。');
        if (await ask('一般視聴用の音源を登録します', [el('p', { textContent: `曲：${o.title}` }), el('p', { textContent: `MP3：${pending.file.name}／${mb(pending.file.size)}／${sec(pending.duration)}` }), el('p', { className: 'warn', textContent: 'まだ公開されません。公開中の曲なら、「公開する」を押すまで今の音源のままです。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '登録する', primary: true }]) !== 'go') return show('取りやめました。');
        const buf = await pending.file.arrayBuffer(), hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
        const res = await fetch('/api/listen/upload', { method: 'POST', body: buf, headers: { 'Content-Type': 'audio/mpeg', 'X-PP-Token': token || '', 'X-Id': id, 'X-Rev': String(data.rev), 'X-Sha256': hash, 'X-Duration': String(pending.duration), 'X-PP-Admin-Password': btoa(String.fromCharCode(...new TextEncoder().encode(pw.value))) } });
        const out = await res.json().catch(() => ({})); if (!res.ok) throw new Error(out.error ?? '登録できませんでした。');
        await load(true); show(`✔ ${out.message}`, 'done');
      }) });
      const act = (label, op, extra = {}, done) => run(label, async () => { const r = await api('POST', '/api/listen/action', { adminPassword: pw.value, id, op, rev: data.rev, ...extra }); await load(true); show(`✔ ${r.message ?? done ?? '完了しました。'}`, 'done'); });
      const copyBtn = p ? el('button', { type: 'button', textContent: 'PRIVATEの音源をコピーして使う', onclick: async () => {
        if (await ask('PRIVATEの音源をコピーします', [el('p', { textContent: `対象：${p.title}（PRIVATEの完全版／${mb(p.size)}／${sec(p.duration)}）` }), el('p', { textContent: 'PRIVATEの音源を一般視聴用に別のファイルとして複製します。PRIVATEの音源・曲目・パスワードは変わりません。' }), el('p', { className: 'warn', textContent: 'コピーしただけでは公開されません。完全版を一般公開してよいかを確認してから「公開する」を押してください。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: 'この曲をコピーする', primary: true }]) === 'go') act('コピーしています', 'copy-private', { confirm: true });
      } }) : el('p', { className: 'note', textContent: 'PRIVATEにこの曲の音源はありません。' });
      const chk = (key, label, can) => { const c = el('input', { type: 'checkbox', id: `ls-${key}`, checked: !!v?.items?.[key], disabled: !can }); return [c, el('div', { className: 'field check' }, c, el('label', { htmlFor: c.id, textContent: label + (can ? '' : '（公式サイトに登録がありません）') }))]; };
      const [cl, fl] = chk('lyrics', '歌詞を公開する', o.hasLyrics), [cj, fj] = chk('jacket', 'ジャケットを公開する', true), [ci, fi] = chk('impression', 'AIの感想を公開する', o.hasImpression);
      const saveItems = el('button', { type: 'button', textContent: '公開する項目を保存（まだ公開しない）', disabled: !v, onclick: () => act('保存しています', 'settings', { items: { lyrics: cl.checked, jacket: cj.checked, impression: ci.checked } }) });
      const listen = which => run('音源を読み込んでいます', async () => {
        const res = await fetch('/api/listen/audio', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PP-Token': token || '' }, body: JSON.stringify({ adminPassword: pw.value, id, which }) });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '読み込めませんでした。');
        if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await res.blob()); player.src = previewUrl; player.hidden = false; player.play().catch(() => {}); show(which === 'live' ? '公開中の音源を再生しています。' : '公開前（下書き）の音源を再生しています。');
      });
      const publishBtn = el('button', { type: 'button', className: 'primary', textContent: s?.status === 'published' && !s.changed ? '公開中（変更なし）' : '内容を確認して公開する', disabled: !v || (s?.status === 'published' && !s.changed), onclick: async () => {
        const w = s.draft ?? s.live;
        if (await ask('一般視聴に公開します', [el('p', { textContent: `曲名：${s.title}` }), el('p', { textContent: `MP3：${ver(w)}` }), el('p', { textContent: `公開する項目：${items(w)}` }), el('p', { className: 'warn', textContent: '公開すると、公式サイトの「LISTEN｜音楽を聴く」から誰でも聴けるようになります。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '公開する', primary: true }]) === 'go') act('公開しています', 'publish', { confirm: true });
      } });
      const stopBtn = s?.status === 'published' ? el('button', { type: 'button', textContent: '掲載を停止する', onclick: async () => { if (await ask('一般視聴の掲載を停止します', el('p', { textContent: `「${s.title}」を一般視聴から外します（音源・設定は残り、「掲載を再開する」で戻せます）。` }), [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '停止する', primary: true }]) === 'go') act('停止しています', 'stop'); } })
        : s?.status === 'stopped' ? el('button', { type: 'button', textContent: '掲載を再開する', onclick: () => act('再開しています', 'resume') }) : '';
      const hist = el('select', { id: 'ls-history' }, ...(s?.history ?? []).map((h, i) => el('option', { value: String(i), textContent: `${new Date(h.at).toLocaleString('ja-JP')}　${ver(h)}` })));
      const restoreBtn = el('button', { type: 'button', textContent: 'この版を下書きに戻す', disabled: !s?.history?.length, onclick: () => act('戻しています', 'restore', { index: Number(hist.value) }) });
      const removeBtn = s && s.status !== 'removed' && s.status !== 'published' ? el('button', { type: 'button', textContent: '一般視聴の一覧から外す', onclick: async () => { if (await ask('一般視聴の一覧から外します', el('p', { textContent: '音源・設定・履歴は残り、「一覧に戻す」で戻せます。' }), [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '外す', primary: true }]) === 'go') act('外しています', 'remove', { confirm: true }); } })
        : s?.status === 'removed' ? el('button', { type: 'button', textContent: '一覧に戻す', onclick: () => act('戻しています', 'undelete') }) : '';
      detail.replaceChildren(el('h3', { textContent: o.title }),
        el('p', { className: 'note', textContent: `状態：${s ? stLabel[s.status] : '未登録'}${s?.changed ? '（公開前の変更あり）' : ''}` }),
        el('p', { className: 'note', textContent: `公開中の版：${ver(s?.live)}` }), ...(s?.changed ? [el('p', { className: 'note', textContent: `公開前の版：${ver(s.draft)}` })] : []),
        el('div', { className: 'registration-actions' }, ...(s?.live ? [el('button', { type: 'button', textContent: '公開中の音源を試聴', onclick: () => listen('live') })] : []), ...(s?.draft ? [el('button', { type: 'button', textContent: '公開前の音源を試聴', onclick: () => listen('draft') })] : [])), player,
        el('h3', { textContent: '1. 一般視聴用のMP3（短縮版・編集版も可）' }), el('div', { className: 'field' }, el('label', { htmlFor: 'ls-file', textContent: 'MP3を選ぶ（50MBまで。選ぶと試聴できます）' }), file), fileInfo, el('div', { className: 'registration-actions' }, upload, copyBtn),
        el('h3', { textContent: '2. 公開する項目（公式サイトの内容を使います）' }), fl, fj, fi, el('div', { className: 'registration-actions' }, saveItems),
        el('h3', { textContent: '3. 公開・停止' }), el('div', { className: 'registration-actions' }, publishBtn, stopBtn, removeBtn),
        el('h3', { textContent: '以前の版に戻す' }), el('div', { className: 'registration-actions' }, hist, restoreBtn));
      $('#main').querySelector('.listen-detail')?.scrollIntoView?.({ block: 'start' });
    }
    const pageUrl = new URL('listen/', state?.privateUrl ?? 'https://pip-popper-private.pip-popper-private.workers.dev/').href;
    $('#main').replaceChildren(el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: '管理メニュー' }), '一般視聴の管理')),
      el('p', { className: 'note', textContent: '公式サイトの曲に、誰でも聴ける一般視聴用のMP3を付けます（PRIVATEの完全版とは別に、短縮版・編集版も登録できます）。登録・保存だけでは公開されず、「公開する」を押したときだけ公開されます。' }),
      el('p', { className: 'note' }, '一般視聴ページ：', el('a', { href: pageUrl, target: '_blank', rel: 'noopener', textContent: pageUrl })),
      el('div', { className: 'field' }, el('label', { htmlFor: 'ls-password', textContent: '管理者パスワード（PRIVATEの管理画面のもの。この画面を離れると消えます）' }), pw),
      el('div', { className: 'registration-actions' }, el('button', { type: 'button', className: 'primary', textContent: '読み込む', onclick: () => run('読み込んでいます', async () => { await load(true); show('✔ 読み込みました。', 'done'); }) })),
      status, el('div', { className: 'listen-layout' }, listBox, detail));
    $('#main').scrollTop = 0;
  }

  // drafts and registrations of new songs and albums, in one place
  async function openDrafts() {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'drafts'; renderLists();
    const pub = { 'not-adopted': '未公開', adopted: '取り込み済み・未公開', published: '公開済み', withdrawn: '取り込み取消' };
    const st = { draft: '下書き', registered: '下書き', ready: '公開準備完了' };
    const rows = (list, open, kind) => list.length ? el('ul', { className: 'changes drafts' }, ...list.map(r => el('li', {},
      el('button', { type: 'button', className: 'draft-open', onclick: () => open(r.id) }, el('span', { className: 'what', textContent: r.title }),
        el('span', { className: 'draft-meta', textContent: `${kind}／${st[r.state] ?? r.state}／${pub[r.publication?.state] ?? '未公開'}／${r.updatedAt ? new Date(r.updatedAt).toLocaleString('ja-JP') : ''}` }))))) : el('p', { className: 'note', textContent: 'ありません。' });
    const regs = state.registrations ?? [], albums = state.albumRegistrations ?? [];
    const open = (r, kind) => kind === '新曲' ? openItem('track', r.publication.slug) : openItem('album', r.publication.slug);
    const doneRows = list => list.length ? el('ul', { className: 'changes drafts' }, ...list.map(([r, kind]) => el('li', {},
      el('button', { type: 'button', className: 'draft-open', onclick: () => open(r, kind) }, el('span', { className: 'what', textContent: `${r.title}　→ 公開中の${kind === '新曲' ? '曲' : 'アルバム'}を開く` }),
        el('span', { className: 'draft-meta', textContent: `${kind}／公開済み（${kind === '新曲' ? 'tracks' : 'albums'}/${r.publication.slug}）` }))))) : el('p', { className: 'note', textContent: 'ありません。' });
    $('#main').replaceChildren(el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: '管理メニュー' }), '下書き・登録中の曲とアルバム')),
      el('p', { className: 'note', textContent: 'まだ公開していない新曲・アルバムの登録です。選ぶと登録画面が開き、続きの編集・公開準備・公式HPへの取り込みができます。公開が済むと下の「公開済み」に移ります（公開済みかどうかは実際の公式サイトの状態で自動判定）。' }),
      el('div', { className: 'registration-actions' }, el('button', { type: 'button', textContent: '＋ 新曲を登録', onclick: () => openRegistration() }), el('button', { type: 'button', textContent: '＋ アルバムを登録', onclick: () => openAlbumRegistration() })),
      el('h3', { textContent: '新曲（未公開）' }), rows(regs.filter(r => !isPublished(r)), id => openRegistration(id), '新曲'),
      el('h3', { textContent: 'アルバム（未公開）' }), rows(albums.filter(r => !isPublished(r)), id => openAlbumRegistration(id), 'アルバム'),
      el('h3', { textContent: '公開済み（ここから登録して公開したもの）' }), doneRows([...regs.filter(isPublished).map(r => [r, '新曲']), ...albums.filter(isPublished).map(r => [r, 'アルバム'])]));
    $('#main').scrollTop = 0;
  }
  // what this tool does not change: kept fixed, ask an AI (Claude Code / ChatGPT Work) when a change is really needed
  const FIXED = [
    ['ページの構成・デザイン', 'レイアウト、色、文字の大きさ、動き（演出）'],
    ['アルバムの特設デザイン', '作品ごとの世界観・背景・題字・写真。ジャケットの差し替えは編集画面から可'],
    ['メニュー・ボタン・欄の名前', '「最新楽曲」「楽曲一覧」「AIの感想」など'],
    ['メッセージの送信フォーム', '入力欄の名前・送信の仕組み'],
    ['曲の公開日・新着順', '新着順は掲載した日で自動。並び替え（あいうえお・A〜Z）は訪問者が選ぶ'],
    ['ディスク別・複数作品の構成の曲目', 'Favorite Track・SOLO WORKS など特別な構成の作品'],
    ['音源・データの完全な削除', '掲載停止・一覧から外す（復元可）まで。完全削除はAIに依頼'],
    ['上記以外のリンク・ダウンロード', 'Spotify・YouTube・Suno・Apple Music 以外の配信先、ダウンロード'],
    ['サイト全体の検索用説明文', '曲数が自動で入る文のため'],
    ['PRIVATEの音源', '曲の追加・差し替えはPRIVATEの管理画面で操作します（パスワードは上の「PRIVATE管理」）'],
  ];

  async function openItem(type, id) {
    if (!await guard()) return;
    try { current = await api('GET', `/api/item?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`); }
    catch (e) { return toast(e.message, 'bad'); }
    clearPrivateLyricsPassword(); edits = new Map(); privateOpen = false; privateLyricsDirty = false; releaseDirty = false; registrationDirty=false;
    renderLists();
    const kind = { track: '楽曲', album: 'アルバム', site: 'サイトの文言' }[type];
    const unsavedEl = el('span', { className: 'unsaved' });
    const saveBtn = el('button', { type: 'button', className: 'primary', textContent: '保存', disabled: true, onclick: save });
    const head = el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: kind }), current.title), unsavedEl, saveBtn,
      el('button', { type: 'button', textContent: 'プレビュー', onclick: preview }));
    const fields = current.fields.map((f, i) => {
      const id = `f${i}`;
      const input = f.kind === 'url' ? el('input', { id, type: 'url', value: f.value, placeholder: 'https://open.spotify.com/…' })
        : f.kind === 'line' || f.kind === 'reading' ? el('input', { id, type: 'text', value: f.value }) : el('textarea', { id, value: f.value, className: f.kind === 'lyrics' ? 'lyrics' : '' });
      if (f.kind === 'text') input.rows = Math.min(14, Math.max(3, Math.ceil(f.value.length / 60) + (f.value.match(/\n/g) || []).length));
      const isImpression = type === 'track' && f.path[0] === 'aiImpression';
      if (isImpression) input.rows = Math.max(input.rows, 5);
      const box = el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: f.label }, ...(f.required ? [el('span', { className: 'req', textContent: '（必須）' })] : [])), input,
        ...(isImpression ? [el('p', { className: 'note', textContent: '公式HPの曲ページ「AIの感想」欄の文章です（制作背景とは別）。複数行で入力できます。空にして保存すると削除されます。表示だけ止めるときは、下の「AIの感想を表示する」のチェックを外してください（文章は残ります）。' })] : []));
      input.addEventListener('input', () => {
        const v = input.value.replace(/\r\n?/g, '\n');
        if (isImpression) impressionNote(v.trim() !== '');
        if (v === f.value) edits.delete(i); else edits.set(i, v);
        box.classList.toggle('changed', edits.has(i));
        saveBtn.disabled = !edits.size;
        unsavedEl.textContent = edits.size ? `未保存の入力 ${edits.size} 件` : '';
      });
      return box;
    });
    const tip = el('p', { className: 'note', textContent: type === 'album' ? '上の欄で文字を直せます（改行はそのまま表示に反映）。下の「掲載の管理」で、掲載停止・掲載順・収録曲・ジャケットを変えられます。特設デザインの構成や色は変わりません。' : '文字だけを直せます。デザインは変わりません。' });
    let syncJacket = () => {};
    const changed = () => {
      saveBtn.disabled = !edits.size;
      unsavedEl.textContent = edits.size ? `未保存の入力 ${edits.size} 件` : '';
      syncJacket();
    };
    const jacketBox = type === 'track' && current.jacket ? (b => { syncJacket = b.sync; return [b.box]; })(jacketEditor(current, changed)) : [];
    const displayBox = type === 'track' && current.display ? displayEditor(current, changed) : [];
    $('#main').replaceChildren(head, tip, ...fields, ...jacketBox, ...displayBox, ...(type === 'site' ? [] : manageBox(current)));
    syncJacket();
    if (type === 'track') impressionNote(!!(current.fields.find(f => f.path[0] === 'aiImpression')?.value ?? '').trim());
    $('#main').scrollTop = 0;
  }

  // the note beside 「AIの感想を表示する」 follows what is typed in the AIの感想 field (before saving too)
  function impressionNote(has) {
    const n = document.querySelector('#disp-impression ~ .note');
    if (n) n.textContent = has ? '' : '（AIの感想が未入力のため、チェックしても表示されません。上の「AIの感想」欄に入力できます）';
  }

  // ── 2026-11-26: ジャケット画像 of a song (new or already published) ──
  // Choosing a picture is one more unsaved edit (key 'jacket'): nothing is written until 保存, nothing is public until 公開する.
  // The picture is converted in the browser exactly as for a new song (prepareImage), and only the two display JPEGs change.
  function jacketEditor(item, onChange) {
    const box = el('section', { className: 'jacket-box' });
    const fig = (label, img) => el('figure', { className: 'jacket-fig' }, img, el('figcaption', { textContent: label }));
    const nowImg = el('img', { className: 'registration-jacket', alt: '現在のジャケット', src: item.jacket.src ?? '' });
    const newImg = el('img', { className: 'registration-jacket', alt: '新しいジャケット' });
    const newFig = fig('新しいジャケット（未保存）', newImg); newFig.hidden = true;
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'track-jacket', hidden: true });
    const pick = el('button', { type: 'button', textContent: '画像を変更', onclick: () => input.click() });
    const undo = el('button', { type: 'button', textContent: '選択を取り消す', hidden: true, onclick: () => { edits.delete('jacket'); input.value = ''; newImg.removeAttribute('src'); newFig.hidden = true; undo.hidden = true; box.classList.remove('changed'); onChange(); } });
    const off = el('p', { className: 'warn', hidden: true, textContent: '下の「ジャケットを表示する」のチェックが外れているため、公式HPにはジャケットを表示しません（画像は保存されます。チェックを戻すと表示されます）。' });
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      try {
        const image = await prepareImage(f);
        edits.set('jacket', image);
        newImg.src = `data:image/jpeg;base64,${image.thumb.data}`; newFig.hidden = false; undo.hidden = false; box.classList.add('changed');
        onChange();
      } catch (e) { toast(e.message, 'bad', 9000); }
      input.value = '';
    };
    box.append(el('h3', { textContent: 'ジャケット画像' }),
      el('div', { className: 'jacket-figs' }, fig(item.jacket.changed ? '現在のジャケット（公開していない変更あり）' : '現在のジャケット', nowImg), newFig),
      el('div', { className: 'registration-actions' }, pick, undo, input), off,
      el('p', { className: 'note', textContent: 'PNG/JPEGの画像を選ぶと、ここで確認できます。「保存」→「プレビュー」→「公開する」で公式HPに反映します（選んだだけ・保存しただけでは公開されません）。前の画像はこのパソコンの控えに残り、公開前は「変更を破棄」、公開後は「公開履歴・取り消し」で戻せます。曲名・歌詞・AIの感想・ページのURLは変わりません。' }),
      el('p', { className: 'note', textContent: 'PRIVATE：公式HPのジャケットを使っている曲は、公開後にPRIVATEでも新しい画像で表示されます（PRIVATEで別の画像を登録した曲は変わりません）。一般視聴：公開中の画像は変わりません。一般視聴も新しい画像にするときは、公開後に「一般視聴の管理」で公開内容を保存し直してください。' }));
    return { box, sync: () => { const c = document.getElementById('disp-jacket'); off.hidden = !c || c.checked; } };
  }

  // ── 2026-11-25: 公式HPに表示する内容 (lyrics / jacket / AI impression, and the notice shown instead of the lyrics) ──
  // A change is one more unsaved edit (key 'display'): 保存 → プレビュー → 公開する, as for the texts. Nothing is deleted.
  function displayEditor(item, onChange) {
    const base = item.display, now = { ...base };
    const norm = d => JSON.stringify({ lyrics: d.lyrics, jacket: d.jacket, impression: d.impression, lyricsNotice: d.lyrics ? null : (d.lyricsNotice ?? null) });
    const box = el('section', { className: 'display-box' });
    const check = (key, label, missing) => {
      const input = el('input', { id: `disp-${key}`, type: 'checkbox', checked: now[key] });
      input.onchange = () => { now[key] = input.checked; update(); };
      return el('div', { className: 'field check' }, input, el('label', { htmlFor: `disp-${key}`, textContent: label }), ...(missing ? [el('span', { className: 'note', textContent: missing })] : []));
    };
    const sel = el('select', { id: 'disp-notice' }, el('option', { value: '', textContent: '理由を表示しない（歌詞欄ごと表示しない）' }), ...item.notices.map(n => el('option', { value: n.value, textContent: n.label })));
    sel.value = now.lyricsNotice ?? '';
    sel.onchange = () => { now.lyricsNotice = sel.value || null; update(); };
    const sample = el('p', { className: 'notice-sample' });
    const noticeBox = el('div', { className: 'field notice-field' }, el('label', { htmlFor: 'disp-notice', textContent: '歌詞を載せない理由（公式HPの歌詞欄に、歌詞の代わりに表示する文）' }), sel, sample);
    function update() {
      noticeBox.hidden = now.lyrics;
      const t = item.notices.find(n => n.value === sel.value)?.text;
      sample.textContent = t ? `表示する文：「${t}」` : '歌詞欄は表示されません。';
      if (norm(now) === norm(base)) edits.delete('display'); else edits.set('display', { lyrics: now.lyrics, jacket: now.jacket, impression: now.impression, lyricsNotice: now.lyrics ? null : (now.lyricsNotice ?? null) });
      box.classList.toggle('changed', edits.has('display'));
      onChange();
    }
    box.append(el('h3', { textContent: '公式HPに表示する内容' }),
      el('p', { className: 'note', textContent: 'チェックを外した項目は公式HPに表示しません。登録済みの歌詞・ジャケット画像・AIの感想は消えず、チェックを戻すと元どおり表示されます。「保存」→「プレビュー」→「公開する」で反映します（チェックしただけでは公開されません）。PRIVATE・一般視聴には影響しません。' }),
      check('lyrics', '歌詞を表示する', item.hasLyrics ? '' : '（この曲は歌詞が未登録です）'), noticeBox,
      check('jacket', 'ジャケットを表示する（表示しないときは曲名の表示になります）'),
      check('impression', 'AIの感想を表示する', ' '));
    update();
    return [box];
  }

  // ── 2026-11-24: publication, order, album tracks and jacket for songs/albums already on the site ──
  // Every change here becomes a "公開していない変更" first (preview, then 公開する; 変更を破棄 undoes it).
  async function prepareImage(file) {
    if (!file || file.size > 12 * 1024 * 1024) throw new Error('PNG/JPEGの画像は12MB以内にしてください。');
    const mime = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : '');
    if (!['image/png', 'image/jpeg'].includes(mime)) throw new Error('PNGまたはJPEGを選択してください。');
    const original = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = () => reject(new Error('画像を読み込めません。')); r.readAsDataURL(file); });
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => { const x = new Image(); x.onload = () => resolve(x); x.onerror = () => reject(new Error('画像を読み込めません。')); x.src = url; });
      if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40e6) throw new Error('画像の大きさを確認してください。');
      const render = (width, quality) => { const c = document.createElement('canvas'); c.width = width; c.height = Math.max(1, Math.round(img.naturalHeight * width / img.naturalWidth)); if (c.height > 4000) throw new Error('画像の縦横比を確認してください。'); const ctx = c.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height); return { mime: 'image/jpeg', data: c.toDataURL('image/jpeg', quality).split(',')[1] }; };
      return { original: { mime, data: original }, web: render(Math.min(1254, img.naturalWidth), .86), thumb: render(640, .84) };
    } finally { URL.revokeObjectURL(url); }
  }
  const reopen = async (type, id) => { await refresh(); edits = new Map(); await openItem(type, id); };
  function manageBox(item) {
    const kindName = item.type === 'track' ? '曲' : 'アルバム';
    const out = [el('h3', { textContent: '掲載の管理' })];
    out.push(el('p', { className: 'note', textContent: item.hidden ? `この${kindName}は「掲載停止中」です（データ・画像は残っています）。公開すると公式サイトから見えなくなります。` : `公式サイトに掲載中の${kindName}です。` }));
    const hideBtn = el('button', { type: 'button', textContent: item.hidden ? '掲載を再開する' : '掲載を停止する', onclick: async () => {
      if (edits.size) return toast('先に文字の変更を保存してください。', 'bad');
      const go = await ask(item.hidden ? `${kindName}の掲載を再開します` : `${kindName}の掲載を停止します`, [el('p', { textContent: `対象：${item.title}（${item.id}）` }),
        el('p', { textContent: item.hidden ? '公開すると、公式サイトにもう一度表示されます。' : '公開すると、公式サイトのページと一覧から消えます。曲名・歌詞・画像などのデータは消えず、「掲載を再開する」で戻せます。' + (item.type === 'track' ? 'アルバムの曲目では曲名だけが残り、曲ページへのリンクが外れます。PRIVATE には影響しません。' : '') }),
        el('p', { className: 'warn', textContent: 'まだ公開はされません。プレビューで確認してから「公開する」を押してください。' })],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: item.hidden ? '再開する' : '停止する', primary: true }]);
      if (go !== 'go') return;
      try { await api('POST', '/api/hidden', { type: item.type, id: item.id, rev: item.rev, hidden: !item.hidden, confirm: true }); toast(item.hidden ? '掲載を再開しました（まだ公開されていません）。' : '掲載を停止しました（まだ公開されていません）。'); await reopen(item.type, item.id); } catch (e) { toast(e.message, 'bad', 9000); }
    } });
    const actions = [hideBtn];
    if (item.hidden) actions.push(el('button', { type: 'button', textContent: '管理一覧から外す', onclick: async () => {
      const go = await ask('管理一覧から外します', [el('p', { textContent: `対象：${item.title}（${item.id}）` }), el('p', { textContent: '左の一覧に出なくなるだけで、データ・画像は消えません。「削除済み・一覧から外したもの」からいつでも戻せます。公開済みの状態でも、先に掲載停止を公開してから外してください。' })],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '一覧から外す', primary: true }]);
      if (go !== 'go') return;
      try { await api('POST', '/api/archive', { type: item.type, id: item.id, archive: true, confirm: true }); toast('一覧から外しました。'); await refresh(); $('#main').replaceChildren(el('p', { className: 'note', textContent: '一覧から外しました。' })); } catch (e) { toast(e.message, 'bad', 9000); }
    } }));
    out.push(el('div', { className: 'registration-actions' }, ...actions));
    if (item.type !== 'album') return out;

    out.push(el('h3', { textContent: '掲載順（同じページの中で）' }), el('div', { className: 'registration-actions' },
      ...[[-1, '↑ 前へ'], [1, '↓ 後ろへ']].map(([dir, label]) => el('button', { type: 'button', textContent: label, onclick: async () => {
        try { await api('POST', '/api/album/move', { id: item.id, rev: item.rev, dir }); toast('掲載順を変えました（まだ公開されていません）。'); await reopen('album', item.id); } catch (e) { toast(e.message, 'bad'); }
      } }))));

    out.push(el('h3', { textContent: '収録曲（曲順・追加・取り外し）' }));
    if (!item.tracks) out.push(el('p', { className: 'note', textContent: 'この作品はディスク別などの特別な構成のため、収録曲の構成の変更はAIに依頼してください（曲名の文字は上の欄で直せます）。' }));
    else {
      const songs = state.list.tracks;
      const row = (t, i) => el('li', { className: 'album-track' }, el('span', { textContent: `${String(i + 1).padStart(2, '0')}  ${t.title}${t.music ? `（曲ページ：${songs.find(s => s.id === t.music)?.title ?? t.music}）` : ''}` }),
        ...[['↑', 'move', -1], ['↓', 'move', 1]].map(([label, op, dir]) => el('button', { type: 'button', textContent: label, ariaLabel: `${t.title}を${dir < 0 ? '前' : '後ろ'}へ`, onclick: async () => {
          try { await api('POST', '/api/album/tracks', { id: item.id, rev: item.rev, op, index: i, dir }); await reopen('album', item.id); } catch (e) { toast(e.message, 'bad'); }
        } })),
        el('button', { type: 'button', textContent: '外す', onclick: async () => {
          const go = await ask('収録曲から外します', [el('p', { textContent: `「${t.title}」をアルバム『${item.title}』の曲目から外します。` }), el('p', { textContent: '曲そのもの（曲ページ・歌詞・ジャケット・音源・PRIVATE）は消えません。公開前なら「変更を破棄」で戻せます。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '外す', primary: true }]);
          if (go !== 'go') return;
          try { await api('POST', '/api/album/tracks', { id: item.id, rev: item.rev, op: 'remove', index: i, confirm: true }); await reopen('album', item.id); } catch (e) { toast(e.message, 'bad'); }
        } }));
      const addTitle = el('input', { type: 'text', id: 'album-add-title', placeholder: '曲名', maxLength: 150 });
      const addMusic = el('select', { id: 'album-add-music' }, el('option', { value: '', textContent: '（曲ページなし）' }), ...songs.map(s => el('option', { value: s.id, textContent: s.title })));
      addMusic.onchange = () => { if (addMusic.value && !addTitle.value.trim()) addTitle.value = addMusic.selectedOptions[0].textContent; };
      out.push(el('ol', { className: 'album-tracks' }, ...item.tracks.map(row)),
        el('div', { className: 'registration-actions' }, el('label', { htmlFor: 'album-add-music', textContent: '追加：' }), addMusic, addTitle, el('button', { type: 'button', textContent: '曲目に追加', onclick: async () => {
          try { await api('POST', '/api/album/tracks', { id: item.id, rev: item.rev, op: 'add', title: addTitle.value, music: addMusic.value || null }); await reopen('album', item.id); } catch (e) { toast(e.message, 'bad'); }
        } })));
    }
    out.push(el('h3', { textContent: 'ジャケット画像' }));
    if (item.joint) out.push(el('p', { className: 'note', textContent: '複数作品の構成のため、画像の変更はAIに依頼してください。' }));
    else {
      const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'album-jacket' });
      out.push(el('p', { className: 'note', textContent: item.hasJacket ? '選んだ画像で差し替えます（前の画像はこのパソコンの控えに残り、公開前なら「変更を破棄」で戻せます）。' : 'この作品には採用ジャケットがありません。登録すると、ジャケット付きの表示になります。' }),
        el('div', { className: 'field' }, el('label', { htmlFor: 'album-jacket', textContent: 'PNG/JPEG を選ぶ' }), input));
      input.onchange = async () => {
        const f = input.files?.[0]; if (!f) return;
        try {
          const image = await prepareImage(f);
          const go = await ask('ジャケットを差し替えます', [el('img', { src: `data:image/jpeg;base64,${image.thumb.data}`, alt: '新しいジャケット', className: 'registration-jacket' }), el('p', { textContent: `アルバム『${item.title}』のジャケットをこの画像にします。` })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '差し替える', primary: true }]);
          if (go !== 'go') { input.value = ''; return; }
          await api('POST', '/api/album/jacket', { id: item.id, image, confirm: true }); toast('ジャケットを差し替えました（まだ公開されていません）。'); await reopen('album', item.id);
        } catch (e) { toast(e.message, 'bad', 9000); input.value = ''; }
      };
    }
    return out;
  }

  // ── 2026-11-24: album registration (draft → ready → adopt into albums.json → 公開する) ──
  async function openAlbumRegistration(id = null) {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'album'; albumRegId = id; privateLyricsDirty = releaseDirty = registrationDirty = false; renderLists();
    const stateLabels = { draft: '下書き', ready: '公開準備完了' }, pubLabels = { 'not-adopted': '未公開（公式HPへ未取り込み）', adopted: '公式HPへ取り込み済み・まだ公開していない（画面上部の「公開する」で公開）', published: '公式HPで公開済み', withdrawn: '取り込みを取り消し済み（未公開）' };
    let saved = null, pendingImage = null, history = [], publication = { state: 'not-adopted' }, tracks = [];
    const status = el('p', { role: 'status', ariaLive: 'polite', className: 'note' }), show = (m, k = 'note') => { status.textContent = m; status.className = k; };
    const dirty = () => { registrationDirty = true; };
    const c = {};
    const field = (key, label, tag = 'input', max = 150) => { const n = el(tag, { id: `al-${key}`, maxLength: max, ...(tag === 'input' ? { type: 'text' } : {}) }); n.oninput = dirty; c[key] = n; return el('div', { className: 'field' }, el('label', { htmlFor: n.id, textContent: label }), n); };
    const sel = (key, label, opts) => { const n = el('select', { id: `al-${key}` }, ...Object.entries(opts).map(([value, textContent]) => el('option', { value, textContent }))); n.onchange = dirty; c[key] = n; return el('div', { className: 'field' }, el('label', { htmlFor: n.id, textContent: label }), n); };
    const idLabel = el('p', { className: 'note' }), img = el('img', { className: 'registration-jacket', alt: 'アルバムのジャケット', hidden: true }), imgInput = el('input', { type: 'file', accept: 'image/png,image/jpeg', id: 'al-image' });
    const list = el('ol', { className: 'album-tracks' }), songs = state.list.tracks;
    const addMusic = el('select', { id: 'al-add-music' }, el('option', { value: '', textContent: '（曲ページなし）' }), ...songs.map(s => el('option', { value: s.id, textContent: s.title }))), addTitle = el('input', { type: 'text', id: 'al-add-title', placeholder: '曲名', maxLength: 150 });
    addMusic.onchange = () => { if (addMusic.value && !addTitle.value.trim()) addTitle.value = addMusic.selectedOptions[0].textContent; };
    function paintTracks() {
      list.replaceChildren(...tracks.map((t, i) => el('li', { className: 'album-track' }, el('span', { textContent: `${String(i + 1).padStart(2, '0')}  ${t.title}${t.music ? `（曲ページ：${songs.find(s => s.id === t.music)?.title ?? t.music}）` : ''}` }),
        el('button', { type: 'button', textContent: '↑', disabled: i === 0, onclick: () => { [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; dirty(); paintTracks(); } }),
        el('button', { type: 'button', textContent: '↓', disabled: i === tracks.length - 1, onclick: () => { [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; dirty(); paintTracks(); } }),
        el('button', { type: 'button', textContent: '外す', onclick: () => { tracks.splice(i, 1); dirty(); paintTracks(); } }))));
    }
    const addBtn = el('button', { type: 'button', textContent: '曲目に追加', onclick: () => { const t = addTitle.value.trim(); if (!t) return show('曲名を入力してください。', 'err'); tracks.push(addMusic.value ? { title: t, music: addMusic.value } : { title: t }); addTitle.value = ''; addMusic.value = ''; dirty(); paintTracks(); } });
    const histSel = el('select', { id: 'al-history' }), slug = el('input', { type: 'text', id: 'al-slug', maxLength: 60, placeholder: '例：new-album-2026', spellcheck: false, autocomplete: 'off' }), adoptNote = el('p', { className: 'note' });
    function fill(res) {
      saved = res?.record ?? null; publication = res?.publication ?? { state: 'not-adopted' }; history = res?.history ?? []; pendingImage = null; albumRegId = saved?.id ?? null;
      const r = saved ?? { title: '', subtitle: '', section: 'history', kind: 'Album', year: '', dateLabel: '', intro: '', story: '', tracks: [], links: [], state: 'draft', memo: '' };
      for (const k of ['title', 'subtitle', 'section', 'kind', 'year', 'dateLabel', 'intro', 'story', 'state', 'memo']) c[k].value = r[k] ?? '';
      c.urls.value = (r.links ?? []).join('\n'); tracks = r.tracks.map(t => ({ ...t })); paintTracks();
      img.hidden = !res?.thumbnail; if (res?.thumbnail) img.src = res.thumbnail; imgInput.value = '';
      idLabel.textContent = saved ? `アルバムID：${saved.id} ／ 実際の公開：${pubLabels[publication.state] ?? '未公開'}${publication.slug ? `（albums/${publication.slug}）` : ''}` : 'アルバムID：初回保存時に自動発行 ／ 実際の公開：未公開';
      histSel.replaceChildren(...history.filter(h => h.rev !== saved?.rev).map(h => el('option', { value: h.rev, textContent: `${new Date(h.updatedAt).toLocaleString('ja-JP')}　${h.title}` }))); histSel.disabled = history.length < 2;
      const done = ['adopted', 'published'].includes(publication.state), ready = saved?.state === 'ready' && saved.image && saved.tracks.length;
      adoptBtn.disabled = slug.disabled = !ready || done; if (publication.slug && !slug.value) slug.value = publication.slug;
      adoptNote.textContent = done ? `取り込み済み（albums/${publication.slug}）。この後の修正は、左の HISTORY／その他の作品 の一覧から行ってください。` : ready ? 'ページのURL名を決めて取り込むと、公式HPのアルバムデータに加わります（そのページの最後に並びます）。公開は画面上部の「公開する」で行います。' : '取り込めるのは「公開準備完了」で保存し、ジャケットと収録曲を登録したアルバムです。';
      delBtn.hidden = !saved || done; c.state.disabled = done; if (done) c.state.value = 'ready';
      liveNote.hidden = !done; liveNote.replaceChildren(...(done ? [el('span', { textContent: publication.state === 'published' ? 'このアルバムは公式サイトで公開中です。公開中の内容を直すときは、公開中のアルバムを開いてください（この登録画面の変更は公式サイトに反映されません）。' : 'このアルバムは公式HPへ取り込み済みです（まだ公開していません）。' }), el('button', { type: 'button', textContent: '公開中のアルバムを開く', onclick: () => openItem('album', publication.slug) })] : []));
      registrationDirty = false; renderLists();
    }
    const values = () => ({ title: c.title.value, subtitle: c.subtitle.value, section: c.section.value, kind: c.kind.value, year: c.year.value, dateLabel: c.dateLabel.value, intro: c.intro.value, story: c.story.value, tracks, urls: c.urls.value.split('\n').map(x => x.trim()).filter(Boolean), state: c.state.value, memo: c.memo.value });
    imgInput.onchange = async () => { const f = imgInput.files?.[0]; if (!f) return; try { pendingImage = await prepareImage(f); img.src = `data:image/jpeg;base64,${pendingImage.thumb.data}`; img.hidden = false; dirty(); show('画像を準備しました。保存すると登録されます。'); } catch (e) { show(e.message, 'err'); } };
    const busy = async (fn) => { if (registrationBusy) return; registrationBusy = true; form.inert = true; try { await fn(); } catch (e) { show(e.message, 'err'); } finally { registrationBusy = false; form.inert = false; } };
    const saveBtn = el('button', { type: 'button', className: 'primary', textContent: '確認して保存', onclick: async () => {
      if (saved && !registrationDirty) return show('変更はありません。'); const f = values(); if (!f.title.trim()) return show('アルバム名を入力してください。', 'err');
      const go = await ask('アルバム登録の保存確認', [el('p', { textContent: `${f.title}（${saved?.id ?? '新規IDを発行'}）` }), el('p', { textContent: `${f.section === 'other' ? 'その他の作品' : 'HISTORY'}／${stateLabels[f.state]}／収録曲 ${f.tracks.length} 曲` }), el('p', { className: 'warn', textContent: 'この保存は非公開の掲載準備記録です。公式サイトはまだ変わりません。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '保存する', primary: true }]);
      if (go !== 'go') return;
      await busy(async () => { fill(await api('POST', '/api/album-registration/save', { id: saved?.id, rev: saved?.rev, fields: f, image: pendingImage, confirm: true })); await refresh(); show('✔ 保存しました。まだ公開されていません。', 'done'); });
    } });
    const restoreBtn = el('button', { type: 'button', textContent: '以前の保存版を復元', onclick: async () => {
      if (!saved || !histSel.value || registrationDirty) return show('保存済みの版を選んでください。未保存の入力は先に保存してください。', 'err');
      if (await ask('以前の保存版を復元します', el('p', { textContent: '現在の内容も履歴に残したまま、新しい保存版として復元します。' }), [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '復元する', primary: true }]) !== 'go') return;
      await busy(async () => { fill(await api('POST', '/api/album-registration/restore', { id: saved.id, rev: saved.rev, restoreRev: histSel.value, confirm: true })); await refresh(); show('✔ 復元しました。', 'done'); });
    } });
    const adoptBtn = el('button', { type: 'button', textContent: '公式HPのアルバムデータへ取り込む', onclick: async () => {
      if (!saved || registrationDirty) return show('先に保存してください。', 'err');
      const s = slug.value.trim(); if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) return show('ページのURL名は英小文字・数字・ハイフンで入力してください。', 'err');
      if (await ask('公式HPのアルバムデータへ取り込みます', [el('p', { textContent: `『${saved.title}』を ${saved.section === 'other' ? 'その他の作品' : 'HISTORY'} の最後に、albums/${s} として加えます（収録曲 ${saved.tracks.length} 曲・ジャケット）。` }), el('p', { className: 'warn', textContent: 'まだ公開されません。プレビューで確認し、画面上部の「公開する」で公開します。公開前なら「変更を破棄」で取り消せます。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '取り込む', primary: true }]) !== 'go') return;
      await busy(async () => { fill(await api('POST', '/api/album-registration/adopt', { id: saved.id, rev: saved.rev, slug: s, confirm: true })); await refresh(); show('✔ 取り込みました。まだ公開されていません。左の一覧のアルバムを開いて「プレビュー」で確認してから「公開する」を押してください。', 'done'); });
    } });
    const delBtn = el('button', { type: 'button', textContent: 'この登録を削除（復元できます）', onclick: async () => {
      if (await ask('アルバムの登録を削除します', [el('p', { textContent: `対象：${saved.title}（${saved.id}）` }), el('p', { textContent: '左の一覧から消えますが、データは残り「削除済み・一覧から外したもの」から復元できます。' })], [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '削除する', primary: true }]) !== 'go') return;
      await busy(async () => { await api('POST', '/api/album-registration/delete', { id: saved.id, confirm: true }); registrationDirty = false; await refresh(); $('#main').replaceChildren(el('p', { className: 'note', textContent: '削除しました（復元できます）。' })); });
    } });
    const liveNote = el('div', { className: 'live-note', hidden: true });
    const form = el('section', {}, idLabel, liveNote, field('title', 'アルバム名（必須）'), field('subtitle', '副題（任意）'),
      el('div', { className: 'release-fields' }, sel('section', '掲載ページ', { history: 'HISTORY（PIP POPPERの作品）', other: 'その他の作品' }), field('kind', '区分（例：Album・Single・EP）', 'input', 40)),
      el('div', { className: 'release-fields' }, field('year', '年（例：2026。未設定可）', 'input', 20), field('dateLabel', '公開日の表示（例：2026年11月。未設定可）', 'input', 40)),
      el('div', { className: 'field' }, el('label', { htmlFor: 'al-image', textContent: 'アルバムジャケット（PNG/JPEG）' }), imgInput, img),
      field('intro', 'アルバム紹介文（空行で段落を分ける）', 'textarea', 20000), field('story', '制作秘話・補足説明（空行で段落を分ける）', 'textarea', 20000),
      el('h3', { textContent: '収録曲（曲順）' }), list, el('div', { className: 'registration-actions' }, el('label', { htmlFor: 'al-add-music', textContent: '追加：' }), addMusic, addTitle, addBtn),
      field('urls', '外部配信先URL（任意・1行1件。アルバム情報に表示）', 'textarea', 5000), field('memo', '管理メモ（非公開）', 'textarea', 10000), sel('state', '登録状態', stateLabels),
      el('div', { className: 'registration-actions' }, saveBtn, delBtn), el('h3', { textContent: '保存履歴・復元' }), el('div', { className: 'registration-actions' }, histSel, restoreBtn),
      el('h3', { textContent: '公式HPへの取り込み（公開前の最終段階）' }), adoptNote, el('div', { className: 'field' }, el('label', { htmlFor: 'al-slug', textContent: 'ページのURL名（英小文字・数字・ハイフン。公開後は変えない）' }), slug), el('div', { className: 'registration-actions' }, adoptBtn));
    $('#main').replaceChildren(el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: 'アルバム管理' }), 'アルバムを登録')), el('p', { className: 'note', textContent: 'ジャケット・紹介文・制作秘話・収録曲を登録し、下書きとして保存します。ここから本番公開はされません。' }), form, status);
    $('#main').scrollTop = 0;
    registrationBusy = true; form.inert = true;
    try { fill(id ? await api('POST', '/api/album-registration/get', { id }) : null); } catch (e) { show(e.message, 'err'); } finally { registrationBusy = false; form.inert = false; }
  }

  // ── 2026-11-24: restore what was deleted (registrations) or taken off the list (hidden songs/albums) ──
  async function openDeleted() {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'deleted'; renderLists();
    const rows = [...(state.deletedRegistrations ?? []).map(r => ({ label: `${r.kind === 'album' ? 'アルバム登録' : '新曲登録'}：${r.title}`, at: r.deletedAt, restore: () => api('POST', `/api/${r.kind === 'album' ? 'album' : 'song'}-registration/undelete`, { id: r.id, confirm: true }) })),
      ...(state.archived ?? []).map(a => ({ label: `${a.type === 'album' ? 'アルバム' : '曲'}（掲載停止中）：${a.title}`, at: a.at, restore: () => api('POST', '/api/archive', { type: a.type, id: a.id, archive: false, confirm: true }) }))];
    $('#main').replaceChildren(el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: '復元' }), '削除済み・一覧から外したもの')),
      el('p', { className: 'note', textContent: 'ここにあるものはデータが残っています。「戻す」で左の一覧に戻ります（公式サイトの掲載は変わりません。掲載を再開するときは、戻した後に編集画面の「掲載を再開する」）。' }),
      rows.length ? el('ul', { className: 'changes' }, ...rows.map(r => el('li', {}, el('div', { className: 'what', textContent: `${r.label}　${r.at ? new Date(r.at).toLocaleString('ja-JP') : ''}` }),
        el('button', { type: 'button', textContent: '戻す', onclick: async () => { try { await r.restore(); toast('戻しました。'); await refresh(); await openDeleted(); } catch (e) { toast(e.message, 'bad'); } } })))) : el('p', { textContent: 'ありません。' }));
  }


  // ── PRIVATE: invitee password. Typed passwords are cleared when the work ends (success or not) and never stored. ──
  let privateOpen = false, albumRegId = null;
  async function openPrivate() {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'password'; privateLyricsDirty = false; releaseDirty = false; registrationDirty=false;
    renderLists();
    const pw = (id, label, auto) => { const input = el('input', { id, type: 'password', autocomplete: auto, spellcheck: false });
      return [el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: label }), input), input]; };
    const [fNew, iNew] = pw('pp-new', '新しいパスワード（8〜200文字）', 'new-password');
    const [fConf, iConf] = pw('pp-conf', '新しいパスワード（確認用・もう一度）', 'new-password');
    const [fAdm, iAdm] = pw('pp-adm', '管理者パスワード（PRIVATEの管理画面に入るときのもの）', 'off');
    // show / hide the three passwords together (starts hidden; switching keeps what was typed)
    const iShow = el('input', { id: 'pp-show', type: 'checkbox' });
    iShow.onchange = () => [iNew, iConf, iAdm].forEach(i => { i.type = iShow.checked ? 'text' : 'password'; });
    const fShow = el('div', { className: 'field check' }, iShow, el('label', { htmlFor: 'pp-show', textContent: 'パスワードを表示' }));
    const result = el('p', { className: 'note', role: 'status', ariaLive: 'polite' });
    const btn = el('button', { type: 'button', className: 'primary', textContent: 'パスワードを変更' });
    const clear = (...inputs) => inputs.forEach(i => { i.value = ''; });
    btn.onclick = async () => {
      if (!iNew.value || iNew.value !== iConf.value) { result.className = 'err'; result.textContent = '新しいパスワードと確認用が一致しません。'; return; }
      const ok = await ask('PRIVATEのパスワードを変更します', [el('p', { textContent: '変更すると、いま入室している招待者は全員、新しいパスワードで入り直しになります。' }),
        el('p', { className: 'warn', textContent: '新しいパスワードを招待者に伝える方法を確認してから変更してください。' })],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '変更する', primary: true }]);
      if (ok !== 'go') return;
      btn.disabled = true; result.className = 'note'; result.textContent = '変更しています…';
      try {
        const r = await api('POST', '/api/private/password', { newPassword: iNew.value, confirmPassword: iConf.value, adminPassword: iAdm.value });
        result.className = 'done'; result.textContent = `✔ 変更が完了しました（${new Date(r.changedAt ?? Date.now()).toLocaleString('ja-JP')}）。${r.message ?? ''}`;
      } catch (e) { result.className = 'err'; result.textContent = `変更できませんでした：${e.message}`; }
      finally { clear(iNew, iConf, iAdm); btn.disabled = false; }
    };
    const [fRAdm, iRAdm] = pw('pp-radm', '管理者パスワード', 'off');
    const iWords = el('input', { id: 'pp-words', type: 'text', autocomplete: 'off', placeholder: '旧パスワードに戻す' });
    const rResult = el('p', { className: 'note', role: 'status', ariaLive: 'polite' });
    const rBtn = el('button', { type: 'button', textContent: 'Cloudflareのパスワードに戻す' });
    rBtn.onclick = async () => {
      const ok = await ask('Cloudflareに登録されたパスワードに戻します', [el('p', { textContent: '管理ツールで設定したパスワードは使えなくなり、Cloudflareに登録されている以前のパスワードに戻ります。招待者は全員、入り直しになります。' })],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '戻す' }]);
      if (ok !== 'go') return;
      rBtn.disabled = true; rResult.className = 'note'; rResult.textContent = '戻しています…';
      try { const r = await api('POST', '/api/private/restore', { adminPassword: iRAdm.value, confirm: iWords.value.trim() }); rResult.className = 'done'; rResult.textContent = `✔ ${r.message ?? '戻しました。'}`; }
      catch (e) { rResult.className = 'err'; rResult.textContent = `戻せませんでした：${e.message}`; }
      finally { clear(iRAdm, iWords); rBtn.disabled = false; }
    };
    $('#main').replaceChildren(
      el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: 'PRIVATE管理' }), 'PRIVATEのパスワード')),
      el('p', { className: 'note', textContent: `招待者がPRIVATE（${state?.privateUrl ?? ''}）に入るときのパスワードを変えます。変更は直ちに反映され、入力したパスワードはこの画面にもパソコンにも残りません。` }),
      fNew, fConf, fAdm, fShow, el('div', { className: 'field' }, btn), result,
      el('details', { className: 'restore' }, el('summary', { textContent: '以前のパスワード（Cloudflareに登録したもの）に戻す' }),
        el('p', { className: 'note', textContent: '管理ツールで設定したパスワードをやめて、Cloudflareのダッシュボードに登録されているパスワードに戻します。通常は使いません。確認のため、下の欄に「旧パスワードに戻す」と入力してください。' }),
        el('div', { className: 'field' }, el('label', { htmlFor: 'pp-words', textContent: '確認の言葉' }), iWords), fRAdm, el('div', { className: 'field' }, rBtn), rResult));
    $('#main').scrollTop = 0;
    window.addEventListener('pagehide', () => clear(iNew, iConf, iAdm, iRAdm, iWords), { once: true });
    // ── 2026-11-25: the administrator password (the one used for PRIVATE's admin screen, lyrics and 一般視聴の管理) ──
    const [faCur, aCur] = pw('pa-cur', '今の管理者パスワード', 'current-password');
    const [faNew, aNew] = pw('pa-new', '新しい管理者パスワード（12〜200文字、招待者のパスワードとは別のもの）', 'new-password');
    const [faConf, aConf] = pw('pa-conf', '新しい管理者パスワード（確認用・もう一度）', 'new-password');
    const aShow = el('input', { id: 'pa-show', type: 'checkbox' });
    aShow.onchange = () => [aCur, aNew, aConf].forEach(i => { i.type = aShow.checked ? 'text' : 'password'; });
    const aResult = el('p', { className: 'note', role: 'status', ariaLive: 'polite' });
    const aBtn = el('button', { type: 'button', className: 'primary', textContent: '管理者パスワードを変更' });
    aBtn.onclick = async () => {
      if (!aCur.value) { aResult.className = 'err'; aResult.textContent = '今の管理者パスワードを入力してください。'; return; }
      if (!aNew.value || aNew.value !== aConf.value) { aResult.className = 'err'; aResult.textContent = '新しい管理者パスワードと確認用が一致しません。'; return; }
      const ok = await ask('管理者パスワードを変更します', [el('p', { textContent: '変更すると、次からはPRIVATEの管理画面・歌詞・一般視聴の管理に新しい管理者パスワードが必要になります。古いパスワードでは入れなくなります。' }),
        el('p', { className: 'warn', textContent: '新しい管理者パスワードを、忘れない方法で控えてから変更してください（このツールやパソコンには残りません）。招待者のパスワード・音源・歌詞・一般視聴の公開内容は変わりません。' })],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '変更する', primary: true }]);
      if (ok !== 'go') return;
      aBtn.disabled = true; aResult.className = 'note'; aResult.textContent = '変更しています…';
      try { const r = await api('POST', '/api/private/admin-password', { newPassword: aNew.value, confirmPassword: aConf.value, adminPassword: aCur.value }); aResult.className = 'done'; aResult.textContent = `✔ ${r.message ?? '変更しました。'}`; }
      catch (e) { aResult.className = 'err'; aResult.textContent = `変更できませんでした：${e.message}`; }
      finally { clear(aCur, aNew, aConf); aBtn.disabled = false; }
    };
    const [faRCur, aRCur] = pw('pa-rcur', '今の管理者パスワード（管理ツールで変更したもの）', 'off');
    const aWords = el('input', { id: 'pa-words', type: 'text', autocomplete: 'off', placeholder: 'Cloudflareの管理者パスワードに戻す' });
    const aRResult = el('p', { className: 'note', role: 'status', ariaLive: 'polite' });
    const aRBtn = el('button', { type: 'button', textContent: 'Cloudflareの管理者パスワードに戻す' });
    aRBtn.onclick = async () => {
      const ok = await ask('Cloudflareに登録された管理者パスワードに戻します', [el('p', { textContent: '管理ツールで設定した管理者パスワードは使えなくなり、Cloudflareに登録されている管理者パスワードで入るようになります。' })],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '戻す' }]);
      if (ok !== 'go') return;
      aRBtn.disabled = true; aRResult.className = 'note'; aRResult.textContent = '戻しています…';
      try { const r = await api('POST', '/api/private/admin-restore', { adminPassword: aRCur.value, confirm: aWords.value.trim() }); aRResult.className = 'done'; aRResult.textContent = `✔ ${r.message ?? '戻しました。'}`; }
      catch (e) { aRResult.className = 'err'; aRResult.textContent = `戻せませんでした：${e.message}`; }
      finally { clear(aRCur, aWords); aRBtn.disabled = false; }
    };
    $('#main').append(el('h3', { textContent: '管理者パスワード（PRIVATEの管理画面・歌詞・一般視聴の管理に使うもの）' }),
      el('p', { className: 'note', textContent: '管理者パスワードを変えます。変更は直ちに反映され、入力したパスワードはこの画面にもパソコンにも残りません。' }),
      faCur, faNew, faConf, el('div', { className: 'field check' }, aShow, el('label', { htmlFor: 'pa-show', textContent: 'パスワードを表示' })), el('div', { className: 'field' }, aBtn), aResult,
      el('details', { className: 'restore' }, el('summary', { textContent: 'Cloudflareに登録した管理者パスワードに戻す・忘れたとき' }),
        el('p', { className: 'note', textContent: '管理ツールで設定した管理者パスワードをやめて、Cloudflareに登録されている管理者パスワードに戻します。確認のため、下の欄に「Cloudflareの管理者パスワードに戻す」と入力してください。' }),
        el('p', { className: 'note', textContent: '新しい管理者パスワードを忘れたとき：Cloudflareのダッシュボード → R2 → pip-popper-private-audio → auth/admin-password.json を削除すると、Cloudflareに登録されている管理者パスワードで入れるようになります（保守マニュアルの手順）。' }),
        el('div', { className: 'field' }, el('label', { htmlFor: 'pa-words', textContent: '確認の言葉' }), aWords), faRCur, el('div', { className: 'field' }, aRBtn), aRResult));
    window.addEventListener('pagehide', () => clear(aCur, aNew, aConf, aRCur, aWords), { once: true });

  }

  async function openPrivateLyrics() {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'lyrics'; privateLyricsDirty = false; releaseDirty = false; registrationDirty=false;
    renderLists();
    let catalog = null, selected = null, baselineLyrics = '';
    const password = el('input', { id: 'pl-password', type: 'password', autocomplete: 'off', spellcheck: false });
    clearPrivateLyricsPassword = () => { password.value = ''; };
    const load = el('button', { type: 'button', textContent: 'PRIVATE曲一覧を読み込む' });
    const chooser = el('select', { id: 'pl-song', disabled: true });
    const reading = el('input', { id: 'pl-reading', type: 'text', disabled: true, spellcheck: false, maxLength: 100, placeholder: '例：ほしのみち（空欄でも表示）' });
    const lyrics = el('textarea', { id: 'pl-lyrics', className: 'lyrics', disabled: true, spellcheck: false, maxLength: 100000 });
    const status = el('p', { role: 'status', ariaLive: 'polite', className: 'note' });
    const info = el('p', { className: 'note' });
    const saveButton = el('button', { type: 'button', className: 'primary', textContent: '内容を確認して保存', disabled: true });
    const result = (message, kind = 'note') => { status.textContent = message; status.className = kind; };
    const sync = () => {
      chooser.disabled = privateLyricsBusy || !catalog || !catalog.songs.length;
      lyrics.disabled = reading.disabled = privateLyricsBusy || !selected;
      load.disabled = privateLyricsBusy; password.disabled = privateLyricsBusy;
      saveButton.disabled = privateLyricsBusy || !selected || !privateLyricsDirty;
    };
    const selectSong = song => {
      selected = song; lyrics.value = song?.lyrics ?? ''; baselineLyrics = lyrics.value; reading.value = song?.reading ?? ''; privateLyricsDirty = false;
      info.textContent = song ? `曲ID：${song.id} ／ ${song.lyrics.trim() ? 'PRIVATE歌詞登録済み' : 'PRIVATE歌詞未登録'}` : 'PRIVATEに楽曲がありません。';
      if (song?.publicWork) info.append(' ／ ', el('a', { href: `https://pip-popper.github.io/tracks/${encodeURIComponent(song.id)}/`, target: '_blank', rel: 'noopener noreferrer', textContent: '公式サイトの歌詞・作品紹介' }));
      sync();
    };
    const drawChoices = id => {
      chooser.replaceChildren(...catalog.songs.map(s => el('option', { value: s.id, textContent: `${s.title}（${s.lyrics.trim() ? '登録済み' : '未登録'}）〔${s.id}〕` })));
      if (id) chooser.value = id;
    };
    chooser.onchange = async () => {
      const id = chooser.value;
      if (!await guard()) { chooser.value = selected?.id ?? ''; return; }
      selectSong(catalog.songs.find(s => s.id === id)); result('');
    };
    lyrics.oninput = reading.oninput = () => { privateLyricsDirty = !!selected && (lyrics.value !== baselineLyrics || reading.value.trim() !== (selected.reading ?? '')); sync(); };
    load.onclick = async () => {
      if (!await guard()) return;
      if (!password.value) return result('管理者パスワードを入力してください。', 'err');
      privateLyricsBusy = true; sync(); result('読み込んでいます…');
      const credential = password.value; password.value = '';
      try {
        const data = await api('POST', '/api/private/lyrics/list', { adminPassword: credential });
        catalog = data;
        const next = data.songs.find(s => s.id === selected?.id) ?? data.songs[0];
        drawChoices(next?.id);
        selectSong(next); result(`${data.songs.length} 曲を読み込みました。`, 'done');
      } catch (e) { result(`読み込めませんでした：${e.message}`, 'err'); }
      finally { privateLyricsBusy = false; sync(); }
    };
    saveButton.onclick = async () => {
      if (!selected || !privateLyricsDirty || privateLyricsBusy) return;
      if (!password.value) return result('保存用の管理者パスワードを入力してください。', 'err');
      const song = selected, text = lyrics.value, readingText = reading.value.trim(), rev = catalog.rev;
      const lyricsChanged = text !== baselineLyrics, readingChanged = readingText !== (song.reading ?? '');
      const answer = await ask('PRIVATE楽曲の変更確認', [el('p', { textContent: `対象：${song.title}（${song.id}）` }),
        el('p', { className: 'warn', textContent: 'PRIVATE招待者にすぐ反映されます。音源や公式サイトは変更しません。' }),
        ...(readingChanged ? [el('p', { textContent: `よみがな：${readingText || '（未設定に戻す）'}` })] : []),
        ...(lyricsChanged ? [el('pre', { className: 'private-lyrics-preview', textContent: text || '（空の歌詞で上書きします）' })] : [])],
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '保存する', primary: true }]);
      if (answer !== 'go') { password.value = ''; return; }
      if (song !== selected || text !== lyrics.value || readingText !== reading.value.trim() || rev !== catalog.rev) return result('入力内容が変わりました。再確認してください。', 'err');
      privateLyricsBusy = true; sync(); result('保存しています…');
      const credential = password.value; password.value = '';
      try {
        const data = await api('POST', '/api/private/lyrics/save', { adminPassword: credential, id: song.id, rev, ...(lyricsChanged?{lyrics:text}:{}), ...(readingChanged?{reading:readingText}:{}), confirm: true });
        catalog.rev = data.rev; Object.assign(song, data.song);
        if (Array.isArray(data.orderedIds) && data.orderedIds.length === catalog.songs.length && new Set(data.orderedIds).size === catalog.songs.length && data.orderedIds.every(id=>catalog.songs.some(s=>s.id===id))) {
          const byId = new Map(catalog.songs.map(s=>[s.id,s])); catalog.songs = data.orderedIds.map(id=>byId.get(id));
        }
        drawChoices(song.id); selectSong(song); result(`✔ ${song.title}の変更を保存しました。`, 'done');
      } catch (e) { result(`保存できませんでした：${e.message}\n入力は保持しています。競合時は内容を控えてから一覧を再読み込みしてください。`, 'err'); }
      finally { privateLyricsBusy = false; sync(); }
    };
    $('#main').replaceChildren(el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: 'PRIVATE管理' }), 'PRIVATE楽曲の歌詞・よみがな')),
      el('p', { className: 'note', textContent: 'PRIVATE専用歌詞だけを登録します。一般公開歌詞は公式サイト側で管理し、同じ歌詞の再登録は不要です。保存するたびに管理者パスワードが必要です。' }),
      el('div', { className: 'field' }, el('label', { htmlFor: password.id, textContent: '管理者パスワード' }), password, load),
      el('div', { className: 'field' }, el('label', { htmlFor: chooser.id, textContent: 'PRIVATE楽曲' }), chooser, info),
      el('div', { className: 'field' }, el('label', { htmlFor: reading.id, textContent: '曲名のよみがな（任意・PRIVATE表示順のみ）' }), reading, el('p', { className: 'note', textContent: 'かな→英字→数字→読み未設定の漢字・その他。漢字の曲などは必要に応じて読みを入力してください。空欄でも曲は表示されます。' })),
      el('div', { className: 'field' }, el('label', { htmlFor: lyrics.id, textContent: 'PRIVATE専用歌詞（改行・空行は保持）' }), lyrics), saveButton, status);
    $('#main').scrollTop = 0;
    sync();
  }
  window.addEventListener('pagehide', () => clearPrivateLyricsPassword());

  async function openReleaseStatus() {
    if (!await guard()) return;
    clearPrivateLyricsPassword(); current = null; edits = new Map(); privateOpen = 'release'; privateLyricsDirty = false; releaseDirty = false; registrationDirty=false;
    renderLists();
    const labels={all:'すべて',unknown:'未設定・要確認',general:'一般公開',site:'このサイトのみ',private:'PRIVATEのみ'};
    const lyricLabels={unknown:'未設定・要確認',public:'一般公開サイト',private:'PRIVATEのみ',both:'一般公開サイト＋PRIVATE',none:'非公開・未登録'};
    const serviceLabels={spotify:'Spotify','apple-music':'Apple Music',youtube:'YouTube',suno:'Suno',other:'その他'};
    const options=(values)=>Object.entries(values).map(([value,textContent])=>el('option',{value,textContent}));
    const password=el('input',{id:'rs-password',type:'password',autocomplete:'off'});
    clearPrivateLyricsPassword=()=>{password.value='';};
    const loadPrivate=el('button',{type:'button',textContent:'PRIVATE曲一覧も読み込む'});
    const reload=el('button',{type:'button',textContent:'管理情報を再読み込み'});
    const filter=el('select',{id:'rs-filter'},...options(labels)); filter.value='all';
    const search=el('input',{id:'rs-search',type:'search',placeholder:'曲名・曲IDで検索'});
    const counts=el('div',{className:'release-counts'}), table=el('tbody'), editor=el('section',{className:'release-editor'}), result=el('p',{role:'status',ariaLive:'polite'}), inventory=el('p',{className:'note'});
    let data=null, selected=null;
    const show=(text,kind='note')=>{result.textContent=text;result.className=kind;};
    const observed=row=>`公式サイト：${row.site?'掲載あり':'掲載未確認'}／PRIVATE：${row.privatePresent===null?'未取得':row.privatePresent?'登録あり':'未登録'}`;
    const observedLyrics=row=>`公式：${row.publicLyrics?'歌詞あり':'歌詞確認なし'}／PRIVATE：${row.privateLyrics===null?'未取得':row.privateLyrics?'歌詞あり':'歌詞なし'}`;
    function drawRows(){
      if(!data)return;
      counts.replaceChildren(...Object.entries(labels).map(([key,label])=>el('button',{type:'button',ariaPressed:String(filter.value===key),textContent:`${label} ${data.counts[key]}曲`,onclick:()=>{filter.value=key;drawRows();}})));
      const q=search.value.trim().toLowerCase();
      const rows=data.rows.filter(r=>(filter.value==='all'||r.classification===filter.value)&&(!q||`${r.title} ${r.id}`.toLowerCase().includes(q)));
      table.replaceChildren(...rows.map(row=>el('tr',{className:row.id===selected?.id?'selected':''},
        el('td',{},el('button',{type:'button',textContent:row.title,onclick:async()=>{if(!await guard())return;drawEditor(row);drawRows();}}),el('small',{textContent:row.id})),
        el('td',{textContent:labels[row.classification]}),el('td',{textContent:lyricLabels[row.lyricsScope]}),
        el('td',{},el('small',{textContent:observed(row)}),el('small',{textContent:observedLyrics(row)})),
        el('td',{textContent:`${row.links.length}件${row.warnings.length?' ⚠':''}`}),el('td',{textContent:row.registrationState?({draft:'下書き',registered:'下書き',ready:'公開準備完了'}[row.registrationState]+'・未公開'):row.savedOnly?'一覧未確認':row.saved?'記録済':'要確認'}))));
      if(!rows.length)table.replaceChildren(el('tr',{},el('td',{colSpan:6,textContent:'該当する楽曲はありません。'})));
    }
    function drawEditor(row){
      selected=row;releaseDirty=false;
      if(!row){editor.replaceChildren(el('p',{className:'note',textContent:'一覧から曲を選ぶと管理情報を編集できます。'}));return;}
      if(row.registrationState){editor.replaceChildren(el('h3',{textContent:row.title}),el('p',{className:'note',textContent:'新曲の公開準備記録です。実際の公開・音源登録は未実施です。'}),el('button',{type:'button',textContent:'新曲登録画面で編集',onclick:()=>openRegistration(row.id)}));return;}
      const classification=el('select',{id:'rs-class'},...options(Object.fromEntries(Object.entries(labels).filter(([key])=>key!=='all'))));classification.value=row.classification;
      const scope=el('select',{id:'rs-scope'},...options(lyricLabels));scope.value=row.lyricsScope;
      const linksBox=el('div',{className:'release-link-list'});const inputs=[];
      const save=el('button',{type:'button',className:'primary',textContent:'確認して管理情報を保存',disabled:true});
      const value=()=>({classification:classification.value,lyricsScope:scope.value,links:inputs.map(i=>({service:i.service.value,url:i.url.value,...(i.service.value==='other'?{label:i.label.value}:{})}))});
      const changed=()=>{releaseDirty=true;save.disabled=releaseBusy;};
      classification.onchange=scope.onchange=changed;
      function addLink(link={service:'spotify',url:''}){
        const service=el('select',{ariaLabel:'配信先'},...options(serviceLabels));service.value=link.service;
        const url=el('input',{type:'url',placeholder:'https://…',value:link.url,ariaLabel:'配信URL'});
        const label=el('input',{type:'text',placeholder:'その他の配信先名',value:link.label??'',ariaLabel:'その他の配信先名',hidden:link.service!=='other'});
        const entry={service,url,label}; const remove=el('button',{type:'button',textContent:'欄を外す',onclick:()=>{inputs.splice(inputs.indexOf(entry),1);box.remove();changed();}});
        const box=el('div',{className:'release-link-row'},service,url,label,remove);inputs.push(entry);linksBox.append(box);
        service.onchange=()=>{label.hidden=service.value!=='other';changed();};url.oninput=label.oninput=changed;
      }
      row.links.forEach(addLink);
      save.onclick=async()=>{
        if(releaseBusy||!releaseDirty)return;
        const settings=value(), id=row.id, rev=data.rev;
        const answer=await ask('管理情報の保存確認',[el('p',{textContent:`${row.title}（${id}）`}),el('p',{textContent:`公開区分：${labels[settings.classification]}／歌詞：${lyricLabels[settings.lyricsScope]}`}),
          el('pre',{className:'private-lyrics-preview',textContent:settings.links.map(l=>`${serviceLabels[l.service]} ${l.label??''} ${l.url}`).join('\n')||'配信先なし'}),el('p',{className:'warn',textContent:'この記録は管理用です。実際の公開サイト・PRIVATE・配信サービスには反映しません。'})],
          [{value:'cancel',label:'キャンセル'},{value:'go',label:'保存する',primary:true}]);
        if(answer!=='go')return;
        releaseBusy=true;editor.inert=true;save.disabled=true;show('保存しています…');
        try{data=await api('POST','/api/release-status/save',{id,rev,...settings,confirm:true});drawEditor(data.rows.find(r=>r.id===id));drawRows();show('✔ 管理情報をローカル保存しました。公開状態は変わりません。','done');}
        catch(e){show(`保存できませんでした：${e.message} 入力は保持しています。`,'err');}
        finally{releaseBusy=false;editor.inert=false;save.disabled=!releaseDirty;}
      };
      editor.replaceChildren(el('h3',{textContent:`${row.title}（${row.id}）`}),el('p',{className:'note',textContent:`${observed(row)} ／ ${observedLyrics(row)}（ローカル資料・取得時点の情報）`}),
        ...row.warnings.map(w=>el('p',{className:'warn',textContent:w})),
        el('div',{className:'release-fields'},el('div',{className:'field'},el('label',{htmlFor:classification.id,textContent:'公開区分（管理記録）'}),classification),el('div',{className:'field'},el('label',{htmlFor:scope.id,textContent:'歌詞の公開範囲（管理記録）'}),scope)),
        el('p',{className:'note',textContent:'配信先とURL（管理記録。既存の配信リンクを初期表示）'}),linksBox,
        el('button',{type:'button',textContent:'配信先を追加',onclick:()=>{addLink();changed();}}),
        el('p',{className:'note',textContent:row.sourceLinks.length?'公式サイトの既存ソース登録URL：'+row.sourceLinks.map(l=>l.url).join(' ／ '):'公式サイトの既存ソースに配信URLの登録はありません。'}),save);
    }
    async function load(withPrivate=false){
      if(!await guard())return;
      if(withPrivate&&!password.value)return show('管理者パスワードを入力してください。','err');
      const id=selected?.id, body=withPrivate?{adminPassword:password.value}:{};password.value='';
      releaseBusy=true;editor.inert=true;loadPrivate.disabled=reload.disabled=true;show('読み込んでいます…');
      try{data=await api('POST','/api/release-status/list',body);inventory.textContent=data.privateLoaded?'公式サイトのローカル資料と取得時点のPRIVATE一覧を照合済み。':'PRIVATE未取得：一覧・集計は公式サイトと保存済み記録のみ（全楽曲の確定数ではありません）。';drawEditor(data.rows.find(r=>r.id===id));drawRows();show('一覧を読み込みました。');}
      catch(e){show(`読み込めませんでした：${e.message}`,'err');}
      finally{releaseBusy=false;editor.inert=false;loadPrivate.disabled=reload.disabled=false;}
    }
    loadPrivate.onclick=()=>load(true);reload.onclick=()=>load(false);filter.onchange=drawRows;search.oninput=drawRows;
    $('#main').replaceChildren(el('div',{className:'edit-head'},el('h2',{},el('span',{className:'kind',textContent:'楽曲管理'}),'全楽曲の公開状況')),
      el('p',{className:'note',textContent:'管理記録と確認できた実際の掲載情報を分けて表示します。未設定の曲は自動分類せず、音源・公開ページ・配信サービスを変更しません。'}),
      el('div',{className:'field'},el('label',{htmlFor:password.id,textContent:'PRIVATE一覧取得用 管理者パスワード'}),password,loadPrivate,reload),inventory,counts,
      el('div',{className:'release-fields'},el('div',{className:'field'},el('label',{htmlFor:filter.id,textContent:'公開区分で絞り込み'}),filter),el('div',{className:'field'},el('label',{htmlFor:search.id,textContent:'検索'}),search)),
      el('div',{className:'release-table-wrap'},el('table',{className:'release-table'},el('thead',{},el('tr',{},...['楽曲名・ID','公開区分','歌詞範囲','確認できた掲載・歌詞','配信先','記録状態'].map(textContent=>el('th',{textContent})))),table)),editor,result);
    $('#main').scrollTop=0;await load();
  }

  async function openRegistration(id=null) {
    if(!await guard())return;
    clearPrivateLyricsPassword();current=null;edits=new Map();privateOpen='registration';registrationId=id;privateLyricsDirty=releaseDirty=registrationDirty=false;renderLists();
    const classLabels={unknown:'未設定・要確認',general:'一般公開',site:'このサイトのみ',private:'PRIVATEのみ'},scopeLabels={public:'一般公開',private:'PRIVATEのみ',hidden:'非表示'},stateLabels={draft:'下書き',ready:'公開準備完了'};   // 公開済み is shown from the real state, never chosen (2026-11-24)
    const empty={title:'',reading:'',artist:'PIP POPPER',lyrics:'',impression:'',classification:'unknown',lyricsScope:'hidden',impressionScope:'hidden',channels:{hp:false,listen:false,private:false},state:'draft',links:[],memo:''};
    let saved=null,pendingImage=null,history=[],previewData=null,publication={state:'not-adopted'};const liveNote=el('div',{className:'live-note',hidden:true});
    const pubLabels={'not-adopted':'未公開（公式HPへ未取り込み）',adopted:'公式HPへ取り込み済み・まだ公開していない（画面上部の「公開する」で公開）',published:'公式HPで公開済み',withdrawn:'取り込みを取り消し済み（未公開）'};
    const controls={}, status=el('p',{role:'status',ariaLive:'polite',className:'note'}), idLabel=el('p',{className:'note'}), form=el('section',{}), imagePreview=el('img',{className:'registration-jacket',alt:'登録するジャケット',hidden:true}), imageInput=el('input',{type:'file',accept:'image/png,image/jpeg',id:'reg-image'}), previewBox=el('section',{className:'registration-preview'}), historySelect=el('select',{id:'reg-history'});
    const show=(message,kind='note')=>{status.textContent=message;status.className=kind;};
    const dirty=()=>{registrationDirty=true;previewData=null;previewBox.replaceChildren(el('p',{textContent:'保存してから掲載イメージを確認してください。'}));};
    const input=(key,label,type='text',maxLength=100)=>{const tag=type==='textarea'?'textarea':'input';const node=el(tag,{id:`reg-${key}`,maxLength,...(type==='textarea'?{className:key==='lyrics'?'lyrics':''}:{type})});node.oninput=dirty;controls[key]=node;return el('div',{className:'field'},el('label',{htmlFor:node.id,textContent:label}),node);};
    const select=(key,label,labels)=>{const node=el('select',{id:`reg-${key}`},...Object.entries(labels).map(([value,textContent])=>el('option',{value,textContent,disabled:value==='published'})));node.onchange=dirty;controls[key]=node;return el('div',{className:'field'},el('label',{htmlFor:node.id,textContent:label}),node);};
    const check=(key,label)=>{const node=el('input',{type:'checkbox',id:`reg-${key}`});node.onchange=dirty;controls[key]=node;return el('div',{className:'field check'},node,el('label',{htmlFor:node.id,textContent:label}));};
    const title=input('title','曲名（必須）','text',150),reading=input('reading','曲名のよみがな（任意）','text',100),artist=input('artist','アーティスト名','text',100),lyrics=input('lyrics','歌詞全文','textarea',100000),impression=input('impression','AIの感想','textarea',100000),classification=select('classification','公開区分',classLabels),lyricScope=select('lyricsScope','歌詞の公開範囲',scopeLabels),impressionScope=select('impressionScope','AIの感想の公開範囲',scopeLabels),recordState=select('state','登録状態',stateLabels),hp=check('hp','一般公開HPへの掲載を許可'),listen=check('listen','一般視聴ページへの掲載を許可'),privateCheck=check('private','PRIVATEへの掲載を許可'),urls=input('urls','外部配信先URL（任意・1行1件）','textarea',40000),memo=input('memo','公開メモ（管理用・非公開）','textarea',10000);
    function syncChannels(){const allowed=['general','site'].includes(controls.classification.value);controls.hp.disabled=controls.listen.disabled=!allowed;if(!allowed){controls.hp.checked=false;controls.listen.checked=false;}}
    controls.classification.onchange=()=>{syncChannels();dirty();};
    function fill(response){saved=response?.record??null;publication=response?.publication??{state:'not-adopted'};pendingImage=null;previewData=null;history=response?.history??[];const r=saved??empty;registrationId=saved?.id??null;
      for(const key of ['title','reading','artist','lyrics','impression','classification','lyricsScope','impressionScope','state','memo'])controls[key].value=r[key];if(!['draft','ready'].includes(controls.state.value))controls.state.value='draft';   // an old 登録済み is shown as 下書き
      for(const a of ['hp','listen','private'])controls[a].checked=r.channels[a];controls.urls.value=r.links.map(l=>l.url).join('\n');syncChannels();
      idLabel.textContent=saved?`楽曲ID：${saved.id} ／ 実際の公開：${pubLabels[publication.state]??'未公開'}${publication.slug?`（tracks/${publication.slug}）`:''} ／ 音源：未登録`:'楽曲ID：初回保存時に自動発行 ／ 実際の公開：未公開 ／ 音源：未登録';
      const live=['adopted','published'].includes(publication.state);controls.state.disabled=live;if(live)controls.state.value='ready';
      liveNote.hidden=!live;liveNote.replaceChildren(...(live?[el('span',{textContent:publication.state==='published'?'この曲は公式サイトで公開中です。公開中の内容（曲名・歌詞・感想など）を直すときは、公開中の曲を開いてください。この登録画面での変更は公式サイトには反映されません。登録状態は「公開準備完了」のままです。':'この曲は公式HPへ取り込み済みです（まだ公開していません）。画面上部の「公開する」で公開します。'}),...(publication.slug?[el('button',{type:'button',textContent:'公開中の曲を開く',onclick:()=>openItem('track',publication.slug)})]:[])]:[]));
      paintAdopt();
      imagePreview.hidden=!response?.thumbnail;if(response?.thumbnail)imagePreview.src=response.thumbnail;else imagePreview.removeAttribute?.('src');imageInput.value='';
      historySelect.replaceChildren(...history.filter(h=>h.rev!==saved?.rev).map(h=>el('option',{value:h.rev,textContent:`${new Date(h.updatedAt).toLocaleString('ja-JP')}　${h.title}`})));historySelect.disabled=history.length<2;registrationDirty=false;renderLists();
    }
    const values=()=>({title:controls.title.value,reading:controls.reading.value,artist:controls.artist.value,lyrics:controls.lyrics.value,impression:controls.impression.value,classification:controls.classification.value,lyricsScope:controls.lyricsScope.value,impressionScope:controls.impressionScope.value,state:controls.state.value,channels:{hp:controls.hp.checked,listen:controls.listen.checked,private:controls.private.checked},urls:controls.urls.value.split('\n').map(x=>x.trim()).filter(Boolean),memo:controls.memo.value});
    async function imageData(file){
      if(!file||file.size>12*1024*1024)throw new Error('PNG/JPEGの画像は12MB以内にしてください。');
      const mime=file.type||(/\.png$/i.test(file.name)?'image/png':/\.jpe?g$/i.test(file.name)?'image/jpeg':'');if(!['image/png','image/jpeg'].includes(mime))throw new Error('PNGまたはJPEGを選択してください。');
      const original=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('画像を読み込めません。'));r.readAsDataURL(file);});
      const url=URL.createObjectURL(file);try{const img=await new Promise((resolve,reject)=>{const x=new Image();x.onload=()=>resolve(x);x.onerror=()=>reject(new Error('画像を読み込めません。'));x.src=url;});
        if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>40e6)throw new Error('画像の大きさを確認してください。');
        const render=(width,quality)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=Math.max(1,Math.round(img.naturalHeight*width/img.naturalWidth));if(canvas.height>4000)throw new Error('画像の縦横比を確認してください。');const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);return {mime:'image/jpeg',data:canvas.toDataURL('image/jpeg',quality).split(',')[1]};};
        return {original:{mime,data:original},web:render(Math.min(1254,img.naturalWidth),.86),thumb:render(640,.84)};
      }finally{URL.revokeObjectURL(url);}
    }
    imageInput.onchange=async()=>{const f=imageInput.files?.[0];if(!f)return;registrationBusy=true;form.inert=true;show('画像を準備しています…');try{pendingImage=await imageData(f);imagePreview.src=`data:image/jpeg;base64,${pendingImage.thumb.data}`;imagePreview.hidden=false;dirty();show('画像を準備しました。保存すると差し替わります。');}catch(e){show(e.message,'err');}finally{registrationBusy=false;form.inert=false;}};
    const refreshRegistrationList=async()=>{state.registrations=(await api('POST','/api/song-registration/list',{})).songs;renderLists();};
    const saveButton=el('button',{type:'button',className:'primary',textContent:'確認して保存',onclick:async()=>{
      if(registrationBusy)return;if(saved&&!registrationDirty)return show('変更はありません。');const f=values();if(!f.title.trim())return show('曲名を入力してください。','err');
      const answer=await ask('新曲登録の保存確認',[el('p',{textContent:`${f.title}（${saved?.id??'新規IDを発行'}）`}),el('p',{textContent:`${classLabels[f.classification]}／${stateLabels[f.state]}／歌詞：${scopeLabels[f.lyricsScope]}／AIの感想：${scopeLabels[f.impressionScope]}`}),el('p',{className:'warn',textContent:'この保存は非公開の掲載準備記録です。本番公開・音源アップロードは行いません。'})],[{value:'cancel',label:'キャンセル'},{value:'go',label:'保存する',primary:true}]);if(answer!=='go')return;
      registrationBusy=true;form.inert=true;show('保存しています…');try{const result=await api('POST','/api/song-registration/save',{id:saved?.id,rev:saved?.rev,fields:f,image:pendingImage,confirm:true});fill(result);previewBox.replaceChildren(el('p',{textContent:'保存しました。掲載先を選んで確認できます。'}));await refreshRegistrationList();show('✔ 登録を保存しました。まだ公開されていません。','done');}catch(e){show(`保存できませんでした：${e.message}`,'err');}finally{registrationBusy=false;form.inert=false;}
    }});
    const previewMode=el('select',{id:'reg-preview-mode'},...Object.entries({hp:'一般公開HP',listen:'一般視聴ページ',private:'PRIVATE鑑賞ページ'}).map(([value,textContent])=>el('option',{value,textContent})));previewMode.value='hp';
    const width=el('select',{id:'reg-preview-width'},el('option',{value:'pc',textContent:'PC表示'}),el('option',{value:'phone',textContent:'スマートフォン相当'}));width.value='pc';
    function paintPreview(){if(!previewData)return;const p=previewData;previewBox.className=`registration-preview${width.value==='phone'?' phone':''}`;if(!p.visible){previewBox.replaceChildren(el('p',{className:'note',textContent:p.message}));return;}const audience={hp:'一般公開HP',listen:'一般視聴',private:'PRIVATE鑑賞'}[previewMode.value];const card=el('article',{className:'reg-candidate '+(previewMode.value==='hp'?'hp':'listen')},el('p',{className:'reg-candidate-kicker',textContent:`PIP POPPER ／ ${audience} ／ 未公開の掲載候補`}),...(previewMode.value!=='hp'?[el('div',{className:'reg-candidate-player'},el('button',{type:'button',disabled:true,textContent:'▶ 再生'}),el('span',{textContent:'音源未登録・再生不可'}))]:[]),el('div',{className:'reg-candidate-main'},p.thumbnail?el('img',{src:p.thumbnail,alt:'ジャケット'}):el('div',{className:'reg-cover-fallback',textContent:'ジャケット未登録'}),el('div',{},el('h2',{textContent:p.title}),el('p',{textContent:p.artist}),...(previewMode.value==='hp'?[el('p',{className:'warn',textContent:'音源未登録'} )]:[]))),...(p.lyrics?[el('h3',{textContent:'歌詞'}),el('div',{className:'reg-candidate-text',textContent:p.lyrics})]:[]),...(p.impression?[el('h3',{textContent:'AIの感想'}),el('div',{className:'reg-candidate-text',textContent:p.impression})]:[]),...(p.links.length?[el('p',{className:'note',textContent:p.links.map(l=>l.url).join('\n')})]:[]));previewBox.replaceChildren(card);}
    width.onchange=paintPreview;previewMode.onchange=()=>{previewData=null;previewBox.replaceChildren(el('p',{textContent:'この掲載先のプレビューを表示してください。'}));};
    const previewButton=el('button',{type:'button',textContent:'掲載イメージを見る',onclick:async()=>{if(!saved||registrationDirty)return show('先に登録内容を保存してください。','err');registrationBusy=true;form.inert=true;try{previewData=await api('POST','/api/song-registration/preview',{id:saved.id,audience:previewMode.value});paintPreview();show('掲載許可に従ったプレビューです。実際の公開ではありません。');}catch(e){show(e.message,'err');}finally{registrationBusy=false;form.inert=false;}}});
    const restoreButton=el('button',{type:'button',textContent:'以前の保存版を復元',onclick:async()=>{if(!saved||!historySelect.value||registrationDirty)return show('保存済みの版を選んでください。未保存の入力は先に保存してください。','err');const answer=await ask('以前の保存版を復元します',el('p',{textContent:'現在の内容も履歴に残したまま、新しい保存版として復元します。'}),[{value:'cancel',label:'キャンセル'},{value:'go',label:'復元する',primary:true}]);if(answer!=='go')return;registrationBusy=true;form.inert=true;try{fill(await api('POST','/api/song-registration/restore',{id:saved.id,rev:saved.rev,restoreRev:historySelect.value,confirm:true}));await refreshRegistrationList();previewData=null;previewBox.replaceChildren(el('p',{textContent:'復元した内容を確認してください。'}));show('✔ 復元しました。','done');}catch(e){show(e.message,'err');}finally{registrationBusy=false;form.inert=false;}}});
    const slugInput=el('input',{type:'text',id:'reg-slug',maxLength:60,placeholder:'例：we-love-music',spellcheck:false,autocomplete:'off'}),adoptNote=el('p',{className:'note'});
    const adoptButton=el('button',{type:'button',textContent:'公式HPの掲載データへ取り込む',onclick:async()=>{
      if(registrationBusy)return;if(!saved||registrationDirty)return show('先に登録内容を保存してください。','err');
      const slug=slugInput.value.trim();if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug))return show('ページのURL名は英小文字・数字・ハイフンで入力してください（例：we-love-music）。','err');
      const answer=await ask('公式HPの掲載データへ取り込みます',[el('p',{textContent:`「${saved.title}」を tracks/${slug} として公式HPの掲載データに加えます。`}),el('p',{textContent:`取り込むもの：曲名・アーティスト名${saved.reading?'・よみがな':''}${saved.lyricsScope==='public'?'・歌詞（一般公開）':''}${saved.impressionScope==='public'?'・AIの感想（一般公開）':''}・ジャケット画像`}),el('p',{className:'warn',textContent:'まだ公開されません。プレビューで確認し、画面上部の「公開する」を押したときに公開されます。公開前なら「変更を破棄」で取り消せます。'})],[{value:'cancel',label:'キャンセル'},{value:'go',label:'取り込む',primary:true}]);if(answer!=='go')return;
      registrationBusy=true;form.inert=true;show('取り込んでいます…');try{fill(await api('POST','/api/song-registration/adopt',{id:saved.id,rev:saved.rev,slug,confirm:true}));await refresh();show('✔ 取り込みました。まだ公開されていません。「プレビュー」で確認してから「公開する」を押してください。','done');}catch(e){show(`取り込めませんでした：${e.message}`,'err');}finally{registrationBusy=false;form.inert=false;}
    }});
    function paintAdopt(){
      const ready=saved&&saved.state==='ready'&&saved.channels.hp&&['general','site'].includes(saved.classification)&&saved.image;const done=['adopted','published'].includes(publication.state);
      adoptButton.disabled=slugInput.disabled=!ready||done;if(publication.slug&&!slugInput.value)slugInput.value=publication.slug;
      adoptNote.textContent=done?`取り込み済み（tracks/${publication.slug}）。この後の修正は、左の「曲」の一覧から行ってください。`:ready?'ページのURL名を決めて取り込むと、公式HPの掲載データ（tracks）に加わります。公開は画面上部の「公開する」で行います。':'取り込めるのは「公開準備完了」で保存し、公式HPへの掲載を許可し、ジャケットを登録した曲です。';
    }
    form.replaceChildren(idLabel,liveNote,el('div',{className:'release-fields'},title,reading),artist,el('div',{className:'field'},el('label',{htmlFor:imageInput.id,textContent:'ジャケット画像（PNG/JPEG・任意）'}),imageInput,imagePreview),lyrics,impression,classification,el('div',{className:'release-fields'},lyricScope,impressionScope),hp,listen,privateCheck,urls,memo,recordState,saveButton,el('h3',{textContent:'掲載イメージ（保存後）'}),el('div',{className:'registration-actions'},previewMode,width,previewButton),previewBox,el('h3',{textContent:'保存履歴・復元'}),el('div',{className:'registration-actions'},historySelect,restoreButton),el('h3',{textContent:'公式HPへの取り込み（公開前の最終段階）'}),adoptNote,el('div',{className:'field'},el('label',{htmlFor:'reg-slug',textContent:'ページのURL名（英小文字・数字・ハイフン。公開後は変えない）'}),slugInput),el('div',{className:'registration-actions'},adoptButton));
    $('#main').replaceChildren(el('div',{className:'edit-head'},el('h2',{},el('span',{className:'kind',textContent:'楽曲管理'}),'新曲を登録')),el('p',{className:'note',textContent:'完成した画像・歌詞・AIの感想を登録し、公開先ごとの掲載準備を行います。ここから本番公開はされません。'}),form,status);$('#main').scrollTop=0;
    registrationBusy=true;form.inert=true;let loadFailed=false;try{fill(id?await api('POST','/api/song-registration/get',{id}):null);}catch(e){loadFailed=true;show(e.message,'err');}finally{registrationBusy=false;form.inert=loadFailed;}
  }

  async function save() {
    if (!current || !edits.size) return;
    const display = edits.get('display'), jacket = edits.get('jacket');
    const changes = [...edits].filter(([i]) => i !== 'display' && i !== 'jacket').map(([i, value]) => ({ path: current.fields[i].path, value }));
    try {
      await api('POST', '/api/item', { type: current.type, id: current.id, rev: current.rev, changes, ...(display ? { display } : {}), ...(jacket ? { jacket } : {}) });
      edits = new Map();
      toast('保存しました（まだ公開されていません）。プレビューで確認できます。');
      const { type, id } = current; current = null;
      await refresh(); await openItem(type, id);
    } catch (e) { toast(e.message, 'bad', 9000); }
  }

  async function preview() {
    if (unsaved() && (await ask('保存していない入力があります', el('p', { textContent: 'プレビューには保存した内容だけが表示されます。先に保存しますか。' }),
      [{ value: 'cancel', label: 'キャンセル' }, { value: 'save', label: '保存してプレビュー', primary: true }])) === 'save') await save();
    const w = window.open('about:blank', '_blank');
    if (w) w.document.body.textContent = 'プレビューを作っています…（数秒かかります）';
    try {
      const r = await api('POST', '/api/preview', { type: current?.type ?? 'site', id: current?.id ?? 'home' });
      if (w) w.location = r.url; else location.href = r.url;
    } catch (e) { if (w) w.close(); toast(e.message, 'bad', 9000); }
  }

  const clip = s => (s.length > 160 ? `${s.slice(0, 160)}…` : s) || '（空）';
  function changeList(items) {
    return el('ul', { className: 'changes' }, ...items.map(c => el('li', {},
      el('div', { className: 'what', textContent: `${c.item} — ${c.label}` }),
      el('div', { className: 'before', textContent: clip(String(c.before)) }),
      el('div', { className: 'after', textContent: clip(String(c.after)) }))));
  }

  $('#btn-publish').onclick = async () => {
    if (!await guard()) return;
    await refresh();
    if (!state.changes.items.length && state.pendingPush) {
      const ok = await ask('GitHubへの送信をやり直します', el('p', { textContent: `前回送信できなかった保存点（${state.pendingPush} 件）を、公式サイトへ送信します。` }),
        [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '送信する', primary: true }]);
      if (ok !== 'go') return;
      try { await api('POST', '/api/push-pending', { confirm: true }); toast('送信しました。1〜3分で公式サイトに反映されます。'); }
      catch (e) { toast(e.message, 'bad', 12000); }
      await refresh(); return checkPages();
    }
    let problems = [];
    try { problems = (await api('POST', '/api/check-publish')).problems; } catch (e) { problems = [e.message]; }
    const target = el('div', { className: 'target' },
      el('div', { textContent: '公開先：公式サイト ' + state.liveUrl }),
      el('div', { textContent: `GitHub：pip-popper/pip-popper.github.io（${state.branch} ブランチ）` }),
      el('div', { textContent: `変更するデータ：${state.changes.files.join('、')}（ページは公開時に作り直します）` }));
    const summary = el('input', { type: 'text', value: [...new Set(state.changes.items.map(c => c.item))].join('、').slice(0, 100), ariaLabel: '変更の説明（履歴に残ります）' });
    const body = [target, el('p', { textContent: `次の ${state.changes.items.length} か所が公開されます。` }), changeList(state.changes.items),
      el('label', { textContent: '履歴に残す説明：' }), summary,
      ...(problems.length ? [el('p', { className: 'err', textContent: '今は公開できません：\n' + problems.join('\n') })] : [el('p', { className: 'warn', textContent: '公開すると、誰でも見られる公式サイトが変わります。取り消しは「公開履歴・取り消し」からできます。' })])];
    const ans = await ask('公開する内容の確認', body, [{ value: 'cancel', label: 'キャンセル' }, ...(problems.length ? [] : [{ value: 'go', label: '公開する', primary: true }])]);
    if (ans !== 'go') return;
    $('#status').textContent = '公開しています…（ページを作り直して送信中。1分ほどかかることがあります）';
    try {
      const r = await api('POST', '/api/publish', { confirm: true, summary: summary.value });
      await ask('公開しました', [el('p', { textContent: `保存点 ${r.head} を公式サイトへ送信しました。1〜3分で反映されます。` }), el('p', { className: 'note', textContent: '確認するときは公式サイトを開き、Ctrl＋F5 で再読み込みしてください。GitHub側の配信が失敗したときは、画面上部に表示されます。' })],
        [{ value: 'cancel', label: '閉じる' }]);
    } catch (e) { toast(e.message, 'bad', 15000); }
    await reloadScreen();
    checkPages();
  };

  $('#btn-redeploy').onclick = async () => {
    if (!await guard()) return;
    const ans = await ask('公式サイトへ送り直します', [el('p', { textContent: `GitHub側で、公式サイトへの配信が失敗しています（保存点 ${pages?.head ?? ''}）。公開した内容はGitHubに保存されています。` }),
      el('p', { textContent: '内容は変えずに、同じものをもう一度公式サイトへ送ります（履歴に「公式サイトへの送り直し」が1件増えます）。' })],
      [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '送り直す', primary: true }]);
    if (ans !== 'go') return;
    try { const r = await api('POST', '/api/redeploy', { confirm: true }); toast(`送り直しました（保存点 ${r.head}）。1〜3分で公式サイトに反映されます。`); }
    catch (e) { toast(e.message, 'bad', 15000); }
    await refresh();
    checkPages();
  };

  $('#btn-discard').onclick = async () => {
    if (!await guard()) return;
    await refresh();
    const ans = await ask('公開していない変更を破棄します', [el('p', { className: 'warn', textContent: `次の ${state.changes.items.length} か所を、最後に公開した状態に戻します。この操作は取り消せません。` }), changeList(state.changes.items)],
      [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '破棄する' }]);
    if (ans !== 'go') return;
    try { const r = await api('POST', '/api/discard', { confirm: true }); toast(`${r.count} 個のファイルを元に戻しました。`); }
    catch (e) { toast(e.message, 'bad'); }
    edits = new Map(); const c = current; current = null; await refresh(); if (c) openItem(c.type, c.id);
  };

  $('#btn-history').onclick = async () => {
    if (!await guard()) return;
    let h; try { h = (await api('GET', '/api/history')).history; } catch (e) { return toast(e.message, 'bad'); }
    let chosen = null;
    const rows = h.map(x => el('tr', {},
      el('td', { className: 'muted', textContent: x.date }),
      el('td', { textContent: x.subject }),
      el('td', { className: 'muted', textContent: x.published ? '公開済み' : '未送信' }),
      el('td', {}, x.undoable ? el('button', { type: 'button', textContent: '取り消す', onclick: () => { chosen = x; $('#dlg').close('undo'); } }) : el('span', { className: 'muted', textContent: x.byTool ? '' : '（AI等の作業）' }))));
    const ans = await ask('公開履歴', [el('p', { className: 'note', textContent: '管理ツールで公開した変更は「取り消す」で元に戻せます。取り消した内容は「公開していない変更」に入るので、プレビューで確認してから公開してください。AI等の作業による変更はここでは取り消せません。' }),
      el('table', { className: 'hist' }, el('tbody', {}, ...rows))], [{ value: 'cancel', label: '閉じる' }]);
    if (ans !== 'undo' || !chosen) return;
    const ok = await ask('この公開を取り消しますか', el('p', { textContent: `「${chosen.subject}」（${chosen.date}）で変更した文字を、変更前に戻します。まだ公開はされません。` }),
      [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '取り消す', primary: true }]);
    if (ok !== 'go') return;
    try { const r = await api('POST', '/api/undo', { sha: chosen.sha }); toast(r.message, 'ok', 9000); }
    catch (e) { toast(e.message, 'bad', 9000); }
    current = null; await refresh();
  };

  $('#btn-quit').onclick = async () => {
    if (!await guard()) return;
    const ans = await ask('管理ツールを終了します', el('p', { textContent: state?.changes.items.length ? `公開していない変更が ${state.changes.items.length} 件ありますが、保存済みなので次回また公開できます。` : '終了してよろしいですか。' }),
      [{ value: 'cancel', label: 'キャンセル' }, { value: 'go', label: '終了する', primary: true }]);
    if (ans !== 'go') return;
    try { await api('POST', '/api/quit'); } catch {}
    document.body.replaceChildren(el('p', { className: 'welcome', style: 'padding:40px', textContent: '管理ツールを終了しました。このタブは閉じてかまいません。' }));
  };
  $('#filter').addEventListener('input', () => state && renderLists());

  if (!token) { $('#status').textContent = '起動用のファイル「PIP POPPER管理ツールを起動.bat」から開いてください。'; return; }
  refresh().then(() => checkPages()).catch(e => { $('#status').textContent = e.message; });
})();
