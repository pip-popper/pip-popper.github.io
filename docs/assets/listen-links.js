// 2026-11-25: show "▶ 試聴する" only for the songs the general listening page publishes right now.
// The list holds song IDs only (matched by ID, never by title). Any failure keeps every link hidden.
(() => {
  const script = document.currentScript;
  const links = [...document.querySelectorAll('a[data-listen-id]')];
  const src = script && script.dataset.src;
  if (!links.length || !src || !window.fetch) return;
  const ctl = 'AbortController' in window ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), 8000);
  fetch(src, { credentials: 'omit', mode: 'cors', signal: ctl ? ctl.signal : undefined })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
    .then(data => {
      if (!data || data.version !== 1 || !Array.isArray(data.ids)) return;
      const ids = new Set(data.ids.filter(id => typeof id === 'string' && /^[a-z0-9-]{1,128}$/.test(id)));
      for (const a of links) if (ids.has(a.dataset.listenId)) a.hidden = false;
    })
    .catch(() => {})
    .finally(() => { if (timer) clearTimeout(timer); });
})();
