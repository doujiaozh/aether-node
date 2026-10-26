/**
 * Plugin config schema (Schemastery) + the single source of the defaults.
 *
 * `resolvePluginConfig()` in `vm.js` reads these same constants, so the
 * schema default and the fallback used by `apply(ctx, plainObject)` can
 * never drift apart.
 */

import z from '@deepseek-ai/schemastery';

/** Default aether-node endpoint: the port `npm run demo:web` binds. */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:40001';

/** Default transport timeout for a `vm.execute` call. */
export const DEFAULT_TIMEOUT_MS = 20_000;

export const Config = z.object({
  endpoint: z
    .string()
    .default(DEFAULT_ENDPOINT)
    .description('Base URL of the running aether-node HTTP RPC, e.g. http://127.0.0.1:40001 (boot it with `npm run demo:web` in the aether-node repo).'),
  timeoutMs: z
    .number()
    .default(DEFAULT_TIMEOUT_MS)
    .description('Default per-call timeout in milliseconds; the sandbox clamps effective values to [50, 30000].'),
});
