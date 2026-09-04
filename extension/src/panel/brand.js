/**
 * The One Pane mark.
 *
 * A screen with a panel docked to its right edge - which is literally what the
 * product is, and reads at 15px where a more detailed glyph would not.
 *
 * Deliberately not SMC's own logo. Sharing Expedient's red is the point; wearing
 * the console's mark would make an extension look like part of the console, and
 * an analyst should always be able to tell which software is talking to them.
 */

export const MARK_SVG = `
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4.5" width="18" height="15" rx="2.5"/>
    <path d="M14.5 4.5v15"/>
  </svg>`;
