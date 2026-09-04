/**
 * The floating shell the panel lives in.
 *
 * This is the piece that makes One Pane safe to run on a console we do not
 * own. It attaches a single element to <body>, positions everything `fixed`
 * inside a shadow root, and never reads, moves, restyles, or reparents
 * anything that was already on the page. SMC's layout is therefore
 * bit-for-bit unchanged whether the extension is installed or not - which
 * matters because we cannot edit SMC to make room for a panel, and because a
 * tool that reflows the page an analyst is working in gets uninstalled.
 *
 * Deliberately free of chrome.* APIs: it takes plain values and reports
 * changes through callbacks, so the content script owns all persistence and
 * this file can be exercised in an ordinary page.
 */

import { OVERLAY_CSS, PANEL_CSS } from './styles.js';
import { MARK_SVG } from './brand.js';

/** Keep at least this much of the dock on screen when dragging or resizing. */
const MIN_VISIBLE = 72;

/**
 * @param {object} options
 * @param {{element: HTMLElement}} options.content  panel content to host
 * @param {object} options.layout  {side, width, height, margin, position}
 * @param {boolean} [options.open] start expanded
 * @param {(layout: object) => void} [options.onLayoutChange]
 * @param {(open: boolean) => void} [options.onOpenChange]
 */
export function createOverlay({ content, layout, open = false, onLayoutChange, onOpenChange }) {
  const host = document.createElement('div');
  host.id = 'one-pane-overlay';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `${OVERLAY_CSS}\n${PANEL_CSS}`;

  const launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.innerHTML = `${MARK_SVG} One Pane`;

  const dock = document.createElement('section');
  dock.className = 'dock';
  dock.setAttribute('role', 'complementary');
  dock.setAttribute('aria-label', 'One Pane');
  dock.innerHTML = `
    <header class="grip" data-el="grip">
      <div class="mark">${MARK_SVG}</div>
      <div class="title">One Pane</div>
      <button class="icon-btn" type="button" data-el="collapse" title="Collapse" aria-label="Collapse">▲</button>
    </header>
    <div class="content" data-el="content"></div>`;

  dock.querySelector('[data-el="content"]').append(content.element);
  root.append(style, launcher, dock);

  const state = {
    open,
    layout: { ...layout },
  };

  /* ---------------- placement ---------------- */

  function applyLayout() {
    const { side, width, height, margin, position } = state.layout;

    dock.style.width = `${width}px`;
    dock.style.height = `${height}px`;

    if (position) {
      dock.style.left = `${position.x}px`;
      dock.style.top = `${position.y}px`;
      dock.style.right = 'auto';
    } else {
      // Anchored to an edge rather than a coordinate, so the dock keeps its
      // margin when the window is resized.
      dock.style.top = `${margin}px`;
      if (side === 'left') {
        dock.style.left = `${margin}px`;
        dock.style.right = 'auto';
      } else {
        dock.style.right = `${margin}px`;
        dock.style.left = 'auto';
      }
    }

    launcher.style.right = side === 'left' ? 'auto' : `${margin}px`;
    launcher.style.left = side === 'left' ? `${margin}px` : 'auto';
  }

  function commitLayout(patch) {
    state.layout = { ...state.layout, ...patch };
    applyLayout();
    onLayoutChange?.(state.layout);
  }

  /** Never let the dock be dragged or resized fully out of reach. */
  function clampPosition(x, y) {
    const maxX = window.innerWidth - MIN_VISIBLE;
    const maxY = window.innerHeight - MIN_VISIBLE;
    return {
      x: Math.max(MIN_VISIBLE - state.layout.width, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
  }

  /* ---------------- open / close ---------------- */

  function setOpen(next, { silent = false } = {}) {
    state.open = next;
    dock.setAttribute('data-open', String(next));
    launcher.setAttribute('data-hidden', String(next));
    dock.setAttribute('aria-hidden', String(!next));
    if (!silent) onOpenChange?.(next);
  }

  /* ---------------- dragging ---------------- */

  const grip = dock.querySelector('[data-el="grip"]');
  let drag = null;

  grip.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.icon-btn')) return; // collapse button, not a drag
    const rect = dock.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };

    dock.setAttribute('data-dragging', 'true');
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { x, y } = clampPosition(e.clientX - drag.dx, e.clientY - drag.dy);
    dock.style.left = `${x}px`;
    dock.style.top = `${y}px`;
    dock.style.right = 'auto';
  });

  grip.addEventListener('pointerup', (e) => {
    if (!drag) return;
    drag = null;
    dock.removeAttribute('data-dragging');
    grip.releasePointerCapture(e.pointerId);

    const rect = dock.getBoundingClientRect();
    commitLayout({ position: { x: Math.round(rect.left), y: Math.round(rect.top) } });
  });

  /* ---------------- resizing ---------------- */

  /**
   * The dock is natively resizable; mirror the result back into stored layout
   * so the size survives a reload.
   *
   * Persisting only on a deliberate corner drag, rather than watching the
   * element's size, is the important part. The dock is capped at 92vh, so
   * simply making the browser window short forces it smaller - and a size
   * watcher cannot tell that clamping apart from an intentional resize. It
   * would write the squeezed height to storage and the panel would stay small
   * after the window grew back.
   */
  const RESIZE_CORNER = 22;
  let resizing = false;

  dock.addEventListener('pointerdown', (e) => {
    const rect = dock.getBoundingClientRect();
    resizing = (rect.right - e.clientX) < RESIZE_CORNER
      && (rect.bottom - e.clientY) < RESIZE_CORNER;
  });

  const onPointerUp = () => {
    if (!resizing) return;
    resizing = false;

    const width = Math.round(dock.offsetWidth);
    const height = Math.round(dock.offsetHeight);
    if (width === state.layout.width && height === state.layout.height) return;
    commitLayout({ width, height });
  };
  window.addEventListener('pointerup', onPointerUp);

  /* ---------------- events ---------------- */

  launcher.addEventListener('click', () => setOpen(true));
  dock.querySelector('[data-el="collapse"]').addEventListener('click', () => setOpen(false));

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) setOpen(false);
  });

  // A window resize can strand a dragged dock off-screen.
  const onWindowResize = () => {
    if (!state.layout.position) return;
    const { x, y } = clampPosition(state.layout.position.x, state.layout.position.y);
    commitLayout({ position: { x, y } });
  };
  window.addEventListener('resize', onWindowResize);

  return {
    element: host,

    mount(parent = document.body) {
      parent.append(host);
      applyLayout();
      // Applied after mount so the opening transition actually runs on a first
      // paint that already has the dock parked above the viewport.
      requestAnimationFrame(() => setOpen(state.open, { silent: true }));
    },

    toggle() { setOpen(!state.open); },
    open() { setOpen(true); },
    close() { setOpen(false); },
    isOpen: () => state.open,

    /** Apply settings changed from the options page without a reload. */
    setLayout(patch) { commitLayout(patch); },

    destroy() {
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('pointerup', onPointerUp);
      host.remove();
    },
  };
}
