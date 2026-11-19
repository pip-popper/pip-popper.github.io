// Page transition (adopted from the 3rd-design "finish" candidate, 2026-11-19):
// a 140 ms fade to the opening's near-black, then a 150 ms reveal on the next page.
// The prototype's optional "hit" still (test URL parameter only) is not part of the official site.
(() => {
  const root = document.documentElement;
  const site = new URL('../', document.currentScript.src);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const marker = '__pip_fade';
  const exitMs = 140;
  let next;
  let navigationStarted = false;
  let departureTimer;
  let recoveryTimer;

  function reset() {
    clearTimeout(departureTimer);
    clearTimeout(recoveryTimer);
    next = undefined;
    navigationStarted = false;
    root.classList.remove('page-leaving', 'page-arriving');
  }

  const incoming = new URL(location.href);
  if (incoming.searchParams.has(marker)) {
    const age = Date.now() - Number(incoming.searchParams.get(marker));
    incoming.searchParams.delete(marker);
    try {
      history.replaceState(history.state, '', incoming.href);
    } catch {
      // A restrictive file URL may keep the marker, which expires automatically.
    }
    if (!reduceMotion.matches && age >= 0 && age < 5000) {
      root.classList.add('page-arriving');
      recoveryTimer = setTimeout(reset, 210);
    }
  }

  document.addEventListener('click', event => {
    const link = event.target instanceof Element && event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    if (reduceMotion.matches || link.hasAttribute('download') ||
        (link.target && link.target.toLowerCase() !== '_self')) {
      reset();
      return;
    }

    const destination = new URL(link.href);
    const isSitePage = destination.protocol === site.protocol &&
      destination.origin === site.origin &&
      destination.pathname.startsWith(site.pathname) &&
      /(?:\.html|\/)$/i.test(destination.pathname);
    const active = new URL(location.href);
    const isSamePage = destination.pathname === active.pathname &&
      destination.search === active.search;
    if (!isSitePage || isSamePage) {
      // A subsequent ordinary action takes precedence over a queued departure.
      reset();
      return;
    }

    event.preventDefault();
    if (next) {
      if (!navigationStarted) next = destination;
      return;
    }

    reset();
    next = destination;
    root.classList.add('page-leaving');
    departureTimer = setTimeout(() => {
      const url = next;
      navigationStarted = true;
      url.searchParams.set(marker, String(Date.now()));
      // The source must become visible again if the browser keeps loading or cancels.
      recoveryTimer = setTimeout(reset, 200);
      location.assign(url.href);
    }, exitMs);
  });

  addEventListener('pagehide', reset);
  addEventListener('pageshow', event => { if (event.persisted) reset(); });
  addEventListener('popstate', reset);
  addEventListener('keydown', event => { if (event.key === 'Escape') reset(); });
  reduceMotion.addEventListener('change', reset);
})();
