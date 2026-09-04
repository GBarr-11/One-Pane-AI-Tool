/**
 * Styling for the overlay shell and the panel content, exported as strings
 * because both are injected into one shadow root - a <link> would be another
 * round trip and another thing for a host page's CSP to block.
 *
 * The shadow boundary is doing real work: SMC's stylesheet cannot reach in and
 * break the panel, and nothing here can leak out and disturb a console we are
 * not allowed to modify.
 *
 * Brand red is a token rather than a literal so a corrected hex is a one-line
 * change. Note what is NOT branded: the confidence pills stay green/amber/red.
 * Those colors carry meaning, and a high-confidence draft badged in the same
 * red as an error reads as a warning at a glance.
 */

const TOKENS = /* css */ `
  --op-red: #d0212b;
  --op-red-dark: #a81a22;
  --op-red-tint: #fdeced;
  --op-red-line: #f6cdd0;

  --op-ink: #1f2024;
  --op-muted: #6b6b74;
  --op-faint: #8d8d97;
  --op-line: #e6e6ec;
  --op-wash: #f8f8fa;
`;

/** The floating shell: launcher tab, drop-down dock, drag handle, resize grip. */
export const OVERLAY_CSS = /* css */ `
  :host {
    all: initial;
    ${TOKENS}
    position: fixed;
    inset: 0;
    /* The host spans the viewport but must never swallow clicks meant for the
       page underneath - only the launcher and dock opt back in. */
    pointer-events: none;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--op-ink);
  }

  * { box-sizing: border-box; }

  .glyph { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }

  /* ---------------- launcher ---------------- */

  .launcher {
    position: absolute;
    top: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 15px 9px;
    background: var(--op-red); color: #fff;
    border: none; border-radius: 0 0 10px 10px;
    font-family: inherit; font-size: 12.5px; font-weight: 700;
    letter-spacing: .01em;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 3px 14px rgba(208, 33, 43, .34);
    transform: translateY(0);
    transition: transform .22s ease, background .15s ease;
  }
  .launcher:hover { background: var(--op-red-dark); }
  .launcher[data-hidden="true"] { transform: translateY(-100%); pointer-events: none; }

  /* ---------------- dock ---------------- */

  .dock {
    position: absolute;
    display: flex; flex-direction: column;
    background: #fff;
    border: 1px solid var(--op-line);
    border-top: 3px solid var(--op-red);
    border-radius: 12px;
    box-shadow: 0 18px 48px rgba(20, 20, 40, .22), 0 2px 8px rgba(20, 20, 40, .08);
    overflow: hidden;
    resize: both;
    min-width: 320px; min-height: 260px;
    max-width: 92vw; max-height: 92vh;
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
    padding: 11px 12px 11px 14px;
    background: #fff;
    border-bottom: 1px solid var(--op-line);
    cursor: grab;
    flex: none;
  }
  .grip:active { cursor: grabbing; }

  .mark {
    width: 25px; height: 25px; border-radius: 7px;
    background: var(--op-red); color: #fff;
    display: flex; align-items: center; justify-content: center;
    flex: none;
  }
  .grip .title { font-size: 13.5px; font-weight: 700; flex: 1; letter-spacing: .01em; }

  .icon-btn {
    background: none; border: none;
    color: var(--op-muted); font-size: 15px; line-height: 1;
    padding: 4px 7px; border-radius: 6px;
    cursor: pointer; font-family: inherit;
  }
  .icon-btn:hover { background: var(--op-red-tint); color: var(--op-red); }

  .content { flex: 1; overflow-y: auto; }

  /* The native resize grip is invisible over a white card; mark the corner. */
  .dock::after {
    content: '';
    position: absolute; right: 3px; bottom: 3px;
    width: 10px; height: 10px;
    border-right: 2px solid #d3d3dc;
    border-bottom: 2px solid #d3d3dc;
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
    padding: 10px 12px;
    font-size: 12.5px; font-weight: 600;
    color: var(--op-muted);
    background: none; border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer; font-family: inherit;
  }
  .tab:hover { color: var(--op-ink); }
  .tab[aria-selected="true"] { color: var(--op-red); border-bottom-color: var(--op-red); }

  .body { padding: 15px; font-size: 13px; line-height: 1.5; }

  .sub { color: var(--op-muted); margin-bottom: 13px; }
  .label {
    font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--op-faint);
    margin: 15px 0 7px;
  }

  button.primary {
    width: 100%;
    background: var(--op-red); color: #fff;
    border: none; border-radius: 9px;
    padding: 11px;
    font-size: 13.5px; font-weight: 700; font-family: inherit;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(208, 33, 43, .26);
  }
  button.primary:hover:not(:disabled) { background: var(--op-red-dark); }
  button.primary:disabled { opacity: .6; cursor: default; }

  button.ghost {
    background: #fff; color: var(--op-ink);
    border: 1px solid var(--op-line); border-radius: 8px;
    padding: 7px 12px;
    font-size: 12px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  button.ghost:hover { background: var(--op-wash); border-color: #d8d8e0; }

  .actions { display: flex; gap: 8px; margin-top: 13px; }

  /* ---------------- tone chips ---------------- */

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    background: #fff; color: var(--op-muted);
    border: 1px solid var(--op-line); border-radius: 999px;
    padding: 5px 11px;
    font-size: 11.5px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .chip:hover { border-color: var(--op-red-line); color: var(--op-ink); }
  .chip[aria-pressed="true"] {
    background: var(--op-red-tint);
    border-color: var(--op-red-line);
    color: var(--op-red-dark);
  }

  /* ---------------- status ---------------- */

  .status {
    display: flex; align-items: flex-start; gap: 7px;
    padding: 9px 11px; border-radius: 8px;
    font-size: 12.5px; font-weight: 600;
    margin-bottom: 13px;
  }
  .status.ok  { background: #eaf6ee; color: #1a7f37; }
  .status.err { background: var(--op-red-tint); color: #a11119; }

  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11.5px; font-weight: 700;
    padding: 5px 10px; border-radius: 20px;
  }
  .pill .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .pill.high   { background: #eaf6ee; color: #1a7f37; } .pill.high .dot   { background: #1a7f37; }
  .pill.medium { background: #fff4e5; color: #a35b06; } .pill.medium .dot { background: #d97706; }
  .pill.low    { background: var(--op-red-tint); color: #a11119; } .pill.low .dot { background: var(--op-red); }

  .heads-up {
    background: #fffaf0; border: 1px solid #fde8c4;
    border-radius: 8px; padding: 10px 11px;
    font-size: 12px; color: #7a4a06;
    margin-top: 11px;
  }
  .heads-up strong { display: block; margin-bottom: 3px; }

  /* ---------------- sources ---------------- */

  .source {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 9px 0; border-top: 1px solid var(--op-line);
  }
  .source:first-of-type { border-top: none; }
  .source .name { font-weight: 600; font-size: 12.5px; }
  .source a.name { color: var(--op-red-dark); text-decoration: none; }
  .source a.name:hover { text-decoration: underline; }
  .source a.name::after { content: ' ↗'; font-size: 10px; color: var(--op-faint); }
  .source .tag { font-size: 11px; color: var(--op-faint); }
  .source .score {
    margin-left: auto;
    font-size: 11px; font-weight: 700; color: var(--op-muted);
    font-variant-numeric: tabular-nums;
  }

  .meta {
    margin-top: 13px; padding-top: 11px;
    border-top: 1px solid var(--op-line);
    font-size: 11px; color: var(--op-faint);
  }

  /* ---------------- inputs ---------------- */

  textarea {
    width: 100%; min-height: 62px; resize: vertical;
    border: 1px solid var(--op-line); border-radius: 9px;
    padding: 9px 10px;
    font-family: inherit; font-size: 12.5px; line-height: 1.45;
    margin-bottom: 9px;
    color: var(--op-ink);
  }
  textarea:focus {
    outline: 2px solid var(--op-red-line); outline-offset: -1px;
    border-color: var(--op-red-line);
  }

  .answer {
    background: var(--op-wash); border: 1px solid var(--op-line);
    border-radius: 9px; padding: 12px;
    font-size: 12.5px; line-height: 1.55;
    white-space: pre-wrap; word-break: break-word;
  }

  .citations { margin-top: 10px; font-size: 11px; color: var(--op-faint); }
  .citations ul { margin: 4px 0 0; padding-left: 16px; }
  .citations li { margin-top: 3px; }

  .spinner {
    width: 13px; height: 13px;
    border: 2px solid rgba(255, 255, 255, .4);
    border-top-color: #fff; border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .hint { margin-top: 11px; font-size: 11.5px; color: var(--op-faint); text-align: center; }
`;
