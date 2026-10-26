/**
 * Minimal stand-in for `@deepseek-ai/dsh-tools`.
 *
 * The real package validates arguments, freezes the canonical value, and
 * wraps description/timeout metadata; for the smoke test a passthrough is
 * enough — the tool's own logic only relies on `defineTool` returning the
 * definition so `ctx.tools.register` can consume it.
 */

export function defineTool(definition) {
  return definition;
}
