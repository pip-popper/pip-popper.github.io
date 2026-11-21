// PIP POPPER 管理ツール — 画面の動き。サーバー（manager/server.mjs）とだけ通信する。
(() => {
  'use strict';
  // the per-launch password comes in the address (#t=...) and is kept only in this tab
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash) { try { sessionStorage.setItem('ppm-token', fromHash); } catch {} history.replaceState(null, '', location.pathname); }
  let token = fromHash; try { token = token || sessionStorage.getItem('ppm-token'); } catch {}

  const $ = s => document.querySelector(s);
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) e.append(k); return e; };
  let state = null, current = null, edits = new Map();

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
  const unsaved = () => edits.size > 0;
  async function guard() {
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
      ...(q ? [] : [el('h2', { textContent: 'PRIVATE管理' }), el('ul', {}, el('li', {}, el('button', { type: 'button', ariaCurrent: String(privateOpen), onclick: openPrivate }, el('span', { textContent: 'PRIVATEのパスワード' }))))]),
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
    edits = new Map(); privateOpen = false;
    renderLists();
    const kind = { track: '楽曲', album: 'アルバム', site: 'サイトの文言' }[type];
    const unsavedEl = el('span', { className: 'unsaved' });
    const saveBtn = el('button', { type: 'button', className: 'primary', textContent: '保存', disabled: true, onclick: save });
    const head = el('div', { className: 'edit-head' }, el('h2', {}, el('span', { className: 'kind', textContent: kind }), current.title), unsavedEl, saveBtn,
      el('button', { type: 'button', textContent: 'プレビュー', onclick: preview }));
    const fields = current.fields.map((f, i) => {
      const id = `f${i}`;
      const input = f.kind === 'url' ? el('input', { id, type: 'url', value: f.value, placeholder: 'https://open.spotify.com/…' })
        : f.kind === 'line' ? el('input', { id, type: 'text', value: f.value }) : el('textarea', { id, value: f.value, className: f.kind === 'lyrics' ? 'lyrics' : '' });
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
    current = null; edits = new Map(); privateOpen = true;
    renderLists();
    const pw = (id, label, auto) => { const input = el('input', { id, type: 'password', autocomplete: auto, spellcheck: false });
      return [el('div', { className: 'field' }, el('label', { htmlFor: id, textContent: label }), input), input]; };
    const [fNew, iNew] = pw('pp-new', '新しいパスワード（8〜200文字）', 'new-password');
    const [fConf, iConf] = pw('pp-conf', '新しいパスワード（確認用・もう一度）', 'new-password');
    const [fAdm, iAdm] = pw('pp-adm', '管理者パスワード（PRIVATEの管理画面に入るときのもの）', 'off');
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
      fNew, fConf, fAdm, el('div', { className: 'field' }, btn), result,
      el('details', { className: 'restore' }, el('summary', { textContent: '以前のパスワード（Cloudflareに登録したもの）に戻す' }),
        el('p', { className: 'note', textContent: '管理ツールで設定したパスワードをやめて、Cloudflareのダッシュボードに登録されているパスワードに戻します。通常は使いません。確認のため、下の欄に「旧パスワードに戻す」と入力してください。' }),
        el('div', { className: 'field' }, el('label', { htmlFor: 'pp-words', textContent: '確認の言葉' }), iWords), fRAdm, el('div', { className: 'field' }, rBtn), rResult));
    $('#main').scrollTop = 0;
    window.addEventListener('pagehide', () => clear(iNew, iConf, iAdm, iRAdm, iWords), { once: true });
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
