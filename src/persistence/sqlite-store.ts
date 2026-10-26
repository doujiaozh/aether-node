/**
 * {@link SqliteStateStore} — SQLite-backed storage for aether-node replica
 * state, built entirely on sql.js (SQLite compiled to WebAssembly).
 *
 * sql.js runs the database inside the host process — no native compilation,
 * no daemon, no native C++ modules. The engine keeps the database image in
 * memory and hands back the full file content via `Database#export()`, so
 * "saving" means writing that image to disk. The store is therefore a
 * single-writer-at-a-time file format: open it, mutate, save, close.
 */

import { createRequire } from 'node:module';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import initSqlJs from 'sql.js';
import type { Database, QueryExecResult, SqlJsStatic } from 'sql.js';
import { SYNC_STATE_FORMAT, type SyncState } from '../sync-engine/index.js';

const require = createRequire(import.meta.url);

/** Persistence-layer schema tag stored in the `meta` table. */
export const PERSIST_FORMAT = 'aether-node/persist-v1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS registers (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  ts_wall INTEGER NOT NULL,
  ts_logical INTEGER NOT NULL,
  ts_node TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  p TEXT NOT NULL,
  n TEXT NOT NULL
);
`;

const UPSERT_REGISTER =
  'INSERT OR REPLACE INTO registers (key, value, ts_wall, ts_logical, ts_node) VALUES (?, ?, ?, ?, ?)';
const UPSERT_COUNTER = 'INSERT OR REPLACE INTO counters (key, p, n) VALUES (?, ?, ?)';
const UPSERT_META = 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)';

/** Thrown when the on-disk database cannot be opened, parsed, or written. */
export class PersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistenceError';
  }
}

/**
 * The storage contract {@link PersistentSyncEngine} depends on. The SQLite
 * store satisfies it; tests can inject their own implementation.
 */
export interface StateStore {
  /** Read the persisted replica state, or `undefined` when there is none. */
  loadState(): SyncState | undefined;
  /** Persist the given state. */
  saveState(state: SyncState): Promise<void>;
  /** Release the underlying resources. */
  close(): void;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

/**
 * Load the sql.js WASM runtime once per process. The wasm binary is read
 * straight off disk and injected as a buffer, which keeps initialization
 * independent of `fetch`/URL assumptions that do not hold under Node ESM.
 */
export function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise === undefined) {
    sqlJsPromise = (async () => {
      // sql.js' emscripten layer consumes the binary synchronously, so the
      // file must be fully read before initialization.
      const wasmBinary = (await readFile(
        require.resolve('sql.js/dist/sql-wasm.wasm'),
      )) as unknown as ArrayBuffer;
      try {
        return await initSqlJs({ wasmBinary });
      } catch (cause) {
        // Allow a retry after a transient failure instead of caching a rejection.
        sqlJsPromise = undefined;
        throw new PersistenceError('cannot initialize the sql.js WASM runtime', { cause });
      }
    })();
  }
  return sqlJsPromise;
}

function rowResult(result: QueryExecResult[] | undefined): SqlValueRows {
  return result === undefined || result.length === 0 ? [] : (result[0].values as SqlValueRows);
}

type SqlValueRows = (string | number | Uint8Array | null)[][];

/**
 * A single-writer SQLite store for one replica's {@link SyncState}.
 *
 * Obtain instances via {@link SqliteStateStore.open}; the constructor is
 * internal (it needs an already-initialized sql.js database handle).
 */
export class SqliteStateStore {
  private constructor(
    private readonly db: Database,
    private readonly path: string,
  ) {}

  /**
   * Open (or create) the SQLite database file at `path` and make sure the
   * aether-node schema exists. An empty or missing file starts a fresh
   * database; a file that is not a readable SQLite image throws
   * {@link PersistenceError}.
   */
  static async open(path: string): Promise<SqliteStateStore> {
    const SQL = await loadSqlJs();
    await mkdir(dirname(path), { recursive: true });
    const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw new PersistenceError(`cannot stat database file "${path}"`, { cause: error });
    });
    let db: Database | undefined;
    try {
      db =
        existing === undefined || existing.size === 0
          ? new SQL.Database()
          : new SQL.Database(await readFile(path));
      db.run(SCHEMA);
      return new SqliteStateStore(db, path);
    } catch (cause) {
      db?.close();
      throw new PersistenceError(
        `cannot open SQLite database file "${path}": ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause },
      );
    }
  }

  /**
   * Read the persisted replica state. Returns `undefined` when the store is
   * empty or was not written by this persistence layer.
   */
  loadState(): SyncState | undefined {
    const meta = this.readMeta();
    if (meta.get('format') !== PERSIST_FORMAT) return undefined;
    const node = meta.get('node');
    if (node === undefined) return undefined;

    const registers: SyncState['registers'] = {};
    for (const row of rowResult(this.db.exec('SELECT key, value, ts_wall, ts_logical, ts_node FROM registers'))) {
      const [key, valueJson, wall, logical, tsNode] = row;
      if (typeof key !== 'string' || typeof tsNode !== 'string') continue;
      registers[key] = {
        value: parseJson(valueJson, `register "${key}" value`),
        ts: { wall: asNumber(wall), logical: asNumber(logical), node: tsNode },
      };
    }

    const counters: SyncState['counters'] = {};
    for (const row of rowResult(this.db.exec('SELECT key, p, n FROM counters'))) {
      const [key, pJson, nJson] = row;
      if (typeof key !== 'string') continue;
      counters[key] = {
        p: parseJson(pJson, `counter "${key}" positive buckets`) as Record<string, number>,
        n: parseJson(nJson, `counter "${key}" negative buckets`) as Record<string, number>,
      };
    }

    return {
      format: SYNC_STATE_FORMAT,
      node,
      version: asNumber(meta.get('version') ?? null),
      registers,
      counters,
    };
  }

  /**
   * Persist `state` inside one transaction and then write the whole database
   * image to disk. The write is atomic from the engine's point of view: the
   * file on either contains a complete database or the previous one.
   */
  async saveState(state: SyncState): Promise<void> {
    this.db.run('BEGIN');
    try {
      for (const key of Object.keys(state.registers)) {
        const { value, ts } = state.registers[key];
        this.db.run(UPSERT_REGISTER, [
          key,
          JSON.stringify(value),
          ts.wall,
          ts.logical,
          ts.node,
        ]);
      }
      for (const key of Object.keys(state.counters)) {
        const { p, n } = state.counters[key];
        this.db.run(UPSERT_COUNTER, [key, JSON.stringify(p), JSON.stringify(n)]);
      }
      this.db.run(UPSERT_META, ['format', PERSIST_FORMAT]);
      this.db.run(UPSERT_META, ['node', state.node]);
      this.db.run(UPSERT_META, ['version', String(state.version)]);
      this.db.run('COMMIT');
    } catch (cause) {
      this.db.run('ROLLBACK');
      throw new PersistenceError(`failed to write state to "${this.path}"`, { cause });
    }
    await writeFile(this.path, Buffer.from(this.db.export()));
  }

  /** Close the in-memory database. The on-disk file is left as last saved. */
  close(): void {
    this.db.close();
  }

  private readMeta(): Map<string, string> {
    const meta = new Map<string, string>();
    for (const row of rowResult(this.db.exec('SELECT key, value FROM meta'))) {
      const [key, value] = row;
      if (typeof key === 'string' && typeof value === 'string') meta.set(key, value);
    }
    return meta;
  }
}

function asNumber(value: string | number | Uint8Array | null): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseJson(value: string | number | Uint8Array | null, what: string): unknown {
  if (typeof value !== 'string') {
    throw new PersistenceError(`corrupted store: ${what} is not JSON text`);
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new PersistenceError(`corrupted store: ${what} is not valid JSON`, { cause });
  }
}
