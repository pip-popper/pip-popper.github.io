// Only one song plays at a time.
document.addEventListener('play', event => {
  for (const audio of document.querySelectorAll('audio')) if (audio !== event.target) audio.pause();
}, true);
