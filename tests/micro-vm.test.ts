import {
  MicroVm,
  normalizeVmOptions,
  clonePlainContext,
} from '../src/micro-vm/index.js';

const vm = new MicroVm();

describe('micro-vm — basics', () => {
  it('executes an expression and returns its value', async () => {
    const result = await vm.execute('return 6 * 7;');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.value).toBe(42);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes a plain-data context into the sandbox', async () => {
    const result = await vm.execute(
      'return { sum: ctx.a + ctx.b, nested: ctx.deep.ok, list: ctx.items.map(function (x) { return x * 2; }) };',
      { ctx: { a: 1, b: 2, deep: { ok: true }, items: [1, 2, 3] } },
    );
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ sum: 3, nested: true, list: [2, 4, 6] });
  });

  it('supports async/await and top-level returns', async () => {
    const result = await vm.execute(
      'const v = await Promise.resolve(10); return v * 2;',
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(20);
  });

  it('captures console output from the sandbox', async () => {
    const result = await vm.execute(
      'console.log("hello", 42); console.error("warned"); return 1;',
    );
    expect(result.ok).toBe(true);
    expect(result.logs).toEqual(
      expect.arrayContaining(['LOG: hello 42', 'ERROR: warned']),
    );
  });

  it('handles undefined results as null', async () => {
    const result = await vm.execute('42;');
    expect(result.ok).toBe(true);
    expect(result.value).toBe(null);
  });

  it('rejects empty code without spawning a worker', async () => {
    const result = await vm.execute('');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('input');
  });
});

describe('micro-vm — error capture', () => {
  it('captures runtime errors with name and message', async () => {
    const result = await vm.execute('throw new TypeError("boom");');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('runtime');
    expect(result.error?.name).toBe('TypeError');
    expect(result.error?.message).toBe('boom');
    expect(result.error?.stack).toBeDefined();
  });

  it('captures syntax errors', async () => {
    const result = await vm.execute('function {');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('runtime');
    expect(result.error?.name).toBe('SyntaxError');
  });

  it('reports unserializable results as an output error', async () => {
    const result = await vm.execute(
      'const o = {}; o.self = o; return o;',
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('output');
    expect(result.error?.name).toBe('VmResultSerializationError');
  });
});

describe('micro-vm — resource limits', () => {
  it('terminates infinite loops at the wall-clock budget', async () => {
    const startedAt = Date.now();
    const result = await vm.execute('while (true) {}', {}, { timeoutMs: 500 });
    const elapsed = Date.now() - startedAt;
    expect(result.ok).toBe(false);
    expect(result.status).toBe('timeout');
    expect(result.error?.name).toBe('VmTimeoutError');
    // Budget enforced roughly on time, not by the default 5s.
    expect(elapsed).toBeLessThan(5000);
  });

  it('enforces the V8 heap cap', async () => {
    const result = await vm.execute(
      'const pile = []; while (true) { pile.push(new Array(20000).fill("x")); }',
      {},
      { timeoutMs: 20_000, memoryLimitMb: 32 },
    );
    expect(result.ok).toBe(false);
    expect(['memory', 'timeout']).toContain(result.status);
    if (result.status === 'memory') {
      expect(result.error?.name).toBe('Error');
    }
  }, 30_000);

  it('rejects oversized results', async () => {
    const result = await vm.execute(
      'return "x".repeat(4096);',
      {},
      { maxResultBytes: 1024 },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('output');
    expect(result.error?.name).toBe('VmResultTooLargeError');
  });
});

describe('micro-vm — sandbox isolation', () => {
  it('does not expose the host process', async () => {
    const result = await vm.execute(
      'return { process: typeof process, require: typeof require, global: typeof globalThis.process };',
    );
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ process: 'undefined', require: 'undefined', global: 'undefined' });
  });

  it('blocks code generation from strings (eval / new Function)', async () => {
    const evalResult = await vm.execute('return eval("1+1");');
    expect(evalResult.ok).toBe(false);
    expect(evalResult.error?.name).toBe('EvalError');

    const fnResult = await vm.execute('return new Function("return 1")();');
    expect(fnResult.ok).toBe(false);
    expect(fnResult.status).toBe('runtime');
  });

  it('blocks WebAssembly compilation', async () => {
    const result = await vm.execute(
      'return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));',
    );
    expect(result.ok).toBe(false);
    // Node refuses wasm compilation with a CompileError ("Wasm code generation
    // disallowed by embedder"); older streams raised EvalError. Either means
    // the compilation was refused.
    expect(['EvalError', 'CompileError']).toContain(result.error?.name);
  });

  it('cannot reach the host filesystem or network from the sandbox', async () => {
    const fsProbe = await vm.execute(`
      try { return typeof require('node:fs') !== 'undefined'; }
      catch (e) { return 'blocked: ' + e.constructor.name; }
    `);
    expect(fsProbe.ok).toBe(true);
    expect(String(fsProbe.value)).toMatch(/blocked|undefined/);
  });
});

describe('micro-vm — input validation', () => {
  it('rejects non-plain-data contexts (functions, symbols, bigints)', async () => {
    const fn = await vm.execute('return 1;', { evil: () => 1 });
    expect(fn.ok).toBe(false);
    expect(fn.status).toBe('input');

    const sym = await vm.execute('return 1;', { evil: Symbol('x') });
    expect(sym.ok).toBe(false);
    expect(sym.status).toBe('input');

    const big = await vm.execute('return 1;', { evil: 10n });
    expect(big.ok).toBe(false);
    expect(big.status).toBe('input');
  });

  it('rejects deeply nested contexts', async () => {
    const ctx: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = ctx;
    for (let i = 0; i < 64; i++) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const result = await vm.execute('return 1;', ctx);
    expect(result.ok).toBe(false);
    expect(result.status).toBe('input');
  });

  it('converts Date inputs to ISO strings', async () => {
    const result = await vm.execute('return ctx.when;', {
      ctx: { when: new Date('2024-01-01T00:00:00Z') },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('micro-vm — option normalization', () => {
  it('clamps timeouts into [50, 30000]', () => {
    expect(normalizeVmOptions({ timeoutMs: 1 }).timeoutMs).toBe(50);
    expect(normalizeVmOptions({ timeoutMs: 1_000_000 }).timeoutMs).toBe(30_000);
    expect(normalizeVmOptions().timeoutMs).toBe(5000);
  });

  it('clamps memory limits into [32, 1024] and floors result budgets', () => {
    expect(normalizeVmOptions({ memoryLimitMb: 1 }).memoryLimitMb).toBe(32);
    expect(normalizeVmOptions({ memoryLimitMb: 9999 }).memoryLimitMb).toBe(1024);
    expect(normalizeVmOptions().memoryLimitMb).toBe(32);
    expect(normalizeVmOptions({ maxResultBytes: 0 }).maxResultBytes).toBe(1024);
  });

  it('clones plain structures and drops exotic wrappers', () => {
    expect(clonePlainContext({ a: [1, { b: 2 }] })).toEqual({ a: [1, { b: 2 }] });
    expect(clonePlainContext(undefined)).toBe(undefined);
    expect(() => clonePlainContext({ f: () => 1 })).toThrow(TypeError);
  });
});
