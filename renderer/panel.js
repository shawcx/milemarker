'use strict';

// Floating panel: drag by the header's empty space, resize from the corner grip,
// and collapse one section (`collapsible`). Each launch starts top-left at a third of
// the window's width; only the collapsed state is remembered in localStorage.
// Position and width are kept as fractions of the window, so `fitWindow()` (called by
// the app on window resize) scales the panel proportionally.

// eslint-disable-next-line no-unused-vars
function createFloatingPanel(panel, { header, grip, collapsible, collapseBtn, onChange }) {
  const KEY = 'panel';
  const MARGIN = 8;
  const MIN_W = 320;

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ collapsed: isCollapsed() }));
    } catch { /* storage unavailable */ }
  };
  const isCollapsed = () => collapsible.classList.contains('collapsed');
  let rel = null; // { x, y, w } as fractions of the window: where the user put the panel

  function remember() {
    const r = panel.getBoundingClientRect();
    rel = { x: r.left / window.innerWidth, y: r.top / window.innerHeight, w: r.width / window.innerWidth };
  }

  // Switch from the CSS bottom-anchored default to explicit left/top.
  // `byUser`: the user moved/resized/collapsed it (vs. automatic clamping or window scaling).
  function place(left, top, width, byUser = false) {
    const maxW = Math.max(MIN_W, window.innerWidth - 2 * MARGIN);
    panel.style.width = `${Math.min(maxW, Math.max(MIN_W, width))}px`;
    panel.style.bottom = 'auto';
    const r = panel.getBoundingClientRect();
    // Keep it on screen; if it's bigger than the window, pin the top-left so the toolbar stays reachable.
    panel.style.left = `${Math.max(MARGIN, Math.min(left, window.innerWidth - r.width - MARGIN))}px`;
    panel.style.top = `${Math.max(MARGIN, Math.min(top, window.innerHeight - r.height - MARGIN))}px`;
    onChange?.({ byUser });
  }

  // Collapsing changes the height; keep whichever edge is nearer the window edge fixed,
  // so a panel docked at the top or bottom stays docked there.
  function keepNearEdge(fn) {
    const before = panel.getBoundingClientRect();
    const bottomDocked = before.top + before.height / 2 > window.innerHeight / 2;
    fn();
    const after = panel.getBoundingClientRect();
    place(after.left, bottomDocked ? after.top - (after.height - before.height) : before.top, after.width, true);
  }

  function dragWith(e, cls, move) {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, rect: panel.getBoundingClientRect() };
    document.body.classList.add(cls);
    const onMove = (ev) => move(ev.clientX - start.x, ev.clientY - start.y, start.rect);
    const onUp = () => {
      document.body.classList.remove(cls);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      remember();
      save();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, select, label')) return;
    dragWith(e, 'panel-dragging', (dx, dy, r) => place(r.left + dx, r.top + dy, r.width, true));
  });

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragWith(e, 'panel-resizing', (dx, dy, r) => {
      // Height follows width (16:9 video), so use whichever axis moved further.
      const grow = Math.abs(dx) > Math.abs(dy * 16 / 9) ? dx : dy * 16 / 9;
      place(r.left, r.top, r.width + grow, true);
    });
  });

  collapseBtn.addEventListener('click', () => {
    keepNearEdge(() => collapsible.classList.toggle('collapsed'));
    remember();
    save();
  });

  const reclamp = () => {
    const r = panel.getBoundingClientRect();
    place(r.left, r.top, r.width);
  };
  /** Window resized: re-apply the remembered fractional layout (clamped on screen). */
  const fitWindow = () => place(rel.x * window.innerWidth, rel.y * window.innerHeight, rel.w * window.innerWidth);
  // Content height can change (e.g. the clip bar wrapping); keep the panel on screen.
  new ResizeObserver(() => {
    if (panel.getBoundingClientRect().bottom > window.innerHeight - MARGIN) reclamp();
  }).observe(panel);

  // Initial layout: top-left corner, a third of the window wide.
  if (load().collapsed) collapsible.classList.add('collapsed');
  place(MARGIN, MARGIN, window.innerWidth / 3 - MARGIN);
  remember();

  return {
    rect: () => panel.getBoundingClientRect(),
    /** Re-fit to the window now (e.g. right after the content grew), without waiting for the observer. */
    reclamp,
    fitWindow,
  };
}
