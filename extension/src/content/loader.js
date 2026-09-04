/**
 * Bootstraps the real content script as an ES module.
 *
 * MV3 content scripts declared in the manifest are classic scripts - they
 * cannot use `import`. Loading the entry point through a dynamic import buys
 * real modules, which is what lets the content script and the service worker
 * share src/shared/ rather than keeping two copies of the same constants.
 */

import(chrome.runtime.getURL('src/content/content-script.js'))
  .catch((err) => console.error('[One Pane] Failed to load:', err));
