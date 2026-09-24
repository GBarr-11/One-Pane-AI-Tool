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
 * Config comes from `.env` (gitignored), never from the caller:
 *   OWUI_URL       Open WebUI host plus `/api`, no trailing slash
 *   OWUI_API_KEY   sent as `Authorization: Bearer ...`; never logged or echoed
 *   ONEPANE_MODEL  optional override; a model ID from `GET {OWUI_URL}/models`
 */

const { sanitizeHtml } = require('../sanitize');
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
  const apiKey = (process.env.OWUI_API_KEY || '').trim();
  const model = (process.env.ONEPANE_MODEL || '').trim() || DEFAULT_MODEL;

  const missing = [];
  if (!baseUrl) missing.push('OWUI_URL');
  if (!apiKey) missing.push('OWUI_API_KEY');
  if (missing.length) {
    throw new Error(`The openwebui provider needs ${missing.join(', ')} set in .env - see .env.example.`);
  }
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
  ctx, docs, precedent, confidence, tones = [], instruction = '', previousDraft = null,
}) {
  const { baseUrl, apiKey, model } = config();

  const userMessage = previousDraft
    ? buildRevisionMessage(ctx, previousDraft, tones, instruction)
    : buildUserMessage(ctx, docs, precedent, confidence, tones, instruction);

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
    throw new Error('Open WebUI rejected the API key - check OWUI_API_KEY.');
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
    throw new Error('Open WebUI rejected the API key - check OWUI_API_KEY.');
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
async function answer({ ctx, question }) {
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
          { role: 'user', content: buildAskMessage(ctx, question) },
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
    throw new Error('Open WebUI rejected the API key - check OWUI_API_KEY.');
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
    throw new Error('Open WebUI rejected the API key - check OWUI_API_KEY.');
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

module.exports = { generate, suggest, answer, polish, extractReply };
