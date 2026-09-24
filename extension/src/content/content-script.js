/**
 * Content-script entry point: decide whether this page is a ticket, float the
 * overlay above it, and wire it to the service worker.
 *
 * The orchestration lives here and nowhere else. The adapter knows the DOM, the
 * overlay knows placement, the panel knows the UI, the worker knows the network
 * - this file is the only place that knows about all four.
 */

import {
  selectProfile, writeDraft, readReplyBox, replaceReplyBox, resetDraftTracking, diagnose,
} from './smc-adapter.js';
import { createOverlay } from '../panel/overlay.js';
import { createPanelContent } from '../panel/panel.js';
import { MSG, sendToBackground } from '../shared/messages.js';
import { loadConfig, saveConfig, loadOverlayState, saveOverlayState } from '../shared/config.js';

/** Re-injection guard: SPA navigation can run a content script more than once. */
const MOUNT_FLAG = '__onePaneMounted';

async function main() {
  if (window[MOUNT_FLAG]) return;

  const profile = selectProfile(window.location);
  if (!profile) return;

  // Mount even when no ticket is detected. The SMC selectors have never been
  // run against the real console, so the first attempt there is expected to
  // fail - and a panel that reports what it looked for is the difference
  // between a useful first run and "nothing happened".
  let current = profile.readTicket(document, window.location);

  window[MOUNT_FLAG] = true;

  const [config, saved] = await Promise.all([loadConfig(), loadOverlayState()]);

  const content = createPanelContent({
    askEnabled: config.askEnabled,

    async onGenerate({
      tones, instruction, previousDraft, replace,
    }) {
      // Re-read rather than trusting the ticket captured at mount: on a SPA the
      // analyst may have moved on, and drafting against a stale ticket would
      // put the wrong reply in a real customer's reply box.
      const fresh = profile.readTicket(document, window.location) || current;
      if (!fresh) throw new Error('No ticket detected on this page');

      const result = await sendToBackground(MSG.GENERATE_DRAFT, {
        ticketId: fresh.ticketId,
        ticket: fresh.ticket,
        tones,
        instruction,
        previousDraft,
      });

      const target = profile.findReplyBox(document);
      writeDraft(target?.el, { html: result.draftHtml, text: result.draftText }, { replace });
      return result;
    },

    async onPolish() {
      const box = profile.findReplyBox(document)?.el;
      if (!box) throw new Error('Could not find the reply box on this page');

      const existingText = readReplyBox(box);
      if (!existingText.trim()) throw new Error('Nothing in the reply box to polish yet');

      const result = await sendToBackground(MSG.POLISH_TEXT, { text: existingText });
      replaceReplyBox(box, { html: result.html, text: result.text });
    },

    async onAsk(question) {
      // Same re-read-rather-than-trust-mount reasoning as onGenerate: the
      // analyst may have moved to a different ticket since the panel opened.
      const fresh = profile.readTicket(document, window.location) || current;
      if (!fresh) throw new Error('No ticket detected on this page');

      return sendToBackground(MSG.ASK_AI_CTRL, {
        ticketId: fresh.ticketId,
        ticket: fresh.ticket,
        question,
      });
    },

    /**
     * "Suggest a next step" - the analyst clicked the button. Unlike the rest
     * of this file's calls, the server-side default provider can make a real
     * model call to answer this, so it must only ever run on an explicit
     * click, never automatically off a ticket-detection event.
     */
    async onSuggest() {
      const fresh = profile.readTicket(document, window.location) || current;
      if (!fresh) throw new Error('No ticket detected on this page');

      const result = await sendToBackground(MSG.GET_SUGGESTIONS, {
        ticketId: fresh.ticketId,
        ticket: fresh.ticket,
      });
      return result.suggestions || [];
    },

    /**
     * Start over is a full reset, not just hiding the panel's result - the
     * draft sitting in the reply box is still real, but this extension
     * should stop thinking of it as "ours" to replace. Without this, a
     * Generate after Start over would append a second draft underneath the
     * first instead of replacing it, since `replace` is computed from the
     * panel's own state, which Start over has already cleared.
     */
    onDismiss: () => resetDraftTracking(),

    onRecheck: () => syncToPage(),
  });

  /** Point the panel at whatever ticket (if any) the page is showing now. */
  function syncToPage() {
    const next = profile.readTicket(document, window.location);
    current = next;
    overlay.setTicketLabel(next ? `#${next.ticketId}` : null);

    if (next) content.setTicket({ ticketId: next.ticketId });
    else content.setNoTicket(diagnose(document, window.location));

    return next;
  }

  const overlay = createOverlay({
    content,
    open: config.autoOpen || saved.open,
    theme: config.theme,
    layout: {
      side: config.side,
      width: saved.width,
      height: saved.height,
      margin: saved.margin,
      position: saved.position,
      launcherX: saved.launcherX,
    },
    onLayoutChange: ({ width, height, position, launcherX }) =>
      saveOverlayState({ width, height, position, launcherX }),
    onOpenChange: (open) => {
      saveOverlayState({ open });
      if (open && config.autoDraft) content.generate();
    },
    // A preference, not a placement - it follows the analyst between machines.
    onThemeChange: (theme) => saveConfig({ theme }),
  });

  overlay.mount();
  syncToPage();
  if (current && overlay.isOpen() && config.autoDraft) content.generate();

  profile.onTicketChange(document, () => {
    const previousId = current?.ticketId;
    // The previous ticket's draft nodes belong to a reply box we have left.
    resetDraftTracking();
    const next = syncToPage();
    if (next && next.ticketId !== previousId && overlay.isOpen() && config.autoDraft) {
      content.generate();
    }
  });

  // The toolbar icon toggles the panel on whichever tab is in front.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MSG.TOGGLE_PANEL) overlay.toggle();
  });

  // Settings changed in the options page apply without a reload. The area is
  // not pinned to 'sync' because preferences fall back to local storage where
  // sync is unavailable (see shared/config.js).
  chrome.storage.onChanged.addListener((changes) => {
    const change = changes['onePane.config'];
    if (!change) return;
    const { side, theme } = change.newValue || {};
    if (side && side !== change.oldValue?.side) overlay.setLayout({ side, position: null, launcherX: null });
    if (theme) overlay.setTheme(theme);
  });
}

main().catch((err) => console.error('[One Pane] Failed to start:', err));
