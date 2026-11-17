// PIP POPPER PRIVATE — administrator screen. Talks only to /admin/api/* on this site.
(() => {
  const $ = id => document.getElementById(id);
  const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);
  const state = { rev: null, songs: [], removed: [], maxUpload: 50 * 1048576, busy: false };
  const statusEl = $('ad-status');

  // ── formatting ──
  const mb = n => `${(n / 1048576).toFixed(1)}MB`;
  const time = sec => { if (!sec) return '—'; const t = Math.round(sec); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const when = iso => (iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const say = (message, kind = 'done') => { statusEl.textContent = message; statusEl.className = `ad-status is-${kind}`; };

  // ── server ──
  async function call(method, path, body) {
    const res = await fetch(`/admin/api/${path}`, { method, headers: { 'X-PP-Admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/admin'; throw new Error(data.error || '再度入室してください。'); }
    if (!res.ok) { const e = new Error(data.error || '操作できませんでした。'); e.status = res.status; throw e; }
    return data;
  }
  // Upload with a progress bar (fetch cannot report upload progress).
  function upload(path, file, sha256, duration, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(path.method, `/admin/api/${path.url}`);
      xhr.setRequestHeader('X-PP-Admin', '1');
      xhr.setRequestHeader('X-Sha256', sha256);
      if (duration) xhr.setRequestHeader('X-Duration', String(duration));
      xhr.setRequestHeader('Content-Type', 'audio/mpeg');
      xhr.upload.onprogress = e => { if (e.lengthComputable) progress.value = e.loaded / e.total; };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 401) { location.href = '/admin'; return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else { const e = new Error(data.error || '操作できませんでした。今の音源のままです。'); e.status = xhr.status; reject(e); }
      };
      xhr.onerror = () => reject(new Error('通信が途切れました。今の音源のままです。もう一度お試しください。'));
      xhr.send(file);
    });
  }
  function apply(data) {
    state.rev = data.rev; state.songs = data.songs; state.removed = data.removed; state.maxUpload = data.maxUpload || state.maxUpload;
    render();
  }
  async function reload() { apply(await call('GET', 'catalog')); }
  async function act(fn, okMessage) {
    if (state.busy) return;
    state.busy = true; document.body.classList.add('is-busy');
    try { const data = await fn(); apply(data); say(data.message || okMessage, 'done'); return true; }
    catch (error) { say(error.message, 'error'); if (error.status === 409 || error.status === 404) await reload().catch(() => {}); return false; }
    finally { state.busy = false; document.body.classList.remove('is-busy'); }
  }

  // ── checking a chosen MP3 in the browser before sending ──
  async function inspect(file) {
    if (!file) throw new Error('ファイルを選んでください。');
    if (file.size > state.maxUpload) throw new Error(`ファイルが大きすぎます（上限 ${mb(state.maxUpload)}）。`);
    const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    const isMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    if (!isMp3) throw new Error('MP3ファイルではないようです。MP3を選んでください。');
    const url = URL.createObjectURL(file);
    const duration = await new Promise(resolve => {
      const a = new Audio(); const t = setTimeout(() => resolve(null), 15000);
      a.preload = 'metadata';
      a.onloadedmetadata = () => { clearTimeout(t); resolve(Number.isFinite(a.duration) ? a.duration : null); };
      a.onerror = () => { clearTimeout(t); resolve(-1); };
      a.src = url;
    });
    if (duration === -1) { URL.revokeObjectURL(url); throw new Error('このファイルは再生できませんでした。別のMP3を選んでください。'); }
    return { file, url, duration };
  }
  async function sha256(file) {
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── list ──
  function jacket(song, cls) {
    const box = el('span', cls);
    box.append(el('span', 'jacket-fallback', song.title));
    if (song.cover) { const img = el('img'); img.src = song.cover; img.alt = ''; img.width = img.height = 640; img.loading = 'lazy'; box.append(img); }
    return box;
  }
  function render() {
    const list = $('ad-list');
    list.replaceChildren();
    $('ad-count').textContent = String(state.songs.length);
    $('ad-size').textContent = state.songs.length ? ` ・ ${mb(state.songs.reduce((n, s) => n + (s.size || 0), 0))}` : '';
    $('ad-empty').hidden = state.songs.length > 0;
    state.songs.forEach((song, i) => {
      const li = el('li', 'pv-item ad-item');
      li.dataset.id = song.id;
      li.draggable = true;
      const body = el('div', 'pv-body');
      const no = el('p', 'pv-no'); no.append(el('span', null, String(i + 1).padStart(2, '0')));
      const meta = el('p', 'ad-meta', `${time(song.duration)} ・ ${mb(song.size)} ・ 音源更新 ${when(song.audioUpdatedAt)}`);
      const audio = el('audio', 'pv-audio'); audio.controls = true; audio.preload = 'none';
      audio.src = `/admin/api/songs/${encodeURIComponent(song.id)}/audio?v=${encodeURIComponent(song.v)}`;
      const actions = el('div', 'ad-actions');
      const replace = el('button', 'ad-replace', '音源を差し替え'); replace.type = 'button';
      replace.addEventListener('click', () => pickReplacement(song));
      const order = el('span', 'ad-order');
      const up = el('button', 'ad-move', '↑'); up.type = 'button'; up.disabled = i === 0; up.setAttribute('aria-label', `「${song.title}」を上へ`);
      const down = el('button', 'ad-move', '↓'); down.type = 'button'; down.disabled = i === state.songs.length - 1; down.setAttribute('aria-label', `「${song.title}」を下へ`);
      up.addEventListener('click', () => move(i, i - 1));
      down.addEventListener('click', () => move(i, i + 1));
      order.append(up, down);
      const remove = el('button', 'ad-remove', '外す'); remove.type = 'button';
      remove.addEventListener('click', () => askRemove(song));
      actions.append(replace, order, remove);
      body.append(no, el('h2', 'pv-song', song.title), meta, audio, actions);
      li.append(jacket(song, 'pv-jacket'), body);
      list.append(li);
    });
    const removed = $('ad-removed');
    removed.hidden = !state.removed.length;
    const rl = $('ad-removed-list');
    rl.replaceChildren(...state.removed.map(r => {
      const li = el('li');
      li.append(el('span', 'ad-removed-title', r.title), el('span', 'ad-removed-until', `${when(r.until)} まで`));
      const back = el('button', 'ad-restore', '元に戻す'); back.type = 'button';
      back.addEventListener('click', () => act(() => call('POST', 'restore', { rev: state.rev, file: r.file })));
      li.append(back);
      return li;
    }));
  }

  // ── reorder: ↑↓ buttons, or drag on a computer ──
  function move(from, to) {
    if (to < 0 || to >= state.songs.length) return;
    const ids = state.songs.map(s => s.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    act(() => call('POST', 'order', { rev: state.rev, ids }));
  }
  let dragId = null;
  $('ad-list').addEventListener('dragstart', e => { const li = e.target.closest('.ad-item'); if (!li) return; dragId = li.dataset.id; li.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; });
  $('ad-list').addEventListener('dragend', e => { e.target.closest('.ad-item')?.classList.remove('is-dragging'); });
  $('ad-list').addEventListener('dragover', e => { if (dragId) e.preventDefault(); });
  $('ad-list').addEventListener('drop', e => {
    e.preventDefault();
    const target = e.target.closest('.ad-item');
    if (!dragId || !target || target.dataset.id === dragId) { dragId = null; return; }
    const from = state.songs.findIndex(s => s.id === dragId), to = state.songs.findIndex(s => s.id === target.dataset.id);
    dragId = null;
    move(from, to);
  });

  // ── replace audio (the most important operation) ──
  const dlgReplace = $('dlg-replace');
  const replaceInput = $('ad-replace-file');
  let replacing = null;
  function pickReplacement(song) { if (state.busy) return; replacing = { song }; replaceInput.value = ''; replaceInput.click(); }
  replaceInput.addEventListener('change', async () => {
    const file = replaceInput.files[0];
    if (!file || !replacing) return;
    const d = dlgReplace, song = replacing.song;
    slot(d, 'song').textContent = `「${song.title}」`;
    slot(d, 'old-dur').textContent = time(song.duration);
    slot(d, 'old-size').textContent = mb(song.size);
    slot(d, 'old-date').textContent = when(song.audioUpdatedAt);
    slot(d, 'new-dur').textContent = '確認中…';
    slot(d, 'new-size').textContent = mb(file.size);
    slot(d, 'new-name').textContent = file.name;
    slot(d, 'msg').textContent = '';
    slot(d, 'progress').hidden = true;
    slot(d, 'go').disabled = true;
    slot(d, 'preview').removeAttribute('src');
    d.showModal();
    try {
      replacing.checked = await inspect(file);
      slot(d, 'new-dur').textContent = time(replacing.checked.duration);
      slot(d, 'preview').src = replacing.checked.url;
      slot(d, 'go').disabled = false;
    } catch (error) { slot(d, 'new-dur').textContent = '—'; slot(d, 'msg').textContent = error.message; }
  });
  slot(dlgReplace, 'go').addEventListener('click', async () => {
    const d = dlgReplace, checked = replacing?.checked;
    if (!checked) return;
    const go = slot(d, 'go'), cancel = slot(d, 'cancel'), bar = slot(d, 'progress'), msg = slot(d, 'msg');
    go.disabled = cancel.disabled = true; bar.hidden = false; bar.value = 0;
    msg.textContent = 'ファイルを確認しています…';
    const ok = await act(async () => {
      const hash = await sha256(checked.file);
      msg.textContent = 'アップロードしています…（完了するまで、今の音源がそのまま再生されます）';
      return upload({ method: 'PUT', url: `songs/${encodeURIComponent(replacing.song.id)}/audio?rev=${state.rev}` }, checked.file, hash, checked.duration, bar);
    });
    cancel.disabled = false;
    if (ok) { closeReplace(); }
    else { msg.textContent = `${statusEl.textContent}`; go.disabled = state.songs.every(s => s.id !== replacing?.song.id); bar.hidden = true; }
  });
  function closeReplace() { if (replacing?.checked) URL.revokeObjectURL(replacing.checked.url); replacing = null; dlgReplace.close(); }
  dlgReplace.addEventListener('close', () => { if (replacing?.checked) URL.revokeObjectURL(replacing.checked.url); slot(dlgReplace, 'preview').pause(); replacing = null; });

  // ── add a song ──
  const dlgAdd = $('dlg-add');
  let adding = null;
  $('ad-add').addEventListener('click', async () => {
    if (state.busy) return;
    const d = dlgAdd, select = slot(d, 'work');
    adding = {};
    slot(d, 'msg').textContent = ''; slot(d, 'info').textContent = ''; slot(d, 'file').value = ''; slot(d, 'title').value = '';
    slot(d, 'preview').hidden = true; slot(d, 'progress').hidden = true; slot(d, 'go').disabled = true;
    select.replaceChildren(el('option', null, '読み込み中…'));
    d.showModal();
    try {
      const { works } = await call('GET', 'works');
      const used = new Set(state.songs.map(s => s.id));
      const options = works.filter(w => !used.has(w.id)).map(w => { const o = el('option', null, w.title); o.value = w.id; return o; });
      const custom = el('option', null, '公式サイトにない曲（曲名を入力）'); custom.value = '';
      const first = el('option', null, options.length ? '曲を選んでください' : '（公式サイトの曲はすべて登録済みです）'); first.value = '-'; first.disabled = true; first.selected = true;
      select.replaceChildren(first, ...options, custom);
    } catch (error) { select.replaceChildren(Object.assign(el('option', null, '公式サイトにない曲（曲名を入力）'), { value: '' })); slot(d, 'msg').textContent = error.message; }
    updateAdd();
  });
  function updateAdd() {
    const d = dlgAdd, work = slot(d, 'work').value;
    slot(d, 'title-field').hidden = work !== '';
    slot(d, 'go').disabled = !adding?.checked || work === '-' || (work === '' && !slot(d, 'title').value.trim());
  }
  slot(dlgAdd, 'work').addEventListener('change', updateAdd);
  slot(dlgAdd, 'title').addEventListener('input', updateAdd);
  slot(dlgAdd, 'file').addEventListener('change', async () => {
    const d = dlgAdd, file = slot(d, 'file').files[0];
    if (adding?.checked) URL.revokeObjectURL(adding.checked.url);
    adding = {};
    slot(d, 'msg').textContent = ''; slot(d, 'preview').hidden = true;
    if (!file) return updateAdd();
    slot(d, 'info').textContent = '確認中…';
    try {
      adding.checked = await inspect(file);
      slot(d, 'info').textContent = `${file.name} ・ ${time(adding.checked.duration)} ・ ${mb(file.size)}`;
      slot(d, 'preview').src = adding.checked.url; slot(d, 'preview').hidden = false;
    } catch (error) { slot(d, 'info').textContent = ''; slot(d, 'msg').textContent = error.message; }
    updateAdd();
  });
  slot(dlgAdd, 'go').addEventListener('click', async () => {
    const d = dlgAdd, checked = adding?.checked;
    if (!checked) return;
    const work = slot(d, 'work').value, title = slot(d, 'title').value.trim();
    const go = slot(d, 'go'), cancel = slot(d, 'cancel'), bar = slot(d, 'progress'), msg = slot(d, 'msg');
    go.disabled = cancel.disabled = true; bar.hidden = false; bar.value = 0; msg.textContent = 'アップロードしています…';
    const query = work ? `work=${encodeURIComponent(work)}` : `title=${encodeURIComponent(title)}`;
    const ok = await act(async () => upload({ method: 'POST', url: `songs?rev=${state.rev}&${query}` }, checked.file, await sha256(checked.file), checked.duration, bar));
    cancel.disabled = false;
    if (ok) d.close(); else { msg.textContent = statusEl.textContent; go.disabled = false; bar.hidden = true; }
  });
  dlgAdd.addEventListener('close', () => { if (adding?.checked) URL.revokeObjectURL(adding.checked.url); slot(dlgAdd, 'preview').pause(); adding = null; });

  // ── remove (with confirmation) ──
  const dlgRemove = $('dlg-remove');
  let removing = null;
  function askRemove(song) {
    if (state.busy) return;
    removing = song;
    slot(dlgRemove, 'song').textContent = `「${song.title}」`;
    slot(dlgRemove, 'thumb').replaceChildren(jacket(song, 'pv-jacket'));
    slot(dlgRemove, 'msg').textContent = '';
    slot(dlgRemove, 'go').disabled = false;
    dlgRemove.showModal();
  }
  slot(dlgRemove, 'go').addEventListener('click', async () => {
    if (!removing) return;
    slot(dlgRemove, 'go').disabled = true;
    const ok = await act(() => call('POST', `songs/${encodeURIComponent(removing.id)}/remove`, { rev: state.rev }));
    if (ok) dlgRemove.close(); else { slot(dlgRemove, 'msg').textContent = statusEl.textContent; }
  });

  // Prevent leaving the page in the middle of an upload.
  addEventListener('beforeunload', e => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });

  reload().catch(error => say(error.message, 'error'));
})();
