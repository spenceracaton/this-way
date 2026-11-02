import { mountGallery } from './gallery.mjs';

// Sample displays are attached only to the Old Northeast study.
const samples = {
  a: { title: 'Pumpkin Lantern Walk', description: 'Lanterns light the garden path.', tags: ['Family friendly'], photos: ['lantern.svg', 'illustration-haunt.webp', 'illustration-treat.webp'] },
  c: { title: 'The Little House of Ghosts at the End of the Pumpkin Trail', tags: ['Spooky'], photos: ['lantern.svg'] }
};

export function createDetail({ close, neighborhood }) {
  const byId = id => document.getElementById(id);
  const pane = byId('selection');
  let selected, gallery, returnFocus;
  function dismiss() {
    close();
    returnFocus?.focus({ preventScroll: true });
  }
  byId('detail-close').onclick = dismiss;
  pane.addEventListener('keydown', event => {
    if (event.key === 'Escape') dismiss();
  });
  const heart = byId('detail-heart');
  const heartKey = () => 'sample-heart:' + neighborhood + ':' + selected.id;
  function setHeart(liked) {
    heart.setAttribute('aria-pressed', String(liked));
    heart.querySelector('.heart-count').textContent = liked ? '1' : '0';
  }
  heart.onclick = () => {
    const liked = heart.getAttribute('aria-pressed') !== 'true';
    setHeart(liked);
    try { localStorage.setItem(heartKey(), String(liked)); } catch {}
  };
  byId('detail-share').onclick = async () => {
    const pin = selected;
    const url = new URL(location.href);
    url.searchParams.set('sample', pin.id);
    try {
      if (navigator.share) await navigator.share({ title: pin.name, url: url.href });
      else await navigator.clipboard.writeText(url.href);
    } catch (error) {
      if (error.name === 'AbortError' || pin !== selected) return;
      const input = byId('share-url');
      input.value = url.href;
      input.hidden = false;
      input.select();
    }
  };
  const canvas = pane.parentElement;
  const desktop = matchMedia('(min-width:721px)');
  let anchor;
  function position() {
    if (!desktop.matches || pane.hidden || !anchor) return;
    const inset = 8;
    const gap = 28;
    const width = pane.offsetWidth;
    const height = pane.offsetHeight;
    const rightRoom = canvas.clientWidth - anchor.x;
    const beside = rightRoom >= width + gap + inset || rightRoom >= anchor.x
      ? anchor.x + gap : anchor.x - gap - width;
    const clamp = (value, max) => Math.max(inset, Math.min(value, max - inset));
    pane.style.setProperty('--house-left', clamp(beside, canvas.clientWidth - width) + 'px');
    pane.style.setProperty('--house-top', clamp(anchor.y - height / 2, canvas.clientHeight - height) + 'px');
  }
  const observer = new ResizeObserver(position);
  observer.observe(pane);
  observer.observe(canvas);
  desktop.addEventListener('change', position);
  function select(pin, opener) {
    gallery?.destroy();
    gallery = null;
    selected = pin;
    pane.hidden = !pin;
    pane.dataset.selected = pin?.id || '';
    byId('share-url').hidden = true;
    const host = byId('display-photos');
    host.replaceChildren();
    if (!pin) return;
    returnFocus = opener || document.querySelector('[data-pin="' + CSS.escape(pin.id) + '"]');
    const data = (neighborhood === 'old-northeast' && samples[pin.id]) || {};
    const address = document.createElement('a');
    address.id = 'selected-name';
    address.textContent = pin.name;
    address.href = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(pin.lat + ',' + pin.lng);
    address.target = '_blank';
    address.rel = 'noopener';
    address.setAttribute('aria-label', 'Directions to ' + pin.name);
    const title = byId('detail-title');
    const secondary = byId('detail-address');
    secondary.replaceChildren();
    title.textContent = data.title || '';
    (data.title ? secondary : title).append(address);
    byId('selected-label').textContent = pin.label;
    byId('selected-note').textContent = data.description || pin.note;
    const tags = byId('detail-tags');
    tags.replaceChildren();
    for (const tag of data.tags || []) {
      const item = document.createElement('li');
      item.textContent = tag;
      tags.append(item);
    }
    tags.hidden = !tags.childElementCount;
    host.hidden = !data.photos?.length;
    if (!host.hidden) gallery = mountGallery(host, data.photos.map(file => ({url: './assets/samples/' + file})), pin.name);
    pane.querySelector('.house-body').scrollTop = 0;
    let liked = false;
    try { liked = localStorage.getItem(heartKey()) === 'true'; } catch {}
    setHeart(liked);
   }
  return {select, setAnchor(point) { anchor = point; position(); }};
}
