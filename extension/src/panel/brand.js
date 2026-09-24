/**
 * The One Pane logo, in the three forms the panel needs.
 *
 * Deliberately not SMC's own logo. Sharing Expedient's red is the point; wearing
 * the console's mark would make an extension look like part of the console, and
 * an analyst should always be able to tell which software is talking to them.
 *
 * The mark's colors are literals, not theme tokens: a logo that changes color
 * with light/dark mode stops being a logo. The tile keeps its light fill on the
 * black title bar in both modes.
 */

/** Framed tile with red chevrons around three dots. Title bar and launcher. */
export const LOGO_SVG = `
  <svg class="logo" viewBox="0 0 48 48" aria-hidden="true">
    <rect x="3" y="3" width="42" height="42" rx="11" fill="#F0F0F0" stroke="#323232" stroke-width="3.5"/>
    <path d="M14.5 15.5 7.5 24l7 8.5M33.5 15.5l7 8.5-7 8.5" fill="none" stroke="#F20505" stroke-width="4.2"/>
    <circle cx="18.6" cy="24" r="2.5" fill="#F20505"/>
    <circle cx="24" cy="24" r="2.5" fill="#F20505"/>
    <circle cx="29.4" cy="24" r="2.5" fill="#F20505"/>
  </svg>`;

/**
 * The mark without its frame, in currentColor. For red surfaces - the primary
 * button - where the tile's red chevrons would disappear into the background.
 */
export const GLYPH_SVG = `
  <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 6.5 1.8 12l4.7 5.5M17.5 6.5l4.7 5.5-4.7 5.5"/>
    <circle cx="8.8" cy="12" r="1.55"/>
    <circle cx="12" cy="12" r="1.55"/>
    <circle cx="15.2" cy="12" r="1.55"/>
  </svg>`;

/** "One" in the surrounding ink, "Pane" in Core Red. */
export const WORDMARK = '<span class="word" aria-label="One Pane">One<b>Pane</b></span>';

/**
 * A filled sparkle, for the Polish action.
 *
 * Not the brand glyph: this button does not represent One Pane itself, it
 * represents a single "clean this up" action, and a filled shape reads as
 * that at a glance the way an outlined one would not. Uses its own `.sparkle`
 * class rather than `.glyph` because `.glyph` is styled stroke-only.
 */
export const SPARKLE_SVG = `
  <svg class="sparkle" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M11 2.5 12.6 8.4 18.5 10 12.6 11.6 11 17.5 9.4 11.6 3.5 10 9.4 8.4Z"/>
    <path d="M18.3 14.4 19 16.9 21.5 17.6 19 18.3 18.3 20.8 17.6 18.3 15.1 17.6 17.6 16.9Z"/>
  </svg>`;
