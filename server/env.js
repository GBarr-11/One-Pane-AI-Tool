'use strict';

/**
 * Minimal `.env` loader.
 *
 * The repo is deliberately dependency-free, and pulling in `dotenv` to parse
 * twenty lines of KEY=VALUE is not a trade worth making. This is the subset
 * that matters and nothing else.
 *
 * MUST be required before any module that reads `process.env` at load time -
 * `links.js` and `providers/claude.js` both do. In practice that means it is
 * the first require in `server/server.js`, before the pipeline modules.
 *
 * Real values live in `.env`, which is gitignored. `.env.example` is the
 * template and carries no values. Nothing here is logged: a loader that echoes
 * what it loaded is how a credential ends up in a terminal scrollback.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Strip one matched pair of surrounding quotes.
 *
 * Unquoted values also get a trailing `# comment` removed; quoted ones do not,
 * because a `#` inside quotes is part of the value. An API key containing `#`
 * is entirely legal, so this distinction is not academic.
 */
function parseValue(raw) {
  const value = raw.trim();

  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  if (quoted) return quoted[2];

  return value.replace(/\s+#.*$/, '').trim();
}

/**
 * Load `.env` into `process.env`.
 *
 * Existing environment variables always win. A value exported in the shell is
 * a deliberate override for this one run, and a file silently beating it is a
 * genuinely confusing half hour.
 *
 * A missing `.env` is the normal case for the offline demo, not an error.
 *
 * @returns {string[]} names of the variables this call set, for diagnostics.
 *   Names only - never values.
 */
function loadEnv() {
  let contents;
  try {
    contents = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const loaded = [];

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/.exec(trimmed);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (key in process.env) continue;

    const value = parseValue(rawValue);
    if (!value) continue;

    process.env[key] = value;
    loaded.push(key);
  }

  return loaded;
}

module.exports = { loadEnv };
