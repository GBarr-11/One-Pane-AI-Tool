/**
 * Settings page: where both backends live, how the panel behaves, and where it
 * sits.
 *
 * Also the fastest way to answer "why is the panel not working?" - it pings
 * both services and says which one is unreachable, so a failure gets attributed
 * to the right system instead of to the extension.
 */

import {
  DEFAULT_OVERLAY, loadConfig, saveConfig, loadOverlayState, saveOverlayState,
  CREDENTIAL_HEADERS, loadCredentials, saveCredentials, credentialsAllowedFor,
} from '../shared/config.js';
import { MSG, sendToBackground } from '../shared/messages.js';

const $ = (id) => document.getElementById(id);

function flash(text) {
  $('status').textContent = text;
  setTimeout(() => { $('status').textContent = ''; }, 1800);
}

async function restore() {
  const config = await loadConfig();
  $('onePane').value = config.backends.onePane;
  $('aiCtrl').value = config.backends.aiCtrl;
  $('side').value = config.side;
  $('theme').value = config.theme;
  $('autoOpen').checked = config.autoOpen;
  $('askEnabled').checked = config.askEnabled;
  $('autoDraft').checked = config.autoDraft;

  const creds = await loadCredentials();
  for (const name of Object.keys(CREDENTIAL_HEADERS)) $(name).value = creds[name];
}

function credentialFields() {
  return Object.fromEntries(Object.keys(CREDENTIAL_HEADERS).map((name) => [name, $(name).value]));
}

async function save() {
  const onePane = $('onePane').value.trim().replace(/\/+$/, '');
  const creds = credentialFields();
  // Refuse up front rather than save a setup the worker will then refuse to use.
  if (Object.values(creds).some((v) => v.trim()) && !credentialsAllowedFor(onePane)) {
    flash('Not saved — credentials need an https:// backend (http only for localhost)');
    return;
  }
  await saveCredentials(creds);

  await saveConfig({
    backends: {
      // Trailing slashes turn every request path into a double slash, which
      // some routers 404 on. Cheaper to strip here than to debug later.
      onePane,
      aiCtrl: $('aiCtrl').value.trim().replace(/\/+$/, ''),
    },
    side: $('side').value,
    theme: $('theme').value,
    autoOpen: $('autoOpen').checked,
    askEnabled: $('askEnabled').checked,
    autoDraft: $('autoDraft').checked,
  });

  flash('Saved');
  checkHealth();
}

/**
 * Put the panel back where it started.
 *
 * `position: null` is the meaningful part - it drops the dragged coordinate so
 * the panel re-anchors to its edge, which is the way back for a panel someone
 * has dragged off a monitor they no longer have.
 */
async function resetPlacement() {
  const { open } = await loadOverlayState();
  await saveOverlayState({ ...DEFAULT_OVERLAY, open });
  flash('Panel reset — reload the ticket page');
}

async function checkHealth() {
  const render = (el, label, result) => {
    const failed = !result || result.error;
    el.className = failed ? 'err' : 'ok';
    el.textContent = failed
      ? `${label} — unreachable (${result?.error || 'no response'})`
      : `${label} — ok${result.mode ? ` · ${result.mode}` : ''}${result.provider ? ` · provider: ${result.provider}` : ''}`;
  };

  try {
    const health = await sendToBackground(MSG.HEALTH);
    render($('healthOnePane'), 'One Pane', health.onePane);
    render($('healthAiCtrl'), 'AI CTRL', health.aiCtrl);
  } catch (err) {
    $('healthOnePane').className = 'err';
    $('healthOnePane').textContent = `Could not reach the background worker: ${err.message}`;
    $('healthAiCtrl').textContent = '';
  }
}

/**
 * Save, then ask the backend to try each credential. Saving first means the
 * test exercises exactly what the panel will send.
 */
async function testCredentials() {
  const out = $('credResults');
  out.innerHTML = '<div>Testing…</div>';
  await save();

  const line = (label, r) => {
    const div = document.createElement('div');
    if (!r || r.ok === null || r.ok === undefined) {
      div.className = 'unset';
      div.textContent = `${label} — not set${r && r.error ? ` (${r.error})` : ''}`;
    } else {
      div.className = r.ok ? 'ok' : 'err';
      const from = { request: 'your key', server: "the server's .env key", shared: 'the shared service account' }[r.source] || '';
      div.textContent = r.ok
        ? `${label} — accepted${from ? ` (${from})` : ''}${r.authenticatedAs ? ` as ${r.authenticatedAs}` : ''}`
        : `${label} — ${r.error}`;
    }
    return div;
  };

  try {
    const result = await sendToBackground(MSG.CHECK_CREDENTIALS);
    out.replaceChildren(
      line('Open WebUI', result.owui),
      line('SMC', result.smc),
      line('Confluence', result.confluence),
    );
    if (result.mode === 'server') {
      const note = document.createElement('div');
      note.className = 'unset';
      note.textContent = 'This backend is in server mode: anything you leave blank falls back to its own .env keys.';
      out.append(note);
    }
  } catch (err) {
    out.replaceChildren(line('Credential check', { ok: false, error: err.message }));
  }
}

async function clearCredentials(names) {
  for (const name of names) $(name).value = '';
  await saveCredentials(credentialFields());
  $('credResults').replaceChildren();
  flash('Removed');
}

$('save').onclick = save;
$('testCreds').onclick = testCredentials;
$('clearSmc').onclick = () => clearCredentials(['smcToken']);
$('clearCreds').onclick = () => clearCredentials(Object.keys(CREDENTIAL_HEADERS));
$('reset').onclick = resetPlacement;

restore().then(checkHealth);
