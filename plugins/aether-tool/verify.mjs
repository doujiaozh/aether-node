/**
 * Self-contained smoke test for the aether-tool plugin.
 *
 * Runs without a DSH host: the peer dependencies are swapped for local
 * stubs (tests/stub-loader.mjs) and the backend is a real aether-node
 * AetherWebServer booted from the project's compiled dist/ output. This
 * exercises registration → argument handling → JSON-RPC transport → sandbox
 * execution → structured failures → rendering, end to end.
 *
 * Run from the aether-node repository root, after `npm run build`:
 *
 *   node plugins/aether-tool/verify.mjs
 */

import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register('./tests/stub-loader.mjs', import.meta.url);

const distModule = (name) => new URL(`../../dist/src/${name}/index.js`, import.meta.url).href;

let passed = 0;
const failures = [];

function check(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function checkEqual(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(same, `${message} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function main() {
  const { AetherWebServer } = await import(distModule('web'));
  const { SyncEngine } = await import(distModule('sync-engine'));

  const engine = new SyncEngine({ nodeId: 'verify-backend' });
  const server = new AetherWebServer({ engine, port: 0 });
  const { host, port } = await server.listen();
  const endpoint = `http://${host}:${port}`;
  console.log(`aether-node backend on ${endpoint}`);

  // --- registration ---------------------------------------------------
  const plugin = await import(new URL('./index.js', import.meta.url).href);
  check(plugin.name === 'aether-tool', 'plugin exports name "aether-tool"');
  checkEqual(plugin.inject, ['tools'], 'plugin injects the tools service');

  const registered = [];
  const ctx = { tools: { register: (tool) => registered.push(tool) } };
  plugin.apply(ctx, { endpoint, timeoutMs: 8000 });
  check(registered.length === 1, 'apply registers exactly one tool');
  if (registered.length !== 1) throw new Error('registration failed; nothing to verify');
  const tool = registered[0];
  check(tool.name === 'run_in_aether_vm', 'the registered tool is run_in_aether_vm');
  checkEqual(typeof tool.execute, 'function', 'tool has execute()');
  checkEqual(typeof tool.output?.render, 'function', 'tool declares an output render');

  // `apply` must tolerate a missing tools service instead of throwing.
  plugin.apply({}, { endpoint });
  plugin.apply(undefined, { endpoint });
  check(true, 'apply(ctx without tools) returns instead of throwing');

  const exec = () => ({ signal: new AbortController().signal });

  // --- 1. sandbox success ---------------------------------------------
  let result = await tool.execute({ code: 'return 1 + 1' }, exec());
  check(result.ok === true, '1+1 runs ok');
  checkEqual(result.value, 2, 'value passes through');
  checkEqual(result.status, 'ok', 'status is ok');
  checkEqual(result.endpoint, endpoint, 'result echoes the endpoint');
  check(Array.isArray(result.logs), 'logs are an array');

  // --- 2. sandbox logs -------------------------------------------------
  result = await tool.execute({ code: "console.log('hello'); console.log('world'); return 'done';" }, exec());
  check(result.ok === true, 'logging snippet runs ok');
  checkEqual(result.logs, ['LOG: hello', 'LOG: world'], 'sandbox logs pass through with their level prefix');

  // --- 3. sandbox runtime failure is an envelope, not an exception -----
  result = await tool.execute({ code: 'throw new Error("boom")' }, exec());
  check(result.ok === false, 'a throwing snippet reports ok:false');
  checkEqual(result.status, 'runtime', 'runtime crash surfaces as status "runtime"');
  checkEqual(result.error?.message, 'boom', 'runtime failure carries the VmErrorInfo object');

  // --- 4. sandbox timeout ----------------------------------------------
  result = await tool.execute({ code: 'while (true) {}', timeoutMs: 100 }, exec());
  check(result.ok === false, 'an infinite loop reports ok:false');
  checkEqual(result.status, 'timeout', 'infinite loop surfaces as status "timeout"');

  // --- 5. caller cancellation ------------------------------------------
  const cancelledController = new AbortController();
  cancelledController.abort();
  result = await tool.execute({ code: 'return 1' }, { signal: cancelledController.signal });
  checkEqual(result.status, 'cancelled', 'a pre-aborted signal resolves as cancelled');
  check(result.ok === false, 'cancelled call reports ok:false');

  // --- 6. unreachable endpoint -----------------------------------------
  const dead = [];
  plugin.apply({ tools: { register: (t) => dead.push(t) } }, { endpoint: 'http://127.0.0.1:9', timeoutMs: 2000 });
  result = await dead[0].execute({ code: 'return 1' }, exec());
  check(result.ok === false, 'unreachable endpoint reports ok:false');
  check(['network-error', 'timeout'].includes(result.status), `unreachable endpoint status is network-error or timeout (got ${result.status})`);

  // --- 7. invalid endpoint argument ------------------------------------
  result = await tool.execute({ code: 'return 1', endpoint: 'not a url' }, exec());
  checkEqual(result.status, 'invalid-endpoint', 'a non-URL endpoint argument is rejected');
  check(result.ok === false, 'invalid endpoint reports ok:false');

  // --- 8. invalid code argument ----------------------------------------
  result = await tool.execute({ code: '' }, exec());
  checkEqual(result.status, 'invalid-code', 'empty code is rejected');
  check(result.ok === false, 'invalid code reports ok:false');

  // --- 9. structured value + render ------------------------------------
  result = await tool.execute({ code: "console.log('line'); return { a: [1, 2, 3] };" }, exec());
  const blocks = tool.output.render({ code: 'x' }, result);
  const text = blocks?.[0]?.text ?? '';
  checkEqual(blocks?.length ?? 0, 1, 'render returns exactly one content block');
  check(text.startsWith('[run_in_aether_vm] ok'), 'render header marks success');
  check(text.includes('"a"'), 'render includes the returned value');
  check(text.includes('· LOG: line'), 'render includes sandbox logs');

  result = await tool.execute({ code: 'return 1', endpoint: 'nope' }, exec());
  check(tool.output.render({}, result)[0].text.includes('invalid-endpoint'), 'render marks a failed call with its status');

  // --- 10. engine state still shared with the node ---------------------
  const state = await (await fetch(`${endpoint}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'sync.getState' }),
  })).json();
  check(state?.result?.node === 'verify-backend', 'the backend node identity is exposed through the same RPC');

  console.log(`\n${passed} check(s) passed, ${failures.length} failed`);
  if (failures.length > 0) console.log('FAILED:\n - ' + failures.join('\n - '));

  await server.close();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch(async (error) => {
  console.error('verify crashed:', error);
  process.exit(1);
});
