const wordmark = document.querySelector('.opening .wordmark');
const title = wordmark.parentElement;
const measure = title.querySelector('.logo-width');
const nav = document.querySelector('#site-navigation');
const toggle = document.querySelector('.menu-toggle');
const header = toggle.closest('header');
const mobile = matchMedia('(max-width: 760px)');

function fitWordmark() {
  wordmark.style.removeProperty('--fitted-logo');
  const width = wordmark.getBoundingClientRect().width;
  const available = Math.min(title.clientWidth, measure.getBoundingClientRect().width);
  if (width > available) {
    const size = parseFloat(getComputedStyle(wordmark).fontSize);
    wordmark.style.setProperty('--fitted-logo', (size * (available - 1) / width) + 'px');
  }
}

function setOpen(open) {
  nav.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
}

function isOpen() {
  return toggle.getAttribute('aria-expanded') === 'true';
}

toggle.addEventListener('click', () => setOpen(!isOpen()));

header.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link || !mobile.matches || !(nav.contains(link) || link.matches('.mobile-latest'))) return;
  setOpen(false);
  const target = document.getElementById(link.hash.slice(1));
  if (target) {
    target.tabIndex = -1;
    target.focus({preventScroll: true});
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !isOpen()) return;
  event.preventDefault();
  setOpen(false);
  toggle.focus();
});

document.addEventListener('click', (event) => {
  if (!isOpen() || header.contains(event.target)) return;
  if (nav.contains(document.activeElement)) toggle.focus();
  setOpen(false);
});

header.addEventListener('focusout', (event) => {
  if (isOpen() && event.relatedTarget && !header.contains(event.relatedTarget)) setOpen(false);
});

mobile.addEventListener('change', () => setOpen(false));
header.classList.add('menu-ready');
fitWordmark();
document.fonts.ready.then(fitWordmark);
addEventListener('resize', fitWordmark);
