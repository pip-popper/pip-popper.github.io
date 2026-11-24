// Only one song plays at a time.
document.addEventListener('play', event => {
  for (const audio of document.querySelectorAll('audio')) if (audio !== event.target) audio.pause();
}, true);

// Enhance the existing native audio elements: keep their source, seek position and controls.
const list = document.querySelector('.pv-library-list');
const player = document.querySelector('.pv-player');
if (list && player) {
  const entries = [...list.querySelectorAll('.pv-item')].map(item => ({
    item, audio: item.querySelector('audio'), body: item.querySelector('.pv-body'),
    button: item.querySelector('.pv-select'), title: item.querySelector('.pv-song').textContent,
    lyrics: item.querySelector('.pv-song-lyrics')?.textContent || '',
    impression: item.querySelector('.pv-song-impression')?.textContent || '',
    publicWork: item.querySelector('.pv-public-work')?.textContent || '',
    cover: item.querySelector('.pv-jacket img')?.getAttribute('src') || ''
  }));
  const controls = player.querySelector('.pv-player-controls');
  const title = player.querySelector('.pv-player-title');
  const status = player.querySelector('.pv-player-state');
  const listening = document.querySelector('.pv-listening');
  const lyrics = listening?.querySelector('.pv-current-lyrics');
  const impression = listening?.querySelector('.pv-impression');
  const impressionText = impression?.querySelector('.pv-current-impression');
  const jacket = listening?.querySelector('.pv-current-jacket img');
  const publicLyrics = listening?.querySelector('.pv-public-lyrics');
  if (jacket) jacket.addEventListener('error', () => { jacket.hidden = true; });
  let current;
  function update() {
    for (const entry of entries) {
      const selected = entry === current;
      const playing = selected && !entry.audio.paused && !entry.audio.ended;
      entry.item.classList.toggle('is-current', selected);
      entry.item.classList.toggle('is-playing', playing);
      entry.button.setAttribute('aria-current', String(selected));
      entry.button.setAttribute('aria-pressed', String(playing));
      entry.button.setAttribute('aria-label', entry.title + (playing ? 'を一時停止' : 'を再生'));
      entry.button.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
    }
    status.textContent = !current ? '曲を選んで再生' : current.audio.error ? '再生できません。もう一度お試しください。'
      : current.audio.ended ? '再生終了' : current.audio.paused && current.audio.currentTime === 0 ? '再生待機中'
      : current.audio.paused ? '一時停止中' : '再生中';
  }
  function select(entry, play) {
    if (current !== entry) {
      if (current) {
        current.playAttempt = (current.playAttempt ?? 0) + 1;
        current.audio.pause();
        current.body.insertBefore(current.audio, current.body.querySelector('.pv-dl'));
      }
      current = entry;
      controls.append(entry.audio);
      title.textContent = entry.title;
      if (lyrics) {
        lyrics.textContent = entry.lyrics.trim() ? entry.lyrics : (lyrics.dataset?.emptyMessage || '歌詞はまだ登録されていません。');
        lyrics.scrollTop = 0;
      }
      if(impression&&impressionText){impression.hidden=!entry.impression.trim();impressionText.textContent=entry.impression;}
      if (publicLyrics) {
        publicLyrics.hidden = !entry.publicWork || !!entry.lyrics.trim();
        if (!publicLyrics.hidden) publicLyrics.setAttribute('href', entry.publicWork);
        else publicLyrics.removeAttribute('href');
      }
      if (jacket) {
        jacket.hidden = !entry.cover;
        if (entry.cover) jacket.setAttribute('src', entry.cover);
        else jacket.removeAttribute('src');
      }
      entry.audio.setAttribute('aria-label', entry.title + 'の再生操作');
    }
    update();
    if (play) {
      const attempt = entry.playAttempt = (entry.playAttempt ?? 0) + 1;
      entry.audio.play().catch(error => {
        if (current === entry && attempt === entry.playAttempt && error?.name !== 'AbortError') {
          update();
          status.textContent = '再生ボタンを押してお試しください。';
        }
      });
    }
  }
  function toggle(entry) {
    if (current === entry && !entry.audio.paused && !entry.audio.ended) {
      entry.playAttempt = (entry.playAttempt ?? 0) + 1;
      entry.audio.pause();
      update();
    } else select(entry, true);
  }
  for (const entry of entries) {
    entry.button.hidden = false;
    entry.button.addEventListener('click', () => toggle(entry));
    for (const event of ['play', 'playing', 'pause', 'ended', 'error']) entry.audio.addEventListener(event, update);
  }
  document.documentElement.classList.add('pv-enhanced');
  player.hidden = false;
  if (listening) listening.hidden = false;
  if (entries.length) select(entries[0], false);
}
