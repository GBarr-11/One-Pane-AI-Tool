/**
 * Hand-mirrored subset of `@ai-ctrl/contracts` (packages/contracts/src/index.ts
 * in the AI CTRL repo), expressed as JSDoc so this extension stays dependency-
 * and build-free.
 *
 * THE SOURCE OF TRUTH IS COLE'S PACKAGE, NOT THIS FILE. When this extension
 * moves into the AI CTRL monorepo as `apps/desktop/`, delete these typedefs and
 * `import type { AuthContext } from '@ai-ctrl/contracts'` instead. Until then,
 * any change to his contracts package has to be reflected here by hand - which
 * is exactly why the mirrored surface is kept as small as it is.
 *
 * Mirrored as of the fork taken 2026-09-04 (@ai-ctrl/contracts@1.0.0).
 */

/**
 * @typedef {'SMC' | 'NOC' | 'Security' | 'Engineering'} Discipline
 */

/**
 * @typedef {'Public' | 'Internal' | 'Confidential' | 'Restricted'} DataClassification
 */

/**
 * Who is asking, and what they are allowed to see. Sent with every AI CTRL
 * request; his service scopes tickets and alerts to `authorizedClients` and
 * writes an audit row per query.
 *
 * @typedef {object} AuthContext
 * @property {string} userId
 * @property {string} organizationId
 * @property {Discipline} discipline
 * @property {string[]} authorizedClients
 * @property {string} [email]
 * @property {string} [role]
 * @property {DataClassification} [dataClassificationMaximum]
 */

/**
 * Envelope every AI CTRL tool returns.
 *
 * @template T
 * @typedef {object} ToolResult
 * @property {boolean} success
 * @property {T} data
 * @property {string} [error]
 * @property {{timestamp: string, executionTime?: number}} [metadata]
 * @property {string[]} [citations]
 */

/**
 * Shape returned by `POST /api/query` on the Mastra service.
 *
 * @typedef {object} QueryResponse
 * @property {boolean} success
 * @property {string} [response]   Model answer, plain text / light markdown.
 * @property {string} [error]
 * @property {string[]} [citations]
 * @property {{input_tokens: number, output_tokens: number}} [usage]
 */

/**
 * Placeholder identity used until WorkOS is wired up.
 *
 * Deliberately narrow: no `authorizedClients` means his service scopes the
 * caller to nothing rather than to everything, so a misconfigured extension
 * fails closed instead of quietly reading every client's tickets.
 *
 * @returns {AuthContext}
 */
export function devAuthContext() {
  return {
    userId: 'dev-user',
    organizationId: 'expedient',
    discipline: 'SMC',
    authorizedClients: [],
    dataClassificationMaximum: 'Internal',
  };
}

/**
 * Resolve the caller's identity.
 *
 * TODO(auth): replace with a real WorkOS session. Cole's staging deployment
 * authenticates through WorkOS with discipline+client scoped roles; reusing
 * that same session here is what keeps One Pane from inventing a second
 * identity model. Until then every request is stamped as an unprivileged dev
 * user and his service is expected to reject it in any authenticated
 * environment.
 *
 * @returns {Promise<AuthContext>}
 */
export async function resolveAuthContext() {
  return devAuthContext();
}
