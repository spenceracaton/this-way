// Shared lifecycle for native dialogs. Native showModal supplies inert background
// and focus containment; this helper owns scroll lock and explicit focus return.
const active = new Set();
let originalOverflow = '', originalPadding = '';
export function bindDialog(dialog, { initialFocus = () => dialog.querySelector('h2, button, input') } = {}) {
  let opener, backdropPointer;
  const scrollers = [...dialog.querySelectorAll('.submission-scroll, .community-form, .community-preview, .photo-contribution-scroll')];
  const scrollState = () => scrollers.forEach(el => {
    el.dataset.moreBelow = String(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
  });
  const resize = new ResizeObserver(scrollState);
  for (const el of scrollers) {
    el.classList.add('dialog-scroll-cue');
    el.addEventListener('scroll', scrollState, { passive: true });
    resize.observe(el);
    [...el.children].forEach(child => resize.observe(child));
  }
  new MutationObserver(scrollState).observe(dialog, { childList: true, subtree: true });
  function open(origin = document.activeElement) {
    if (dialog.open) return;
    opener = origin;
    if (!active.size) {
      originalOverflow = document.body.style.overflow;
      originalPadding = document.body.style.paddingRight;
      const scrollbar = innerWidth - document.documentElement.clientWidth;
      if (scrollbar > 0) document.body.style.paddingRight = scrollbar + 'px';
      document.body.style.overflow = 'hidden';
    }
    active.add(dialog);
    dialog.showModal();
    scrollState();
    initialFocus()?.focus({ preventScroll: true });
  }
  function close() { if (dialog.open) dialog.close(); }
  dialog.addEventListener('close', () => {
    backdropPointer = null;
    active.delete(dialog);
    if (!active.size) {
      document.body.style.overflow = originalOverflow;
      document.body.style.paddingRight = originalPadding;
    }
    if (!document.querySelector('dialog[open]') && opener?.isConnected) opener.focus({ preventScroll: true });
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  const outside = event => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  dialog.addEventListener('pointerdown', event => {
    backdropPointer = event.isPrimary && event.button === 0 && outside(event) ? { id: event.pointerId, released: false } : null;
  });
  dialog.addEventListener('pointerup', event => {
    if (backdropPointer?.id === event.pointerId) backdropPointer.released = outside(event);
  });
  dialog.addEventListener('pointercancel', () => { backdropPointer = null; });
  dialog.addEventListener('click', event => {
    const dismiss = backdropPointer?.released && outside(event);
    backdropPointer = null;
    if (dismiss) close();
  });
  return { open, close };
}
