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
  $('autoOpen').checked = config.autoOpen;
  $('askEnabled').checked = config.askEnabled;
  $('autoDraft').checked = config.autoDraft;
}

async function save() {
  await saveConfig({
    backends: {
      // Trailing slashes turn every request path into a double slash, which
      // some routers 404 on. Cheaper to strip here than to debug later.
      onePane: $('onePane').value.trim().replace(/\/+$/, ''),
      aiCtrl: $('aiCtrl').value.trim().replace(/\/+$/, ''),
    },
    side: $('side').value,
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

$('save').onclick = save;
$('reset').onclick = resetPlacement;

restore().then(checkHealth);
