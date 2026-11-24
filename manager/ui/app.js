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
    $('#dlg-actions').replaceChildren(...buttons.map(b => el('button', { value: b.value, textContent: b.label, className: b.primary ? 'primary' : '' })));
    return new Promise(res => {
      d.onclose = () => res(d.returnValue || 'cancel');
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
    renderLists();
  }
  function renderLists() {
    const q = $('#filter').value.trim().toLowerCase();
    const changedFiles = new Set(state.changes.files);
    const mark = it => {
      if (it.type === 'track') return changedFiles.has(`tracks/${it.id}/track.json`);
      if (it.type === 'site') return changedFiles.has('content/site.json');
      return state.changes.items.some(c => c.item === `アルバム『${it.title}』`);
    };
    const group = (title, items) => {
      const shown = items.filter(it => !q || `${it.title} ${it.id}`.toLowerCase().includes(q));
      if (!shown.length) return [];
      return [el('h2', { textContent: title }), el('ul', {}, ...shown.map(it => el('li', {}, el('button', {
        type: 'button', ariaCurrent: String(!!current && current.type === it.type && current.id === it.id),
        onclick: () => openItem(it.type, it.id),
      }, el('span', { textContent: `${mark(it) ? '● ' : ''}${it.title}` }), el('span', { className: 'yr', textContent: it.year ?? '' })))))];
    };
    $('#lists').replaceChildren(...group('楽曲', state.list.tracks), ...group('HISTORY（アルバム）', state.list.history),
      ...group('その他の作品', state.list.other), ...group('サイトの文言', state.list.site),
      ...(q?[]:[el('h2',{textContent:'新曲掲載準備'}),el('ul',{},el('li',{},el('button',{type:'button',ariaCurrent:String(privateOpen==='registration'&&!registrationId),onclick:()=>openRegistration()},el('span',{textContent:'＋ 新曲を登録'}))))]),
      ...((state.registrations??[]).filter(r=>!q||`${r.title} ${r.id}`.toLowerCase().includes(q)).length?[el('h2',{textContent:'登録中の楽曲（未公開）'}),el('ul',{},...(state.registrations??[]).filter(r=>!q||`${r.title} ${r.id}`.toLowerCase().includes(q)).map(r=>el('li',{},el('button',{type:'button',ariaCurrent:String(privateOpen==='registration'&&registrationId===r.id),onclick:()=>openRegistration(r.id)},el('span',{textContent:r.title})))) )]:[]),
      ...(q ? [] : [el('h2', { textContent: '楽曲公開状況' }), el('ul', {}, el('li', {}, el('button', { type: 'button', ariaCurrent: String(privateOpen === 'release'), onclick: openReleaseStatus }, el('span', { textContent: '全楽曲の公開状況' }))))]),
      ...(q ? [] : [el('h2', { textContent: 'PRIVATE管理' }), el('ul', {},
        el('li', {}, el('button', { type: 'button', ariaCurrent: String(privateOpen === 'lyrics'), onclick: openPrivateLyrics }, el('span', { textContent: 'PRIVATE楽曲の歌詞・よみがな' }))),
        el('li', {}, el('button', { type: 'button', ariaCurrent: String(privateOpen === 'password'), onclick: openPrivate }, el('span', { textContent: 'PRIVATEのパスワード' }))))]),
      ...(q ? [] : [el('h2', { textContent: '固定（変更はAIに依頼）' }), el('ul', { className: 'fixed' }, ...FIXED.map(([t, why]) => el('li', { title: why }, el('span', { textContent: t }), el('small', { textContent: why }))))]));
  }
  // what this tool does not change: kept fixed, ask an AI (Claude Code / ChatGPT Work) when a change is really needed
  const FIXED = [
    ['ページの構成・デザイン', 'レイアウト、色、文字の大きさ、動き（演出）'],
    ['アルバムの特設デザイン・画像', '作品ごとの世界観。ジャケット・背景の画像'],
    ['メニュー・ボタン・欄の名前', '「最新楽曲」「楽曲一覧」「AIの感想」など'],
    ['メッセージの送信フォーム', '入力欄の名前・送信の仕組み'],
    ['曲・アルバムの追加・削除・並び順', '管理ツール v2 で対応予定'],
    ['曲の公開日・掲載順', '「最新楽曲」の選ばれ方に関わるため'],
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
      const box = el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: f.label }, ...(f.required ? [el('span', { className: 'req', textContent: '（必須）' })] : [])), input);
      input.addEventListener('input', () => {
        const v = input.value.replace(/\r\n?/g, '\n');
        if (v === f.value) edits.delete(i); else edits.set(i, v);
        box.classList.toggle('changed', edits.has(i));
        saveBtn.disabled = !edits.size;
        unsavedEl.textContent = edits.size ? `未保存の入力 ${edits.size} 件` : '';
      });
      return box;
    });
    const tip = el('p', { className: 'note', textContent: type === 'album' ? '作品のデザイン・画像・項目の数は変わりません。文字だけを直せます。改行はそのまま表示に反映されない箇所があります（プレビューで確認してください）。' : '文字だけを直せます。デザインは変わりません。' });
    $('#main').replaceChildren(head, tip, ...fields);
    $('#main').scrollTop = 0;
  }

  // ── PRIVATE: invitee password. Typed passwords are cleared when the work ends (success or not) and never stored. ──
  let privateOpen = false;
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
        el('td',{textContent:`${row.links.length}件${row.warnings.length?' ⚠':''}`}),el('td',{textContent:row.registrationState?({draft:'下書き',registered:'登録済み',ready:'公開準備完了'}[row.registrationState]+'・未公開'):row.savedOnly?'一覧未確認':row.saved?'記録済':'要確認'}))));
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
    const classLabels={unknown:'未設定・要確認',general:'一般公開',site:'このサイトのみ',private:'PRIVATEのみ'},scopeLabels={public:'一般公開',private:'PRIVATEのみ',hidden:'非表示'},stateLabels={draft:'下書き',registered:'登録済み',ready:'公開準備完了',published:'公開済み（実反映確認後のみ）'};
    const empty={title:'',reading:'',artist:'PIP POPPER',lyrics:'',impression:'',classification:'unknown',lyricsScope:'hidden',impressionScope:'hidden',channels:{hp:false,listen:false,private:false},state:'draft',links:[],memo:''};
    let saved=null,pendingImage=null,history=[],previewData=null,publication={state:'not-adopted'};
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
      for(const key of ['title','reading','artist','lyrics','impression','classification','lyricsScope','impressionScope','state','memo'])controls[key].value=r[key];
      for(const a of ['hp','listen','private'])controls[a].checked=r.channels[a];controls.urls.value=r.links.map(l=>l.url).join('\n');syncChannels();
      idLabel.textContent=saved?`楽曲ID：${saved.id} ／ 実際の公開：${pubLabels[publication.state]??'未公開'}${publication.slug?`（tracks/${publication.slug}）`:''} ／ 音源：未登録`:'楽曲ID：初回保存時に自動発行 ／ 実際の公開：未公開 ／ 音源：未登録';
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
    form.replaceChildren(idLabel,el('div',{className:'release-fields'},title,reading),artist,el('div',{className:'field'},el('label',{htmlFor:imageInput.id,textContent:'ジャケット画像（PNG/JPEG・任意）'}),imageInput,imagePreview),lyrics,impression,classification,el('div',{className:'release-fields'},lyricScope,impressionScope),hp,listen,privateCheck,urls,memo,recordState,saveButton,el('h3',{textContent:'掲載イメージ（保存後）'}),el('div',{className:'registration-actions'},previewMode,width,previewButton),previewBox,el('h3',{textContent:'保存履歴・復元'}),el('div',{className:'registration-actions'},historySelect,restoreButton),el('h3',{textContent:'公式HPへの取り込み（公開前の最終段階）'}),adoptNote,el('div',{className:'field'},el('label',{htmlFor:'reg-slug',textContent:'ページのURL名（英小文字・数字・ハイフン。公開後は変えない）'}),slugInput),el('div',{className:'registration-actions'},adoptButton));
    $('#main').replaceChildren(el('div',{className:'edit-head'},el('h2',{},el('span',{className:'kind',textContent:'楽曲管理'}),'新曲を登録')),el('p',{className:'note',textContent:'完成した画像・歌詞・AIの感想を登録し、公開先ごとの掲載準備を行います。ここから本番公開はされません。'}),form,status);$('#main').scrollTop=0;
    registrationBusy=true;form.inert=true;let loadFailed=false;try{fill(id?await api('POST','/api/song-registration/get',{id}):null);}catch(e){loadFailed=true;show(e.message,'err');}finally{registrationBusy=false;form.inert=loadFailed;}
  }

  async function save() {
    if (!current || !edits.size) return;
    const changes = [...edits].map(([i, value]) => ({ path: current.fields[i].path, value }));
    try {
      await api('POST', '/api/item', { type: current.type, id: current.id, rev: current.rev, changes });
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
      return refresh();
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
      await ask('公開しました', [el('p', { textContent: `保存点 ${r.head} を公式サイトへ送信しました。1〜3分で反映されます。` }), el('p', { className: 'note', textContent: '確認するときは公式サイトを開き、Ctrl＋F5 で再読み込みしてください。' })],
        [{ value: 'cancel', label: '閉じる' }]);
    } catch (e) { toast(e.message, 'bad', 15000); }
    current = null; await refresh();
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
  refresh().catch(e => { $('#status').textContent = e.message; });
})();
