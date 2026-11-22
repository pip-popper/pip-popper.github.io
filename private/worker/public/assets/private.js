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
    button: item.querySelector('.pv-select'), title: item.querySelector('.pv-song').textContent
  }));
  const controls = player.querySelector('.pv-player-controls');
  const title = player.querySelector('.pv-player-title');
  const status = player.querySelector('.pv-player-state');
  let current;
  function update() {
    for (const entry of entries) {
      const selected = entry === current;
      const playing = selected && !entry.audio.paused && !entry.audio.ended;
      entry.item.classList.toggle('is-current', selected);
      entry.item.classList.toggle('is-playing', playing);
      entry.button.setAttribute('aria-pressed', String(selected));
      entry.button.textContent = playing ? '再生中' : selected ? '再生する（選択中）' : '再生する';
    }
    status.textContent = !current ? '曲を選んで再生' : current.audio.error ? '再生できません。もう一度お試しください。'
      : current.audio.ended ? '再生終了' : current.audio.paused && current.audio.currentTime === 0 ? '選択中（再生ボタンで再生）'
      : current.audio.paused ? '一時停止中' : '再生中';
  }
  function select(entry, play) {
    if (current !== entry) {
      if (current) {
        current.audio.pause();
        current.body.insertBefore(current.audio, current.body.querySelector('.pv-dl'));
      }
      current = entry;
      controls.append(entry.audio);
      title.textContent = entry.title;
      entry.audio.setAttribute('aria-label', entry.title + 'の再生操作');
    }
    update();
    if (play) entry.audio.play().catch(() => {
      if (current === entry) status.textContent = '再生ボタンを押してお試しください。';
    });
  }
  for (const entry of entries) {
    entry.button.hidden = false;
    entry.button.addEventListener('click', () => select(entry, true));
    for (const event of ['play', 'pause', 'ended', 'error']) entry.audio.addEventListener(event, update);
  }
  document.documentElement.classList.add('pv-enhanced');
  player.hidden = false;
  if (entries.length) select(entries[0], false);
}
