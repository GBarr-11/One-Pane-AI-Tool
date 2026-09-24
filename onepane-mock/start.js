'use strict';

/**
 * Run One Pane with the mock pack installed.
 *
 *   npm run mock            mock tickets and console; provider and KB from .env
 *   npm run mock:offline    everything offline - mock provider, mock techdocs
 *
 * This is the production server, unchanged, with the dev pack plugged in. The
 * only differences are what the pack adds: the five demo tickets, the mock
 * techdocs and precedent, the offline 'mock' provider, and the stand-in SMC
 * console at /mock-smc/. The Control Center at / shows it is in mock mode.
 */

const offline = process.argv.includes('--offline');

// Before .env loads: env.js never overrides a variable already set, so these
// win over whatever .env says - which is the point of --offline.
if (offline) {
  process.env.ONEPANE_PROVIDER = 'mock';
  process.env.ONEPANE_KB_SOURCE = 'mock';
}

require('../server/env').loadEnv();
require('./pack').installMockPack();
require('../server/server').start();
