/**
 * Styling for the overlay shell and the panel content, exported as strings
 * because both are injected into one shadow root - a <link> would be another
 * round trip and another thing for a host page's CSP to block.
 *
 * The shadow boundary is doing real work: SMC's stylesheet cannot reach in and
 * break the panel, and nothing here can leak out and disturb a console we are
 * not allowed to modify.
 *
 * Palette is the Expedient core set: Core Red, Core Black, Core White, and the
 * Charcoal / Steel / Smoke / Cloud neutrals. The accent colors stay out, with
 * one exception - confidence. Its meter is green / Pulse Amber / Core Red,
 * because those colors carry meaning at a glance; the bar count carries the
 * same meaning for anyone who cannot tell them apart. The green is not in the
 * brand book.
 *
 * Light and dark are one set of rules over two sets of token values. The
 * overlay resolves the analyst's choice (light, dark, or follow the OS) to a
 * `data-theme` attribute on the host; nothing below this block should need a
 * per-theme rule.
 */

/** Values that do not change with the theme. */
const BRAND = /* css */ `
  --op-red: #F20505;
  --op-red-dark: #C20404;
  --op-amber: #F48C06;
  --op-green: #1F9D55;

  /* The title bar and launcher are black in both modes, so the logo and the
     theme switch look the same whichever is on. */
  --op-bar: #000000;
  --op-bar-line: #323232;
  --op-bar-ink: #FFFFFF;
  --op-bar-muted: #8C8C8C;
`;

const LIGHT = /* css */ `
  color-scheme: light;
  --op-bg: #FFFFFF;
  --op-surface: #F0F0F0;
  --op-ink: #000000;
  --op-muted: #646464;
  --op-faint: #767676;
  --op-line: #D2D2D2;
  --op-line-soft: #F0F0F0;
  --op-field: #FFFFFF;
  --op-hover: #F0F0F0;
  --op-chip-on-bg: #000000;
  --op-chip-on-ink: #FFFFFF;
  --op-track: #D2D2D2;
  --op-danger-bg: #FDECEC;
  --op-danger-ink: #B80404;
  --op-shadow: 0 20px 50px rgba(0, 0, 0, .22), 0 2px 8px rgba(0, 0, 0, .08);
`;

const DARK = /* css */ `
  color-scheme: dark;
  --op-bg: #000000;
  --op-surface: #161616;
  --op-ink: #FFFFFF;
  --op-muted: #9A9A9A;
  --op-faint: #8C8C8C;
  --op-line: #323232;
  --op-line-soft: #1F1F1F;
  --op-field: #161616;
  --op-hover: #1F1F1F;
  --op-chip-on-bg: #FFFFFF;
  --op-chip-on-ink: #000000;
  --op-track: #323232;
  --op-danger-bg: rgba(242, 5, 5, .16);
  --op-danger-ink: #FF6B6B;
  --op-shadow: 0 24px 60px rgba(0, 0, 0, .5);
`;

/** The floating shell: launcher tab, drop-down dock, drag handle, resize grip. */
export const OVERLAY_CSS = /* css */ `
  :host {
    all: initial;
    ${BRAND}
    ${LIGHT}
    position: fixed;
    inset: 0;
    /* The host spans the viewport but must never swallow clicks meant for the
       page underneath - only the launcher and dock opt back in. */
    pointer-events: none;
    z-index: 2147483647;
    /* Inter is the brand face. It is used when installed; otherwise the
       platform UI font, which keeps the panel off the network inside SMC. */
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--op-ink);
  }
  :host([data-theme="dark"]) { ${DARK} }

  * { box-sizing: border-box; }

  .glyph { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2.4; flex: none; }
  .glyph circle { fill: currentColor; stroke: none; }
  .logo { display: block; flex: none; }

  .word { font-weight: 800; letter-spacing: -.03em; }
  .word b { font-weight: inherit; color: var(--op-red); }

  :focus-visible { outline: 2px solid var(--op-red); outline-offset: 2px; }

  /* ---------------- launcher ---------------- */

  .launcher {
    position: absolute;
    top: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 7px 12px 7px 7px;
    background: var(--op-bar); color: var(--op-bar-ink);
    /* Red edge rather than a red tab: the logo's chevrons are red and would
       vanish into one. A real border (not a strip along the bottom) so the red
       follows the rounded corners and runs up both sides at an even width. */
    border: 2px solid var(--op-red); border-top: none;
    border-radius: 0 0 10px 10px;
    font-family: inherit; font-size: 13px;
    cursor: grab;
    /* Horizontal drag only - let the browser own vertical touch scroll. */
    touch-action: pan-y;
    pointer-events: auto;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .28);
    transform: translateY(0);
    transition: transform .22s ease, background .15s ease;
  }
  .launcher[data-dragging="true"] { cursor: grabbing; transition: none; }
  .launcher .logo { width: 20px; height: 20px; }
  .launcher:hover { background: #1A1A1A; }
  /* Past its own height plus the shadow's blur, so no dark smudge is left
     peeking along the top edge while the dock is open. */
  .launcher[data-hidden="true"] { transform: translateY(calc(-100% - 24px)); pointer-events: none; }

  /* ---------------- dock ---------------- */

  .dock {
    position: absolute;
    display: flex; flex-direction: column;
    background: var(--op-bg);
    color: var(--op-ink);
    border-top: 3px solid var(--op-red);
    border-radius: 10px;
    box-shadow: var(--op-shadow);
    overflow: hidden;
    resize: both;
    min-width: 320px; min-height: 260px;
    /* Overridden inline from the dock's position so it never outgrows the
       viewport; this is only the fallback before the first layout pass. */
    max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
    pointer-events: auto;

    /* Parked above the top edge until opened - this is the drop-down.
     *
     * The transform is relative to the dock's own top, so once the analyst has
     * dragged the panel down the page it no longer clears the viewport when
     * closed. It stays invisible, but an element with opacity:0 is still
     * hit-testable - which is what made clicking the launcher intermittently do
     * nothing: the closed dock was sitting over it, swallowing the click.
     * pointer-events and visibility are what actually take it out of the page. */
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translateY(calc(-100% - 48px));
    transition: transform .34s cubic-bezier(.22, 1, .36, 1),
                opacity .18s ease,
                visibility 0s linear .34s;
  }
  .dock[data-open="true"] {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateY(0);
    transition: transform .34s cubic-bezier(.22, 1, .36, 1),
                opacity .18s ease,
                visibility 0s;
  }

  /* Nothing should animate while the analyst is dragging it. */
  .dock[data-dragging="true"] { transition: none; user-select: none; }

  @media (prefers-reduced-motion: reduce) {
    .dock, .launcher { transition: opacity .12s ease; }
    .dock[data-open="true"] { transform: none; }
  }

  .grip {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 10px 9px 12px;
    background: var(--op-bar); color: var(--op-bar-ink);
    border-bottom: 1px solid var(--op-bar-line);
    cursor: grab;
    flex: none;
  }
  .grip:active { cursor: grabbing; }
  .grip .logo { width: 26px; height: 26px; }
  .grip .title { font-size: 15px; flex: 1; min-width: 0; }

  .ticket-badge {
    font-size: 11px; font-weight: 600;
    color: #D2D2D2;
    border: 1px solid var(--op-bar-line); border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
  }
  .ticket-badge:empty { display: none; }

  /* Light / match system / dark. */
  .theme {
    display: inline-flex; flex: none;
    background: #1A1A1A;
    border: 1px solid var(--op-bar-line); border-radius: 999px;
    padding: 2px;
  }
  .theme button {
    width: 26px; height: 22px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; border-radius: 999px;
    color: var(--op-bar-muted);
    cursor: pointer; padding: 0;
  }
  .theme button:hover { color: var(--op-bar-ink); }
  .theme button[aria-checked="true"] { background: #FFFFFF; color: #000000; }
  .theme svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  .icon-btn {
    background: none; border: none;
    color: var(--op-bar-muted); font-size: 13px; line-height: 1;
    padding: 5px 7px; border-radius: 6px;
    cursor: pointer; font-family: inherit;
  }
  .icon-btn:hover { background: #1F1F1F; color: var(--op-bar-ink); }

  .content { flex: 1; overflow-y: auto; }

  /* The native resize grip is invisible against the panel; mark the corner. */
  .dock::after {
    content: '';
    position: absolute; right: 3px; bottom: 3px;
    width: 10px; height: 10px;
    border-right: 2px solid var(--op-line);
    border-bottom: 2px solid var(--op-line);
    border-bottom-right-radius: 3px;
    pointer-events: none;
  }
`;

/** The panel content: tabs, tone controls, draft results, ask box. */
export const PANEL_CSS = /* css */ `
  .panel { display: flex; flex-direction: column; height: 100%; }

  .tabs { display: flex; border-bottom: 1px solid var(--op-line); flex: none; }
  .tab {
    flex: 1;
    padding: 11px 12px 9px;
    font-size: 12.5px; font-weight: 600;
    color: var(--op-muted);
    background: none; border: none;
    border-bottom: 3px solid transparent;
    cursor: pointer; font-family: inherit;
  }
  .tab:hover { color: var(--op-ink); }
  .tab[aria-selected="true"] { color: var(--op-ink); border-bottom-color: var(--op-red); }

  .body { padding: 16px; font-size: 13px; line-height: 1.5; }

  .sub { color: var(--op-muted); margin-bottom: 13px; }
  .label {
    font-size: 10.5px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: var(--op-muted);
    margin: 16px 0 8px;
  }

  code {
    font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
    background: var(--op-surface); border-radius: 4px; padding: 1px 4px;
  }

  button.primary {
    width: 100%;
    background: var(--op-red); color: #FFFFFF;
    border: none; border-radius: 6px;
    padding: 11px;
    font-size: 13.5px; font-weight: 700; font-family: inherit;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    cursor: pointer;
    box-shadow: 0 3px 12px rgba(242, 5, 5, .28);
  }
  button.primary:hover:not(:disabled) { background: var(--op-red-dark); }
  button.primary:disabled { opacity: .6; cursor: default; }

  button.ghost {
    background: var(--op-bg); color: var(--op-ink);
    border: 1px solid var(--op-line); border-radius: 6px;
    padding: 7px 12px;
    font-size: 12px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  button.ghost:hover { background: var(--op-hover); }

  .actions { display: flex; gap: 8px; margin-top: 14px; }

  /* ---------------- polish ---------------- */

  .sparkle { width: 14px; height: 14px; flex: none; fill: currentColor; }

  button.polish {
    position: relative;
    overflow: hidden;
    width: 100%;
    background: linear-gradient(135deg, #2B2B2B, #000000);
    color: #FFFFFF;
    border: 1px solid #000000; border-radius: 6px;
    padding: 10px;
    font-size: 12.5px; font-weight: 700; font-family: inherit;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    cursor: pointer;
  }
  button.polish:hover:not(:disabled) { background: linear-gradient(135deg, #383838, #0A0A0A); }
  button.polish:disabled { opacity: .6; cursor: default; }

  /* Purely decorative: a soft light sweeping across the button on a loop,
     independent of hover or focus state. */
  button.polish::after {
    content: '';
    position: absolute; top: -60%; left: -35%;
    width: 28%; height: 220%;
    background: linear-gradient(115deg, transparent, rgba(255, 255, 255, .5), transparent);
    transform: rotate(8deg);
    animation: polish-sheen 3.4s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes polish-sheen {
    0%, 12%   { left: -35%; }
    62%, 100% { left: 130%; }
  }
  @media (prefers-reduced-motion: reduce) {
    button.polish::after { display: none; }
  }

  /* ---------------- tone chips ---------------- */

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    background: var(--op-field); color: var(--op-muted);
    border: 1px solid var(--op-line); border-radius: 999px;
    padding: 5px 11px;
    font-size: 11.5px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .chip:hover { color: var(--op-ink); border-color: var(--op-muted); }
  .chip[aria-pressed="true"] {
    background: var(--op-chip-on-bg);
    border-color: var(--op-chip-on-bg);
    color: var(--op-chip-on-ink);
  }

  /* ---------------- suggested replies ---------------- */

  /* Same pill language as .chip (radius, border, colors) but full-width and
     stacked - these are shortcuts to a whole reply, not togglable modifiers,
     so they read as a row of small buttons rather than a tag cloud. */
  .suggestions { display: flex; flex-direction: column; gap: 7px; margin-top: 4px; }
  .suggestion-pill {
    width: 100%;
    background: var(--op-field); color: var(--op-ink);
    border: 1px solid var(--op-line); border-radius: 999px;
    padding: 9px 16px;
    font-size: 12.5px; font-weight: 600; font-family: inherit;
    text-align: center;
    cursor: pointer;
  }
  .suggestion-pill:hover:not(:disabled) { background: var(--op-hover); border-color: var(--op-muted); }
  .suggestion-pill:disabled { opacity: .6; cursor: default; }

  /* The optional, analyst-initiated trigger - full-width like .polish so it
     reads as a secondary action next to Generate, not a tone-chip-style
     toggle. Reuses .ghost's colors, just stretched and centered. */
  .suggest-trigger { width: 100%; margin-top: 4px; padding: 10px 12px; text-align: center; }
  .suggestions + .suggest-trigger { margin-top: 8px; }

  /* ---------------- status ---------------- */

  .status {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 9px 11px; border-radius: 0 6px 6px 0;
    font-size: 12.5px; font-weight: 600;
    margin-bottom: 13px;
  }
  .status.ok  { background: var(--op-surface); border-left: 3px solid var(--op-ink); color: var(--op-ink); }
  .status.err { background: var(--op-danger-bg); border-left: 3px solid var(--op-red); color: var(--op-danger-ink); }
  .status .ck {
    width: 16px; height: 16px; margin-top: 1px; border-radius: 50%; flex: none;
    background: var(--op-ink); color: var(--op-bg);
    font-size: 10px; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
  }

  /* ---------------- confidence ---------------- */

  .conf { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; font-size: 12.5px; font-weight: 700; }
  .conf small { color: var(--op-muted); font-size: 12px; font-weight: 500; }
  .meter { display: inline-flex; gap: 3px; flex: none; }
  .meter i { display: block; width: 18px; height: 6px; border-radius: 1px; background: var(--op-track); }
  .meter.high i                  { background: var(--op-green); }
  .meter.medium i:nth-child(-n+2) { background: var(--op-amber); }
  .meter.low i:first-child        { background: var(--op-red); }

  .heads-up {
    background: var(--op-bg);
    border: 1px solid var(--op-line); border-left: 3px solid var(--op-red);
    border-radius: 0 6px 6px 0;
    padding: 10px 11px;
    font-size: 12px; color: var(--op-muted);
    margin-top: 11px;
  }
  :host([data-theme="dark"]) .heads-up { background: var(--op-surface); }
  .heads-up strong { display: block; margin-bottom: 2px; color: var(--op-ink); }

  /* ---------------- sources ---------------- */

  .source {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 10px 0; border-top: 1px solid var(--op-line-soft);
  }
  .source:first-of-type { border-top: none; }
  .source .name { font-weight: 600; font-size: 12.5px; color: var(--op-ink); }
  .source a.name { text-decoration: none; }
  .source a.name:hover { text-decoration: underline; text-decoration-color: var(--op-red); text-underline-offset: 3px; }
  .source a.name::after { content: ' ↗'; font-size: 11px; color: var(--op-red); }
  .source .tag { font-size: 11px; color: var(--op-muted); }
  .source .kind { font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
  .source .score {
    margin-left: auto;
    font-size: 11px; font-weight: 700; color: var(--op-ink);
    font-variant-numeric: tabular-nums;
  }

  .meta {
    margin-top: 14px; padding-top: 10px;
    border-top: 1px solid var(--op-line-soft);
    font-size: 11px; color: var(--op-faint);
  }

  /* ---------------- inputs ---------------- */

  textarea {
    width: 100%; min-height: 62px; resize: vertical;
    background: var(--op-field);
    border: 1px solid var(--op-line); border-radius: 6px;
    padding: 9px 10px;
    font-family: inherit; font-size: 12.5px; line-height: 1.45;
    margin-bottom: 10px;
    color: var(--op-ink);
  }
  textarea::placeholder { color: var(--op-faint); }
  textarea:focus { outline: 2px solid var(--op-red); outline-offset: -1px; border-color: transparent; }

  .answer {
    background: var(--op-surface); border: 1px solid var(--op-line);
    border-radius: 6px; padding: 12px;
    font-size: 12.5px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
  }

  .citations { margin-top: 10px; font-size: 11px; color: var(--op-muted); }
  .citations strong { color: var(--op-ink); }
  .citations ul { margin: 4px 0 0; padding-left: 16px; }
  .citations li { margin-top: 3px; }

  .spinner {
    width: 13px; height: 13px;
    border: 2px solid rgba(255, 255, 255, .4);
    border-top-color: #FFFFFF; border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .hint { margin-top: 11px; font-size: 11.5px; color: var(--op-faint); text-align: center; }
`;
