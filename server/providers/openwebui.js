'use strict';

/**
 * Draft generation via Expedient's Open WebUI gateway.
 *
 * Activated by ONEPANE_PROVIDER=openwebui. Open WebUI exposes an
 * OpenAI-compatible API (`POST {OWUI_URL}/chat/completions`, Bearer auth), not
 * the Anthropic Messages API, so this cannot reuse the Claude SDK - it speaks
 * the OpenAI wire format with Node's built-in fetch, keeping the repo
 * dependency-free.
 *
 * The prompts are shared with the claude provider on purpose: the system
 * prompt, trust-boundary fencing, and steering rules are the product; the
 * transport is not.
 *
 * The gateway and model come from `.env` (gitignored), never from the caller:
 *   OWUI_URL       Open WebUI host plus `/api`, no trailing slash
 *   ONEPANE_MODEL  optional override; a model ID from `GET {OWUI_URL}/models`
 *
 * The API key is the caller's, via credentials.js: the key sent with this
 * request, or OWUI_API_KEY from `.env` in server mode only. Sent as
 * `Authorization: Bearer ...`; never logged or echoed.
 */

const { sanitizeHtml } = require('../sanitize');
const credentials = require('../credentials');
const {
  SYSTEM_PROMPT, buildUserMessage, buildRevisionMessage,
  ASK_SYSTEM_PROMPT, buildAskMessage,
  POLISH_SYSTEM_PROMPT, buildPolishMessage,
  SUGGEST_SYSTEM_PROMPT, buildSuggestMessage, parseSuggestions,
} = require('./claude');

/** An analyst is waiting on this; fail visibly rather than hang the panel. */
const TIMEOUT_MS = 90_000;

/** Used when ONEPANE_MODEL is unset. An ID from the gateway's own model list. */
const DEFAULT_MODEL = 'gpt-5.6-luna';

function config() {
  const baseUrl = (process.env.OWUI_URL || '').trim().replace(/\/+$/, '');
  const apiKey = credentials.get('owuiKey');
  const model = (process.env.ONEPANE_MODEL || '').trim() || DEFAULT_MODEL;

  if (!baseUrl) throw new Error('The openwebui provider needs OWUI_URL set on the server - see .env.example.');
  if (!apiKey) throw new Error(credentials.missingMessage('owuiKey'));
  return { baseUrl, apiKey, model };
}

/**
 * Reasoning models served through Open WebUI can prefix their answer with a
 * `<think>` block. That is scratch work, not reply text - it must never reach
 * the reply box.
 *
 * The fence-language tag is matched generically (```html, ```json, or none) -
 * this is shared by draft/answer/polish (HTML) and suggest (JSON) output, and
 * a regex that only recognized `html` left a stray `json` token glued to the
 * front of every fenced suggestion response, which then failed to parse.
 */
function extractReply(content) {
  return String(content || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function generate({
  ctx, docs, precedent, linked = [], confidence, tones = [], instruction = '', previousDraft = null,
}) {
  const { baseUrl, apiKey, model } = config();

  const userMessage = previousDraft
    ? buildRevisionMessage(ctx, previousDraft, tones, instruction)
    : buildUserMessage(ctx, docs, precedent, confidence, tones, instruction, linked);

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Open WebUI did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    // Network-level failure: wrong host, VPN down, TLS problem.
    throw new Error(`Could not reach Open WebUI at ${baseUrl} - ${err.cause?.code || err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(credentials.rejectedMessage('owuiKey', 'Open WebUI'));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Open WebUI error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    // Usually means OWUI_URL is missing `/api` and hit the web UI's HTML instead.
    throw new Error('Open WebUI returned a non-JSON response - check that OWUI_URL ends in /api.');
  }

  const choice = body.choices && body.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Open WebUI returned no completion.');
  }
  if (choice.finish_reason === 'content_filter') {
    throw new Error('The model declined to draft a reply for this ticket.');
  }

  return {
    html: sanitizeHtml(extractReply(choice.message.content)),
    intent: previousDraft ? 'model_revised' : 'model_generated',
    provider: 'openwebui',
    model: body.model || model,
    usage: body.usage
      ? {
        input: body.usage.prompt_tokens ?? 0,
        output: body.usage.completion_tokens ?? 0,
        cacheRead: 0,
      }
      : null,
  };
}

/**
 * "Suggest a next step" - same transport as `generate()`, the triage prompt
 * instead of the drafting one, and deliberately cheap: analyst-initiated (a
 * button), meant to feel instant.
 *
 * Throws on any failure - server/generate.js's getSuggestions() catches that
 * and falls back to the deterministic heuristic in server/suggestions.js.
 */
async function suggest({ ctx, docs, precedent, confidence }) {
  const { baseUrl, apiKey, model } = config();

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
          { role: 'user', content: buildSuggestMessage(ctx, docs, precedent, confidence) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Open WebUI did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Could not reach Open WebUI at ${baseUrl} - ${err.cause?.code || err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(credentials.rejectedMessage('owuiKey', 'Open WebUI'));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Open WebUI error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('Open WebUI returned a non-JSON response - check that OWUI_URL ends in /api.');
  }

  const choice = body.choices && body.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Open WebUI returned no completion.');
  }

  const suggestions = parseSuggestions(extractReply(choice.message.content));
  if (!suggestions) throw new Error('Model did not return usable suggestions');

  return { suggestions, provider: 'openwebui', model: body.model || model };
}

/** Same transport as `generate()`, the Q&A prompt instead of the drafting one. */
async function answer({ ctx, question, docs = [] }) {
  const { baseUrl, apiKey, model } = config();

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: ASK_SYSTEM_PROMPT },
          { role: 'user', content: buildAskMessage(ctx, question, docs) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Open WebUI did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Could not reach Open WebUI at ${baseUrl} - ${err.cause?.code || err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(credentials.rejectedMessage('owuiKey', 'Open WebUI'));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Open WebUI error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('Open WebUI returned a non-JSON response - check that OWUI_URL ends in /api.');
  }

  const choice = body.choices && body.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Open WebUI returned no completion.');
  }

  return {
    text: extractReply(choice.message.content),
    provider: 'openwebui',
    model: body.model || model,
    usage: body.usage
      ? {
        input: body.usage.prompt_tokens ?? 0,
        output: body.usage.completion_tokens ?? 0,
        cacheRead: 0,
      }
      : null,
  };
}

/** Same transport again, the polish prompt in place of drafting or Q&A. */
async function polish({ text }) {
  const { baseUrl, apiKey, model } = config();

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: POLISH_SYSTEM_PROMPT },
          { role: 'user', content: buildPolishMessage(text) },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Open WebUI did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Could not reach Open WebUI at ${baseUrl} - ${err.cause?.code || err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(credentials.rejectedMessage('owuiKey', 'Open WebUI'));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Open WebUI error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('Open WebUI returned a non-JSON response - check that OWUI_URL ends in /api.');
  }

  const choice = body.choices && body.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Open WebUI returned no completion.');
  }

  return {
    html: sanitizeHtml(extractReply(choice.message.content)),
    provider: 'openwebui',
    model: body.model || model,
    usage: body.usage
      ? {
        input: body.usage.prompt_tokens ?? 0,
        output: body.usage.completion_tokens ?? 0,
        cacheRead: 0,
      }
      : null,
  };
}

/**
 * The model and reasoning effort for the small grading calls - query
 * expansion, the SOP relevance check, and the precedent check - which all go
 * through complete(). They sit in series in front of the draft, so their
 * latency is the draft's latency.
 *
 *   ONEPANE_AUX_MODEL      a faster model for them (default: ONEPANE_MODEL)
 *   ONEPANE_AUX_REASONING  reasoning effort for them: minimal (default) | low |
 *                          medium | high | off (send none)
 *
 * Measured 2026-09-25 on a live DNS ticket's relevance check, gpt-5.6-luna:
 * default effort 4.8 s, `minimal` 3.4 s, with the same verdicts. The draft
 * itself keeps ONEPANE_MODEL at its default effort.
 */
function auxConfig(model) {
  const aux = (process.env.ONEPANE_AUX_MODEL || '').trim() || model;
  const effort = String(process.env.ONEPANE_AUX_REASONING ?? 'minimal').trim().toLowerCase();
  return { model: aux, effort: ['minimal', 'low', 'medium', 'high'].includes(effort) ? effort : null };
}

/** Models that reject `reasoning_effort`, learned from a 400; retried without it. */
const noEffort = new Set();

/**
 * A plain completion: caller's system prompt and message in, text out. Used
 * by the relevance checks and query expansion, which own their prompts and
 * parsing so that both providers grade the same way.
 */
async function complete({ system, user }) {
  const { baseUrl, apiKey, model: draftModel } = config();
  const { model, effort } = auxConfig(draftModel);

  const send = (withEffort) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      ...(withEffort ? { reasoning_effort: effort } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  let res;
  try {
    const withEffort = Boolean(effort) && !noEffort.has(model);
    res = await send(withEffort);
    // A model that does not take reasoning_effort answers 400; once is enough to learn that.
    if (withEffort && res.status === 400) {
      const detail = await res.text().catch(() => '');
      if (/reasoning/i.test(detail)) {
        noEffort.add(model);
        res = await send(false);
      } else {
        res = { ok: false, status: 400, text: async () => detail };
      }
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`Open WebUI did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Could not reach Open WebUI at ${baseUrl} - ${err.cause?.code || err.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(credentials.rejectedMessage('owuiKey', 'Open WebUI'));
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Open WebUI error ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('Open WebUI returned a non-JSON response - check that OWUI_URL ends in /api.');
  }

  const choice = body.choices && body.choices[0];
  if (!choice || !choice.message) {
    throw new Error('Open WebUI returned no completion.');
  }

  return { text: extractReply(choice.message.content), provider: 'openwebui', model: body.model || model };
}

module.exports = {
  generate, suggest, answer, polish, complete, extractReply, auxConfig,
};
