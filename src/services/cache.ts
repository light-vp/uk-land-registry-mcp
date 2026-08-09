/**
 * Local DuckDB cache for the bulk datasets.
 *
 * DuckDB is an optional dependency: the live tools (Price Paid Data, House
 * Price Index, postcodes) must keep working on machines where the native
 * binary will not install. Everything here therefore loads DuckDB lazily and
 * fails with an actionable message rather than at import time.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR, DATASETS, type DatasetSpec } from "../constants.js";

/** Minimal structural types so this file does not hard-depend on DuckDB's types. */
interface DuckDbConnection {
  run(sql: string): Promise<unknown>;
  runAndReadAll(sql: string): Promise<{ getRowObjects(): Array<Record<string, unknown>> }>;
}

interface DuckDbInstance {
  connect(): Promise<DuckDbConnection>;
}

let connectionPromise: Promise<DuckDbConnection> | null = null;

export class CacheUnavailableError extends Error {
  constructor(cause: string) {
    super(
      "The local dataset cache could not be opened because DuckDB is not " +
        `available: ${cause}\n\n` +
        "DuckDB ships as a native binary and is an optional dependency. Reinstall " +
        "it with `npm install @duckdb/node-api` inside the server directory. " +
        "The Price Paid Data, House Price Index and postcode tools do not need " +
        "DuckDB and will keep working without it.",
    );
    this.name = "CacheUnavailableError";
  }
}

export function databasePath(): string {
  return join(DATA_DIR, "cache.duckdb");
}

/** Opens (and memoises) the DuckDB connection, creating the data directory. */
export async function getConnection(): Promise<DuckDbConnection> {
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async (): Promise<DuckDbConnection> => {
    await mkdir(DATA_DIR, { recursive: true });
    try {
      const duckdb = (await import("@duckdb/node-api")) as unknown as {
        DuckDBInstance: { create(path: string): Promise<DuckDbInstance> };
      };
      const instance = await duckdb.DuckDBInstance.create(databasePath());
      return await instance.connect();
    } catch (error) {
      connectionPromise = null;
      throw new CacheUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
  })();

  return connectionPromise;
}

/** Runs a statement with no result set. */
export async function execute(sql: string): Promise<void> {
  const connection = await getConnection();
  await connection.run(sql);
}

/** Runs a query and returns plain row objects. */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const connection = await getConnection();
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowObjects() as T[];
}

/**
 * Escapes a SQL string literal for DuckDB. Used for every user-supplied value
 * that reaches a query, for the same reason as the SPARQL escaping.
 */
export function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Escapes an identifier (table or column name). */
export function sqlIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Escapes a value for use inside a SQL LIKE pattern, then wraps it in wildcards. */
export function likeContains(value: string): string {
  const escaped = value.replace(/[\\%_]/g, "\\$&");
  return `${sqlLit(`%${escaped}%`)} ESCAPE '\\'`;
}

/** True when a table exists in the cache database. */
export async function tableExists(table: string): Promise<boolean> {
  try {
    const rows = await query<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
       WHERE table_name = ${sqlLit(table)}`,
    );
    return Number(rows[0]?.count ?? 0) > 0;
  } catch (error) {
    if (error instanceof CacheUnavailableError) throw error;
    return false;
  }
}

/** Row count for a cached table, or null when the table is absent. */
export async function tableRowCount(table: string): Promise<number | null> {
  if (!(await tableExists(table))) return null;
  const rows = await query<{ count: number | bigint }>(
    `SELECT COUNT(*) AS count FROM ${sqlIdent(table)}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Loads the DuckDB spatial extension, needed for INSPIRE polygon work. */
export async function ensureSpatial(): Promise<void> {
  try {
    await execute("INSTALL spatial;");
  } catch {
    // Already installed, or offline with a cached copy — LOAD will decide.
  }
  try {
    await execute("LOAD spatial;");
  } catch (error) {
    throw new Error(
      "Could not load the DuckDB spatial extension, which is required for " +
        "INSPIRE polygon queries. DuckDB downloads it on first use, so this " +
        "usually means no internet connection was available. Underlying error: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export interface CachedDatasetStatus {
  key: string;
  title: string;
  cached: boolean;
  table: string;
  row_count: number | null;
  source_file: string | null;
  downloaded_at: string | null;
  areas?: string[];
}

/** Metadata table recording what was ingested, from which file, and when. */
export async function ensureMetadataTable(): Promise<void> {
  await execute(`CREATE TABLE IF NOT EXISTS _hmlr_ingest (
    dataset_key VARCHAR,
    area VARCHAR,
    source_file VARCHAR,
    row_count BIGINT,
    downloaded_at TIMESTAMP
  );`);
}

export async function recordIngest(
  datasetKey: string,
  area: string | null,
  sourceFile: string,
  rowCount: number,
): Promise<void> {
  await ensureMetadataTable();
  await execute(
    `DELETE FROM _hmlr_ingest WHERE dataset_key = ${sqlLit(datasetKey)}
     AND area IS NOT DISTINCT FROM ${area === null ? "NULL" : sqlLit(area)};`,
  );
  await execute(
    `INSERT INTO _hmlr_ingest VALUES (
      ${sqlLit(datasetKey)},
      ${area === null ? "NULL" : sqlLit(area)},
      ${sqlLit(sourceFile)},
      ${Math.trunc(rowCount)},
      now()
    );`,
  );
}

async function ingestInfo(
  datasetKey: string,
): Promise<Array<{ area: string | null; source_file: string; downloaded_at: string }>> {
  if (!(await tableExists("_hmlr_ingest"))) return [];
  const rows = await query<{
    area: string | null;
    source_file: string;
    downloaded_at: unknown;
  }>(
    `SELECT area, source_file, downloaded_at FROM _hmlr_ingest
     WHERE dataset_key = ${sqlLit(datasetKey)} ORDER BY downloaded_at DESC`,
  );
  return rows.map((row) => ({
    area: row.area,
    source_file: row.source_file,
    downloaded_at: String(row.downloaded_at),
  }));
}

/** Reports which datasets are cached, with row counts and provenance. */
export async function cacheStatus(): Promise<CachedDatasetStatus[]> {
  const statuses: CachedDatasetStatus[] = [];

  for (const spec of Object.values(DATASETS)) {
    const rowCount = await tableRowCount(spec.table);
    const info = await ingestInfo(spec.key);
    const latest = info[0];
    statuses.push({
      key: spec.key,
      title: spec.title,
      cached: rowCount !== null && rowCount > 0,
      table: spec.table,
      row_count: rowCount,
      source_file: latest?.source_file ?? null,
      downloaded_at: latest?.downloaded_at ?? null,
      ...(spec.perArea
        ? { areas: info.map((i) => i.area).filter((a): a is string => a !== null) }
        : {}),
    });
  }

  return statuses;
}

/** Throws DatasetNotCachedError-style guidance when a table is missing or empty. */
export async function requireTable(spec: DatasetSpec, area?: string): Promise<void> {
  const { DatasetNotCachedError } = await import("../types.js");
  const rowCount = await tableRowCount(spec.table);
  if (rowCount === null || rowCount === 0) {
    throw new DatasetNotCachedError(spec.key, area);
  }

  if (spec.perArea && area) {
    const rows = await query<{ count: number | bigint }>(
      `SELECT COUNT(*) AS count FROM ${sqlIdent(spec.table)}
       WHERE lower(area) = ${sqlLit(area.toLowerCase())}`,
    );
    if (Number(rows[0]?.count ?? 0) === 0) {
      throw new DatasetNotCachedError(spec.key, area);
    }
  }
}

/** Total bytes occupied by the cache directory, for reporting. */
export async function cacheSizeBytes(): Promise<number> {
  if (!existsSync(DATA_DIR)) return 0;
  let total = 0;

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        total += (await stat(path)).size;
      }
    }
  };

  await walk(DATA_DIR).catch(() => undefined);
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
