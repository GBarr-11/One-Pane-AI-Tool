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
import { LOGO_SVG, WORDMARK } from './brand.js';

/**
 * Gap kept between the dock (or launcher) and the viewport edges, so the
 * rounded corners and shadow stay visible instead of being sliced off.
 */
const EDGE = 8;

/**
 * The visible viewport. `innerWidth`/`innerHeight` include the page's own
 * scrollbars, so clamping to them would tuck the dock's edge underneath one;
 * the root element's client size is the area actually drawn into.
 */
const viewW = () => document.documentElement.clientWidth || window.innerWidth;
const viewH = () => document.documentElement.clientHeight || window.innerHeight;

/**
 * The theme switch, in display order. 'auto' follows the OS light/dark setting
 * and keeps following it - flip the OS at sunset and an open panel flips too.
 */
const THEMES = [
  {
    id: 'light', label: 'Light',
    icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  },
  {
    id: 'auto', label: 'Match system',
    icon: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
  },
  {
    id: 'dark', label: 'Dark',
    icon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  },
];

const THEME_IDS = THEMES.map((t) => t.id);

/**
 * @param {object} options
 * @param {{element: HTMLElement}} options.content  panel content to host
 * @param {object} options.layout  {side, width, height, margin, position}
 * @param {boolean} [options.open] start expanded
 * @param {'light'|'dark'|'auto'} [options.theme]
 * @param {(layout: object) => void} [options.onLayoutChange]
 * @param {(open: boolean) => void} [options.onOpenChange]
 * @param {(theme: string) => void} [options.onThemeChange]
 */
export function createOverlay({
  content, layout, open = false, theme = 'light', onLayoutChange, onOpenChange, onThemeChange,
}) {
  const host = document.createElement('div');
  host.id = 'one-pane-overlay';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `${OVERLAY_CSS}\n${PANEL_CSS}`;

  const launcher = document.createElement('button');
  launcher.className = 'launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Open One Pane');
  launcher.innerHTML = `${LOGO_SVG}${WORDMARK}`;

  const dock = document.createElement('section');
  dock.className = 'dock';
  dock.setAttribute('role', 'complementary');
  dock.setAttribute('aria-label', 'One Pane');
  dock.innerHTML = `
    <header class="grip" data-el="grip">
      ${LOGO_SVG}
      <div class="title">${WORDMARK}</div>
      <span class="ticket-badge" data-el="ticket"></span>
      <div class="theme" role="radiogroup" aria-label="Theme">
        ${THEMES.map((t) => `
          <button type="button" role="radio" data-theme="${t.id}" title="${t.label}" aria-label="${t.label}">
            <svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg>
          </button>`).join('')}
      </div>
      <button class="icon-btn" type="button" data-el="collapse" title="Collapse" aria-label="Collapse">▲</button>
    </header>
    <div class="content" data-el="content"></div>`;

  dock.querySelector('[data-el="content"]').append(content.element);
  root.append(style, launcher, dock);

  const state = {
    open,
    layout: { ...layout },
    theme: THEME_IDS.includes(theme) ? theme : 'light',
  };

  /* ---------------- theme ---------------- */

  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  /** Resolve the analyst's choice to what is actually drawn. */
  function applyTheme() {
    const dark = state.theme === 'dark' || (state.theme === 'auto' && systemDark.matches);
    host.setAttribute('data-theme', dark ? 'dark' : 'light');
    dock.querySelectorAll('.theme button').forEach((btn) => {
      btn.setAttribute('aria-checked', String(btn.dataset.theme === state.theme));
    });
  }

  function setTheme(next, { silent = false } = {}) {
    if (!THEME_IDS.includes(next) || next === state.theme) return;
    state.theme = next;
    applyTheme();
    if (!silent) onThemeChange?.(next);
  }

  const onSystemThemeChange = () => { if (state.theme === 'auto') applyTheme(); };
  systemDark.addEventListener('change', onSystemThemeChange);

  dock.querySelectorAll('.theme button').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.theme));
  });

  applyTheme();

  /* ---------------- placement ---------------- */

  function applyLayout() {
    const { side, width, height, margin, position } = state.layout;

    dock.style.width = `${width}px`;
    dock.style.height = `${height}px`;

    if (position) {
      // Rendered clamped, but the stored position is left alone: shrink the
      // window and the dock slides into view, grow it back and the dock
      // returns to where the analyst put it.
      const { x, y } = clampPosition(position.x, position.y);
      placeDock(x, y);
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
      dock.style.maxWidth = `${viewW() - margin * 2}px`;
      dock.style.maxHeight = `${viewH() - margin * 2}px`;
    }

    if (typeof state.layout.launcherX === 'number') {
      // Dragged by the analyst - a fixed x along the top bar, independent of
      // which edge the dock itself anchors to.
      launcher.style.left = `${clampLauncherX(state.layout.launcherX)}px`;
      launcher.style.right = 'auto';
    } else {
      launcher.style.right = side === 'left' ? 'auto' : `${margin}px`;
      launcher.style.left = side === 'left' ? `${margin}px` : 'auto';
    }
  }

  /**
   * Put the dock at (x, y) and cap its size to the space left before the
   * right and bottom edges, so the native resize grip cannot drag it past
   * the viewport either.
   */
  function placeDock(x, y) {
    dock.style.left = `${x}px`;
    dock.style.top = `${y}px`;
    dock.style.right = 'auto';
    dock.style.maxWidth = `${viewW() - x - EDGE}px`;
    dock.style.maxHeight = `${viewH() - y - EDGE}px`;
  }

  /** Keep the launcher fully on screen; it never leaves the top bar. */
  function clampLauncherX(x) {
    const width = launcher.getBoundingClientRect().width || 0;
    return Math.max(EDGE, Math.min(x, viewW() - width - EDGE));
  }

  function commitLayout(patch) {
    state.layout = { ...state.layout, ...patch };
    applyLayout();
    onLayoutChange?.(state.layout);
  }

  /** The size the dock will actually draw at in the current viewport. */
  function dockSize() {
    return {
      w: Math.min(state.layout.width, viewW() - EDGE * 2),
      h: Math.min(state.layout.height, viewH() - EDGE * 2),
    };
  }

  /** Keep the whole dock inside the viewport - no edge is ever cut off. */
  function clampPosition(x, y) {
    const { w, h } = dockSize();
    return {
      x: Math.round(Math.max(EDGE, Math.min(x, viewW() - w - EDGE))),
      y: Math.round(Math.max(EDGE, Math.min(y, viewH() - h - EDGE))),
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
    if (e.target.closest('button')) return; // a header control, not a drag
    const rect = dock.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };

    dock.setAttribute('data-dragging', 'true');
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { x, y } = clampPosition(e.clientX - drag.dx, e.clientY - drag.dy);
    placeDock(x, y);
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
   * element's size, is the important part. The dock is capped to the viewport, so
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

  /* ---------------- launcher drag (horizontal only) ---------------- */

  /**
   * The launcher slides along the top bar but never leaves it: only `left`
   * moves, `top` is untouched. A click still opens the panel - dragging and
   * clicking share the same pointerdown, so a click is only suppressed when
   * the pointer actually moved past a small threshold, and keyboard
   * activation (Enter/Space) never goes through pointer events at all, so it
   * keeps working unchanged.
   *
   * Moving the launcher also re-homes the dock: it will next drop down
   * centred under wherever the launcher was left. That is the only time the
   * dock moves on its own - a later drag of the dock itself sticks.
   */
  let launcherDrag = null;
  let launcherJustDragged = false;

  launcher.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const rect = launcher.getBoundingClientRect();
    launcherDrag = { startX: e.clientX, offsetX: e.clientX - rect.left, moved: false };
    launcher.setPointerCapture(e.pointerId);
  });

  launcher.addEventListener('pointermove', (e) => {
    if (!launcherDrag) return;
    if (!launcherDrag.moved) {
      if (Math.abs(e.clientX - launcherDrag.startX) < 4) return;
      launcherDrag.moved = true;
      launcher.setAttribute('data-dragging', 'true');
    }
    const x = clampLauncherX(e.clientX - launcherDrag.offsetX);
    launcher.style.left = `${x}px`;
    launcher.style.right = 'auto';
  });

  launcher.addEventListener('pointerup', (e) => {
    if (!launcherDrag) return;
    const { moved } = launcherDrag;
    launcher.releasePointerCapture(e.pointerId);
    launcher.removeAttribute('data-dragging');
    launcherDrag = null;

    if (moved) {
      launcherJustDragged = true;
      const rect = launcher.getBoundingClientRect();
      const centre = rect.left + rect.width / 2;
      commitLayout({
        launcherX: Math.round(rect.left),
        position: clampPosition(centre - dockSize().w / 2, state.layout.margin),
      });
    }
  });

  /* ---------------- events ---------------- */

  launcher.addEventListener('click', () => {
    if (launcherJustDragged) { launcherJustDragged = false; return; }
    setOpen(true);
  });
  dock.querySelector('[data-el="collapse"]').addEventListener('click', () => setOpen(false));

  // Keyboard events are `composed`, so without this they bubble straight out
  // of the shadow root and onto the real page. SMC has its own single-key
  // shortcuts (its "e" hotkey, at minimum) and no way to know a keystroke
  // originated inside a shadow tree rather than a page-level input, so typing
  // in one of our own fields hijacks the host page's navigation instead of
  // the character reaching what the analyst is actually typing into.
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && state.open) setOpen(false);
  });
  root.addEventListener('keyup', (e) => e.stopPropagation());
  root.addEventListener('keypress', (e) => e.stopPropagation());

  // Re-fit to the new viewport. Nothing is persisted here: clamping is a
  // rendering concern, and saving it would lose the analyst's real position.
  const onWindowResize = () => applyLayout();
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

    /** Apply a theme chosen elsewhere - the options page or another tab. */
    setTheme(next) { setTheme(next, { silent: true }); },

    /** Show which ticket the panel is working on; null clears it. */
    setTicketLabel(label) {
      dock.querySelector('[data-el="ticket"]').textContent = label || '';
    },

    destroy() {
      systemDark.removeEventListener('change', onSystemThemeChange);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('pointerup', onPointerUp);
      host.remove();
    },
  };
}
