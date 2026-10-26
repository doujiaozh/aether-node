/**
 * Minimal stand-in for `@deepseek-ai/schemastery` (the DSL subset this plugin
 * uses: `.string()` / `.number()` / `.object()` with `.default()` and
 * `.description()` chaining). The smoke test never runs the schema resolver;
 * `apply()` is handed plain objects.
 */

function chainable(type, extra = {}) {
  const node = {
    type,
    _default: undefined,
    _description: '',
    default(value) {
      this._default = value;
      return this;
    },
    description(text) {
      this._description = text;
      return this;
    },
    ...extra,
  };
  return node;
}

const z = {
  object: (properties) => chainable('object', { properties }),
  string: () => chainable('string'),
  number: () => chainable('number'),
  boolean: () => chainable('boolean'),
};

export default z;
