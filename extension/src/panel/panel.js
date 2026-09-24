/**
 * The panel's content: the Draft and Ask tabs.
 *
 * Renders into an element the overlay owns, and knows nothing about where that
 * element sits, how it got there, or how it talks to the network. It takes
 * callbacks and renders what they return - which keeps the three things that
 * break for different reasons (placement, transport, presentation) apart.
 */

import { GLYPH_SVG, SPARKLE_SVG } from './brand.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Only ever emit http(s) hrefs.
 *
 * Source URLs are assembled server-side from configured base URLs, but this
 * panel injects them into markup on a page we do not own - so a `javascript:`
 * URL arriving from a misconfigured or compromised backend must not become a
 * clickable link inside SMC.
 */
function safeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

const CONFIDENCE_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

const SOURCE_TAG = {
  techdoc: 'Techdoc',
  ticket: 'Related ticket',
  thread: 'This ticket',
};

/**
 * Tone presets. These ids are the contract with server/tones.js, which holds the
 * directive text each one expands to - keep the two lists in step.
 */
const TONES = [
  { id: 'formal', label: 'More formal' },
  { id: 'friendly', label: 'Friendlier' },
  { id: 'shorter', label: 'Shorter' },
  { id: 'detailed', label: 'More detailed' },
];

/**
 * @param {object} handlers
 * @param {(opts: {tones: string[], instruction: string, previousDraft: string|null, replace: boolean}) => Promise<object>} handlers.onGenerate
 * @param {(question: string) => Promise<object>} handlers.onAsk
 * @param {() => Promise<void>} handlers.onPolish
 * @param {() => Promise<{label: string, instruction: string}[]>} handlers.onSuggest
 * @param {() => void} [handlers.onDismiss] the analyst hit Start over - clears
 *   this extension's memory of what it last wrote, so a subsequent Generate
 *   replaces it rather than stacking underneath
 * @param {boolean} [handlers.askEnabled]
 */
export function createPanelContent({
  onGenerate, onAsk, onPolish, onSuggest, onDismiss, onRecheck, askEnabled = true,
}) {
  const element = document.createElement('div');
  element.className = 'panel';

  const state = {
    tab: 'draft',
    ticketId: null,
    busy: false,
    result: null,
    error: null,
    answer: null,
    question: '',
    tones: [],
    instruction: '',
    /** "Suggest a next step" pills; [] until the analyst asks for them. */
    suggestions: [],
    suggestBusy: false,
    /** Local to the suggest button - a failed suggestion should not blank
     *  out the rest of the draft tab the way state.error does. */
    suggestError: null,
    /** Set when the adapter could not find a ticket on this page. */
    noTicket: null,
    polishBusy: false,
    /** Brief confirmation flash after a successful polish. */
    polished: false,
  };

  /* ---------------- rendering ---------------- */

  function render() {
    element.innerHTML = `
      ${askEnabled ? `
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="draft" aria-selected="${state.tab === 'draft'}">Draft reply</button>
          <button class="tab" role="tab" data-tab="ask" aria-selected="${state.tab === 'ask'}">Ask AI CTRL</button>
        </div>` : ''}
      <div class="body">${state.tab === 'draft' ? draftTab() : askTab()}</div>`;

    wire();
  }

  /** Tone chips plus the free-text steering box, shared by both draft states. */
  function steeringControls(actionLabel, action) {
    return `
      <div class="label">Tone</div>
      <div class="chips">
        ${TONES.map((t) => `
          <button class="chip" data-tone="${t.id}"
                  aria-pressed="${state.tones.includes(t.id)}">${esc(t.label)}</button>`).join('')}
      </div>

      <div class="label">Or say what to change</div>
      <textarea data-el="instruction" placeholder="e.g. Lead with the resolution, and drop the last paragraph"
                ${state.busy ? 'disabled' : ''}>${esc(state.instruction)}</textarea>

      <button class="primary" data-act="${action}" ${state.busy ? 'disabled' : ''}>
        ${state.busy
          ? `<span class="spinner"></span> ${action === 'revise' ? 'Revising…' : 'Generating…'}`
          : `${GLYPH_SVG} ${esc(actionLabel)}`}
      </button>`;
  }

  /**
   * "Suggest a next step": an optional, analyst-initiated read on the ticket -
   * not shown automatically, since answering it can be a real model call, not
   * just local retrieval. Three states: not asked yet (a ghost trigger
   * button), waiting on an answer, or 1-3 short-labeled pills once it has
   * one, each a one-click shortcut to a full drafted reply in that direction.
   */
  function suggestSection() {
    if (!state.suggestions.length) {
      return `
        <button class="ghost suggest-trigger" data-act="suggest" ${state.busy ? 'disabled' : ''}>
          ${state.suggestBusy ? 'Thinking…' : 'Suggest a next step'}
        </button>
        ${state.suggestError
          ? `<div class="hint" style="color:var(--op-danger-ink)">${esc(state.suggestError)}</div>`
          : !state.suggestBusy
            ? '<div class="hint">Not sure what to send? Reads this ticket and recommends a next step.</div>'
            : ''}`;
    }

    return `
      <div class="label">Suggested replies</div>
      <div class="suggestions">
        ${state.suggestions.map((s, i) => `
          <button class="suggestion-pill" data-suggestion-index="${i}"
                  ${state.busy ? 'disabled' : ''}>${esc(s.label)}</button>`).join('')}
      </div>
      <button class="ghost suggest-trigger" data-act="suggest" ${state.busy ? 'disabled' : ''}>
        ${state.suggestBusy ? 'Thinking…' : 'Suggest again'}
      </button>`;
  }

  /**
   * Shown when the adapter cannot find a ticket on the page.
   *
   * The SMC selectors were written blind, so the first run on the real console
   * is expected to land here. Reporting exactly which detection strategies were
   * tried and what the page actually contains is what makes that run useful -
   * a panel that just fails to appear teaches nobody anything.
   */
  function noTicketView(d) {
    const row = (k, v) => `<div class="source"><div><div class="tag">${esc(k)}</div><div class="name">${esc(v)}</div></div></div>`;

    return `
      <div class="status err">No ticket detected on this page</div>
      <div class="sub">
        One Pane is loaded and running — it just could not work out which ticket
        you are looking at. If this <em>is</em> a ticket page, the details below
        are what is needed to fix the selectors.
      </div>

      <div class="label">Ticket id detection</div>
      ${d.strategies.map((s) => row(s.name, s.found ? `found: ${s.found}` : 'no match')).join('')}

      <div class="label">Page</div>
      ${row('Reply box', d.replyBox.found ? `${d.replyBox.tag} via ${d.replyBox.via}` : 'not found')}
      ${row('Editable fields on page', String(d.editableCount))}
      ${row('Elements matching .ticket-note', String(d.noteCandidates))}
      ${d.headings.length ? row('First headings', d.headings.join(' | ')) : ''}

      <div class="actions">
        <button class="ghost" data-act="copyDiagnostics">Copy details</button>
        <button class="ghost" data-act="recheck">Re-check page</button>
      </div>
      <div class="hint" style="text-align:left">
        Copied details include headings and the URL, which may contain ticket or
        client text. Have a look before sharing them.
      </div>`;
  }

  /**
   * Cleans up whatever is currently in the reply box - a One Pane draft, the
   * analyst's own typing, or a mix - rather than requiring a full regenerate.
   * Independent of `state.result`: it reads the live page, not a stored draft,
   * so it works even before Generate has ever been clicked.
   */
  function polishControl() {
    return `
      <button class="polish" data-act="polish" ${state.busy ? 'disabled' : ''}>
        ${state.polishBusy ? '<span class="spinner"></span> Polishing…' : `${SPARKLE_SVG} Polish`}
      </button>
      <div class="hint">
        ${state.polished ? '✓ Polished. ' : ''}Cleans up grammar and formatting on whatever is
        currently in the reply box.
      </div>`;
  }

  function draftTab() {
    if (state.noTicket) return noTicketView(state.noTicket);

    if (state.error) {
      return `
        <div class="status err">${esc(state.error)}</div>
        <button class="primary" data-act="generate">Try again</button>`;
    }

    if (state.result) return draftResult(state.result);

    return `
      <div class="sub">
        Reads this ticket's notes and the internal techdocs before drafting
        a reply.
      </div>
      ${steeringControls('Generate reply', 'generate')}
      ${suggestSection()}
      <div class="hint">Drafts into the reply box.<br>Nothing is sent automatically.</div>

      <div class="label">Polish</div>
      ${polishControl()}`;
  }

  function draftResult(r) {
    const c = r.confidence || {};
    const level = c.level || 'low';
    const detail = level === 'low'
      ? 'not enough grounding — asked clarifying questions instead'
      : `grounded in ${c.sourceCount} source${c.sourceCount === 1 ? '' : 's'}`;

    const linksOff = r.links && !r.links.tickets && !r.links.techdocs;

    return `
      <div class="status ok"><span class="ck">✓</span>${r.revised ? 'Revised draft written to the reply box' : 'Draft inserted into the reply box'}</div>

      ${r.instructionApplied === false ? `
        <div class="heads-up">
          <strong>Instruction not applied</strong>
          The offline generator can only apply the tone presets. Run the server with
          <code>ONEPANE_PROVIDER=openwebui</code> (or <code>claude</code>) for free-text changes.
        </div>` : ''}

      <div class="label">Confidence</div>
      <div class="conf">
        <span class="meter ${esc(level)}" aria-hidden="true"><i></i><i></i><i></i></span>
        ${CONFIDENCE_LABEL[level] || esc(level)} <small>— ${esc(detail)}</small>
      </div>

      ${(c.reasons || []).length ? `
        <div class="heads-up">
          <strong>Why confidence is limited</strong>${c.reasons.map(esc).join('. ')}.
        </div>` : ''}

      ${r.caveat ? `
        <div class="heads-up">
          <strong>Heads up</strong>${esc(r.caveat.message)}
        </div>` : ''}

      ${r.smcNotice ? `
        <div class="heads-up">
          <strong>SMC not used</strong>${esc(r.smcNotice)}
        </div>` : ''}

      ${steeringControls('Apply changes', 'revise')}

      <div class="label">Sources used</div>
      ${(r.sources || []).map(sourceRow).join('')}
      ${linksOff ? `
        <div class="hint" style="text-align:left">
          Sources link out once <code>SMC_BASE_URL</code> and <code>ONEPANE_KB_BASE_URL</code> are set.
        </div>` : ''}

      <div class="label">Polish</div>
      ${polishControl()}

      <div class="actions">
        <button class="ghost" data-act="dismiss">Start over</button>
      </div>
      <div class="meta">
        ${esc(r.provider)}${r.model ? ` · ${esc(r.model)}` : ''} · ${esc(r.elapsedMs)}ms · intent: ${esc(r.intent)}
      </div>`;
  }

  /**
   * A citation the analyst cannot open in one click is one they will not check,
   * so link every source that has a resolvable URL and leave the rest as text.
   */
  function sourceRow(s) {
    const url = safeUrl(s.url);
    const name = `${esc(s.ref)} — ${esc(s.label)}`;

    return `
      <div class="source">
        <div>
          <div class="tag kind">${esc(SOURCE_TAG[s.kind] || s.kind)}</div>
          ${url
            ? `<a class="name" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
            : `<div class="name">${name}</div>`}
          <div class="tag">${esc(s.detail)}</div>
        </div>
        ${s.score != null ? `<span class="score">${esc(s.score.toFixed(2))}</span>` : ''}
      </div>`;
  }

  function askTab() {
    return `
      <div class="sub">
        Ask about this ticket — answered from its thread and the matching
        Confluence SOPs, nothing else in SMC. Read-only — this never changes anything.
      </div>
      <textarea data-el="question" placeholder="e.g. Summarize what's happened on this ticket so far"
                ${state.busy ? 'disabled' : ''}>${esc(state.question)}</textarea>
      <button class="primary" data-act="ask" ${state.busy ? 'disabled' : ''}>
        ${state.busy ? '<span class="spinner"></span> Asking…' : 'Ask'}
      </button>

      ${state.error ? `<div class="status err" style="margin-top:13px">${esc(state.error)}</div>` : ''}

      ${state.answer ? `
        <div class="label">Answer</div>
        <div class="answer" data-el="answer"></div>
        ${(state.answer.sources || []).length ? `
          <div class="label">Sources used</div>
          ${state.answer.sources.map(sourceRow).join('')}` : ''}
        ${(state.answer.citations || []).length ? `
          <div class="citations">
            <strong>Sources</strong>
            <ul>${state.answer.citations.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
          </div>` : ''}` : ''}`;
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    element.querySelectorAll('.tab').forEach((tab) => {
      tab.onclick = () => {
        state.tab = tab.dataset.tab;
        state.error = null;
        render();
      };
    });

    element.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        const id = chip.dataset.tone;
        state.tones = state.tones.includes(id)
          ? state.tones.filter((t) => t !== id)
          : [...state.tones, id];
        render();
      };
    });

    const instruction = element.querySelector('[data-el="instruction"]');
    if (instruction) {
      instruction.oninput = (e) => { state.instruction = e.target.value; };
      instruction.onkeydown = (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          state.result ? revise() : generate();
        }
      };
    }

    const question = element.querySelector('[data-el="question"]');
    if (question) {
      question.oninput = (e) => { state.question = e.target.value; };
      // Ctrl/Cmd+Enter submits - the analyst is mid-keyboard, and plain Enter
      // has to stay available for multi-line questions.
      question.onkeydown = (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
      };
    }

    // The model's answer is written as text, never as markup: it is untrusted
    // output and this panel has no sanitizer of its own.
    const answer = element.querySelector('[data-el="answer"]');
    if (answer && state.answer) answer.textContent = state.answer.response || '';

    const actions = {
      generate, revise, ask, polish, suggest, dismiss, copyDiagnostics, recheck,
    };
    element.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = actions[btn.dataset.act];
    });

    element.querySelectorAll('[data-suggestion-index]').forEach((btn) => {
      btn.onclick = () => {
        const s = state.suggestions[Number(btn.dataset.suggestionIndex)];
        if (s) useSuggestion(s.instruction);
      };
    });
  }

  /* ---------------- actions ---------------- */

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.revise] rewrite the current draft instead of
   *   starting from the ticket again
   */
  async function run({ revise: isRevision = false } = {}) {
    if (state.busy) return;

    const previous = state.result;
    state.busy = true;
    state.error = null;
    render();

    try {
      state.result = await onGenerate({
        tones: state.tones,
        instruction: state.instruction.trim(),
        previousDraft: isRevision ? previous?.draftHtml || null : null,
        // Anything after the first draft replaces what we already put in the
        // reply box, rather than stacking another copy underneath it.
        replace: Boolean(previous),
      });
    } catch (err) {
      state.error = err.message;
      state.result = previous;
    } finally {
      state.busy = false;
      render();
    }
  }

  const generate = () => run();
  const revise = () => run({ revise: true });

  /**
   * A "Suggest a next step" pill was clicked - populate the same free-text
   * steering box the analyst could have typed into themselves (visible and
   * still editable in the result view) and generate immediately, the same
   * one-click-to-a-full-draft behavior as before.
   */
  function useSuggestion(instruction) {
    state.instruction = instruction;
    run();
  }

  /** "Suggest a next step" / "Suggest again" - always a fresh ask, never cached. */
  async function suggest() {
    if (state.busy) return;

    state.busy = true;
    state.suggestBusy = true;
    state.suggestError = null;
    render();

    try {
      state.suggestions = await onSuggest();
    } catch (err) {
      state.suggestError = err.message;
    } finally {
      state.busy = false;
      state.suggestBusy = false;
      render();
    }
  }

  async function ask() {
    const question = state.question.trim();
    if (!question || state.busy) return;

    state.busy = true;
    state.error = null;
    state.answer = null;
    render();

    try {
      state.answer = await onAsk(question);
    } catch (err) {
      state.error = err.message;
    } finally {
      state.busy = false;
      render();
    }
  }

  /**
   * Back to square one: not just hiding the result, but resetting the tone
   * and instruction steering too, since a leftover "shorter" toggle or a
   * suggestion's instruction still sitting in the box would quietly carry
   * into the next draft otherwise. `onDismiss` clears this extension's own
   * memory of what it wrote, so a later Generate replaces the reply box
   * instead of stacking underneath a draft the panel no longer knows about.
   */
  function dismiss() {
    state.result = null;
    state.tones = [];
    state.instruction = '';
    onDismiss?.();
    render();
  }

  async function polish() {
    if (state.busy) return;

    state.busy = true;
    state.polishBusy = true;
    state.error = null;
    state.polished = false;
    render();

    try {
      await onPolish();
      state.polished = true;
      // A brief confirmation rather than a persistent one - the reply box
      // itself is the real evidence this worked.
      setTimeout(() => { state.polished = false; render(); }, 2400);
    } catch (err) {
      state.error = err.message;
    } finally {
      state.busy = false;
      state.polishBusy = false;
      render();
    }
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(state.noTicket, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      flashCopied('Copied');
    } catch {
      // Clipboard permission is not guaranteed inside a content script on a
      // page we do not control, so fall back to logging rather than failing.
      console.log('[One Pane] diagnostics:\n' + text);
      flashCopied('Written to console');
    }
  }

  function flashCopied(label) {
    const btn = element.querySelector('[data-act="copyDiagnostics"]');
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = label;
    setTimeout(() => { btn.textContent = original; }, 1600);
  }

  function recheck() {
    onRecheck?.();
  }

  render();

  return {
    element,

    /** Draft without a click - used by the autoDraft setting. */
    generate,

    /** No ticket on this page - show what the adapter looked for. */
    setNoTicket(diagnostics) {
      state.noTicket = diagnostics;
      state.result = null;
      state.error = null;
      render();
    },

    /** Called when the analyst moves to a different ticket. */
    setTicket({ ticketId }) {
      state.ticketId = ticketId;
      state.noTicket = null;
      state.result = null;
      state.error = null;
      state.answer = null;
      state.instruction = '';
      // Stale suggestions for the previous ticket would be actively
      // misleading; the analyst re-asks for the new ticket's with the button.
      state.suggestions = [];
      state.suggestBusy = false;
      state.suggestError = null;
      // Tone preferences are a working style, not a property of one ticket, so
      // they deliberately survive the switch.
      render();
    },
  };
}
