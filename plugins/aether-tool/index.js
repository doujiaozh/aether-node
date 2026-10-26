/**
 * aether-tool — DSH plugin entry.
 *
 * Registers one model-facing tool, `run_in_aether_vm`, that evaluates
 * JavaScript inside an aether-node sandboxed micro-VM by calling the node's
 * HTTP JSON-RPC (`vm.execute`). aether-node is a separate local-first
 * process: boot it from its repository with `npm run demo:web` and point this
 * plugin at its URL (the `endpoint` config field).
 *
 * Shape follows the official plugin contract (packages like
 * dsh-plugin-debugging were used as the reference):
 * - `name` + `apply(ctx, config)` (+ optional `inject`);
 * - the tool is contributed through the `tools` service, so `tools` is a
 *   hard dependency — without it the plugin has nothing to offer;
 * - `apply` tolerates a missing `tools` service (returns instead of
 *   throwing) and a plain-object `config` (tests call `apply` without a
 *   host) — resolution of defaults lives in `vm.js` so both paths agree;
 * - `execute` never throws: failures come back as structured results so the
 *   model always sees a usable verdict.
 */

import { createRunInAetherVmTool, resolvePluginConfig } from './vm.js';

/** Cordis plugin name (used by the loader for diagnostics). */
export const name = 'aether-tool';

/**
 * Services this plugin needs. `tools` is the only one — everything else
 * (endpoints, timeouts) is plugin config, not a host service.
 */
export const inject = ['tools'];

export { Config } from './config.js';
export { createRunInAetherVmTool, resolvePluginConfig } from './vm.js';

/**
 * Mount point.
 *
 * @param ctx host context; `ctx.tools` is the only service touched.
 * @param config plugin config (Schemastery-resolved in the host; a plain
 * object in tests — defaults are filled in either way).
 */
export function apply(ctx, config = {}) {
  if (ctx?.tools === undefined) return;
  ctx.tools.register(createRunInAetherVmTool(resolvePluginConfig(config)));
}
