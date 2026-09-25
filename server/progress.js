'use strict';

/**
 * Live progress for a draft or an Ask answer: which step the pipeline is on.
 *
 * A draft is 10-25 s of waiting, almost all of it on the AI gateway. A panel
 * that says "Checking which SOPs apply - 8 candidates" reads as working; a
 * spinner reads as stuck. So every stage reports when it starts and when it
 * finishes, with a short count ("6 similar · 1 linked"). Details are counts
 * and states only - never ticket text, titles, or anything from a note.
 *
 * TRANSPORT. A caller that sends `"progress": true` gets the response as
 * NDJSON: one `{"type":"progress", ...}` line per stage change, then exactly
 * one `{"type":"result","status":200,"data":{...}}` (or status 4xx/5xx with
 * `data.error`). The status travels in the last line because the HTTP status
 * is sent with the first. Without the flag the response is the same single
 * JSON body as always, so tests, the Control Center, and curl are unchanged.
 */

/** Stage ids -> what the panel says. Ordered as the pipeline runs them. */
const STAGES = {
  ticket: 'Reading the ticket',
  expand: 'Working out what to search for',
  techdocs: 'Searching TechDocs',
  history: 'Searching SMC ticket history',
  relevance: 'Checking which SOPs apply',
  precedent: 'Checking similar tickets',
  draft: 'Writing the draft',
  answer: 'Writing the answer',
  factcheck: 'Checking facts in the draft',
};

const STATES = new Set(['active', 'done', 'skipped', 'error']);

/**
 * A reporter for one request, or a no-op. Safe to call from anywhere in the
 * pipeline: it never throws, so a broken progress stream can never fail a draft.
 *
 * @param {(event: object) => void} [sink]
 * @returns {(stage: string, state: string, detail?: string) => void}
 */
function reporter(sink) {
  if (typeof sink !== 'function') return () => {};
  const started = new Map();
  return (stage, state, detail = '') => {
    if (!STAGES[stage] || !STATES.has(state)) return;
    const now = Date.now();
    if (state === 'active') started.set(stage, now);
    const event = {
      stage,
      label: STAGES[stage],
      state,
      detail: String(detail || '').slice(0, 80),
      ...(state !== 'active' && started.has(stage) ? { ms: now - started.get(stage) } : {}),
    };
    try { sink(event); } catch { /* progress is best-effort */ }
  };
}

/**
 * The response side of one pipeline request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {object} body  the parsed request body
 * @param {(res, status, payload) => void} sendJson  the plain JSON sender
 * @returns {{ report: Function, send: (status: number, payload: object) => void, streaming: boolean }}
 */
function responder(req, res, body, sendJson) {
  const streaming = Boolean(body && body.progress === true);
  if (!streaming) return { report: reporter(null), send: (status, payload) => sendJson(res, status, payload), streaming };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    // Stops a buffering proxy from holding the lines until the end.
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  const line = (obj) => {
    if (closed || res.writableEnded) return;
    res.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    streaming,
    report: reporter((event) => line({ type: 'progress', ...event })),
    send: (status, payload) => {
      line({ type: 'result', status, data: payload });
      if (!res.writableEnded) res.end();
    },
  };
}

/** "3 kept · 5 hidden", dropping zero parts: "3 kept". */
function counts(parts) {
  return parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(' · ');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

module.exports = {
  STAGES, reporter, responder, counts, plural,
};
