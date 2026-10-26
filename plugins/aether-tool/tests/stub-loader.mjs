/**
 * ESM resolve hook that maps this plugin's peer dependencies to local stub
 * modules, so `verify.mjs` can import the plugin without a DSH runtime
 * installed. Anything else resolves normally.
 */

const stubs = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./stubs/dsh-tools.mjs', import.meta.url).href],
  ['@deepseek-ai/schemastery', new URL('./stubs/schemastery.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
  const url = stubs.get(specifier);
  if (url !== undefined) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
