/**
 * Content-script entry point: decide whether this page is a ticket, float the
 * overlay above it, and wire it to the service worker.
 *
 * The orchestration lives here and nowhere else. The adapter knows the DOM, the
 * overlay knows placement, the panel knows the UI, the worker knows the network
 * - this file is the only place that knows about all four.
 */

import { selectProfile, writeDraft, resetDraftTracking, diagnose } from './smc-adapter.js';
import { createOverlay } from '../panel/overlay.js';
import { createPanelContent } from '../panel/panel.js';
import { MSG, sendToBackground } from '../shared/messages.js';
import { loadConfig, loadOverlayState, saveOverlayState } from '../shared/config.js';

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

    async onGenerate({ tones, instruction, previousDraft, replace }) {
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

      writeDraft(profile.findReplyBox(document), result.draftHtml, { replace });
      return result;
    },

    async onAsk(question) {
      return sendToBackground(MSG.ASK_AI_CTRL, {
        query: withTicketContext(question, current),
      });
    },

    onRecheck: () => syncToPage(),
  });

  /** Point the panel at whatever ticket (if any) the page is showing now. */
  function syncToPage() {
    const next = profile.readTicket(document, window.location);
    current = next;

    if (next) content.setTicket({ ticketId: next.ticketId });
    else content.setNoTicket(diagnose(document, window.location));

    return next;
  }

  const overlay = createOverlay({
    content,
    open: config.autoOpen || saved.open,
    layout: {
      side: config.side,
      width: saved.width,
      height: saved.height,
      margin: saved.margin,
      position: saved.position,
    },
    onLayoutChange: ({ width, height, position }) =>
      saveOverlayState({ width, height, position }),
    onOpenChange: (open) => {
      saveOverlayState({ open });
      if (open && config.autoDraft) content.generate();
    },
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
    const side = changes['onePane.config']?.newValue?.side;
    if (side) overlay.setLayout({ side, position: null });
  });
}

/**
 * Name the ticket the analyst is looking at, so pronouns in a question resolve.
 *
 * The AI CTRL agent loads its own ticket and alert corpus and has no notion of
 * "the ticket currently on screen," so "any other open tickets for this client?"
 * is unanswerable without this. Kept as an explicit, visible prefix rather than
 * a hidden system-prompt edit: the analyst should be able to reason about what
 * was actually asked on their behalf.
 */
function withTicketContext(question, ticket) {
  if (!ticket?.ticketId) return question;

  const client = ticket.ticket?.client;
  const subject = ticket.ticket?.subject;

  const context = [
    `I am currently viewing SMC ticket #${ticket.ticketId}`,
    client ? ` for client "${client}"` : '',
    subject ? ` ("${subject}")` : '',
    '.',
  ].join('');

  return `${context}\n\n${question}`;
}

main().catch((err) => console.error('[One Pane] Failed to start:', err));
