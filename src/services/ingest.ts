/**
 * Download → extract → load pipeline for the bulk datasets.
 *
 * CCOD and OCOD get a canonical, typed schema because the ownership tools
 * depend on specific columns. The leases and covenants datasets are loaded
 * schema-tolerantly (every column as text, names normalised to snake_case)
 * because their published layouts sit behind an account login and change
 * between releases; the due-diligence tools discover their columns at runtime
 * rather than assuming them.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { DATA_DIR, type DatasetSpec } from "../constants.js";
import {
  ensureSpatial,
  execute,
  query,
  recordIngest,
  sqlIdent,
  sqlLit,
} from "./cache.js";
import { downloadToFile, getDownloadUrl } from "./ulpd.js";

/** Normalises a CSV header to a comparable key: lowercase alphanumerics only. */
function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Converts a CSV header to a snake_case SQL column name. */
function toSnakeCase(header: string): string {
  const snake = header
    .trim()
    .replace(/[()]/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return snake.length > 0 ? snake : "column";
}

/** Extracts a zip archive, returning the paths of the files written. */
async function extractZip(archivePath: string, destination: string): Promise<string[]> {
  const yauzl = await import("yauzl");

  await mkdir(destination, { recursive: true });
  const written: string[] = [];

  await new Promise<void>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) return reject(error ?? new Error("Could not open the archive."));

      zipfile.on("entry", (entry) => {
        // Directory entries end with a slash and carry no content.
        if (entry.fileName.endsWith("/")) return zipfile.readEntry();

        // Refuse path traversal: entry names come from a remote archive.
        const safeName = basename(entry.fileName);
        if (safeName !== entry.fileName && entry.fileName.includes("..")) {
          return reject(new Error(`Refusing to extract unsafe archive path "${entry.fileName}".`));
        }

        zipfile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            return reject(streamError ?? new Error("Could not read an archive entry."));
          }
          const outputPath = join(destination, safeName);
          pipeline(readStream, createWriteStream(outputPath))
            .then(() => {
              written.push(outputPath);
              zipfile.readEntry();
            })
            .catch(reject);
        });
      });

      zipfile.on("end", () => resolve());
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });

  return written;
}

/** Column names of a DuckDB table, in order. */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = ${sqlLit(table)} ORDER BY ordinal_position`,
  );
  return rows.map((row) => row.column_name);
}

/**
 * Finds the geometry column by data type rather than by name.
 *
 * GDAL names it after the source GML element, so INSPIRE files arrive with
 * "geometryProperty" rather than the "geom" that a hand-written schema would
 * use. Matching on the GEOMETRY type is naming-independent.
 *
 * The reported type carries the CRS — "GEOMETRY('EPSG:27700')" — so this
 * matches on the prefix rather than testing for equality with "GEOMETRY".
 */
async function geometryColumnOf(table: string): Promise<string | null> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = ${sqlLit(table)} AND upper(data_type) LIKE 'GEOMETRY%'
     ORDER BY ordinal_position`,
  );
  return rows[0]?.column_name ?? null;
}

/**
 * Builds a lookup from normalised header to the actual column name, so the
 * canonical projection survives HMLR renaming "Company Registration No. (1)"
 * to "Company Registration No (1)" or similar.
 */
function headerIndex(columns: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const column of columns) index.set(normaliseHeader(column), column);
  return index;
}

/** Emits `<source> AS <alias>`, or `NULL AS <alias>` when the source is absent. */
function project(index: Map<string, string>, sourceKey: string, alias: string): string {
  const actual = index.get(sourceKey);
  return actual ? `${sqlIdent(actual)} AS ${sqlIdent(alias)}` : `NULL AS ${sqlIdent(alias)}`;
}

/** Concatenates up to three address-line columns into one, skipping blanks. */
function projectAddress(index: Map<string, string>, proprietor: number, alias: string): string {
  const parts = [1, 2, 3]
    .map((line) => index.get(`proprietor${proprietor}address${line}`))
    .filter((column): column is string => column !== undefined)
    .map((column) => `NULLIF(TRIM(${sqlIdent(column)}), '')`);

  if (parts.length === 0) return `NULL AS ${sqlIdent(alias)}`;
  return `NULLIF(CONCAT_WS(', ', ${parts.join(", ")}), '') AS ${sqlIdent(alias)}`;
}

const MAX_PROPRIETORS = 4;

/** Canonical projection for the CCOD and OCOD ownership datasets. */
function ownershipProjection(index: Map<string, string>): string {
  const columns: string[] = [
    project(index, "titlenumber", "title_number"),
    project(index, "tenure", "tenure"),
    project(index, "propertyaddress", "property_address"),
    project(index, "district", "district"),
    project(index, "county", "county"),
    project(index, "region", "region"),
    project(index, "postcode", "postcode"),
    project(index, "multipleaddressindicator", "multiple_address_indicator"),
    project(index, "additionalproprietorindicator", "additional_proprietor_indicator"),
  ];

  const pricePaid = index.get("pricepaid");
  columns.push(
    pricePaid
      ? `TRY_CAST(REGEXP_REPLACE(${sqlIdent(pricePaid)}, '[^0-9.]', '', 'g') AS DOUBLE) AS "price_paid"`
      : `NULL AS "price_paid"`,
  );

  const dateAdded = index.get("dateproprietoradded");
  columns.push(
    dateAdded
      ? `TRY_STRPTIME(${sqlIdent(dateAdded)}, '%d-%m-%Y') AS "date_proprietor_added"`
      : `NULL AS "date_proprietor_added"`,
  );

  for (let i = 1; i <= MAX_PROPRIETORS; i += 1) {
    columns.push(project(index, `proprietorname${i}`, `proprietor_${i}_name`));
    columns.push(project(index, `companyregistrationno${i}`, `proprietor_${i}_company_no`));
    columns.push(project(index, `proprietorshipcategory${i}`, `proprietor_${i}_category`));
    columns.push(project(index, `countryincorporated${i}`, `proprietor_${i}_country`));
    columns.push(projectAddress(index, i, `proprietor_${i}_address`));
  }

  return columns.join(",\n  ");
}

/** Schema-tolerant projection: every column as text, snake_cased, de-duplicated. */
function passthroughProjection(columns: string[]): string {
  const used = new Set<string>();
  return columns
    .map((column) => {
      let alias = toSnakeCase(column);
      let suffix = 2;
      while (used.has(alias)) alias = `${toSnakeCase(column)}_${suffix++}`;
      used.add(alias);
      return `${sqlIdent(column)} AS ${sqlIdent(alias)}`;
    })
    .join(",\n  ");
}

/** Finds the largest file matching an extension, which is the data file. */
async function pickDataFile(paths: string[], extensions: string[]): Promise<string> {
  const candidates: Array<{ path: string; size: number }> = [];
  for (const path of paths) {
    if (!extensions.some((extension) => path.toLowerCase().endsWith(extension))) continue;
    candidates.push({ path, size: (await stat(path)).size });
  }
  if (candidates.length === 0) {
    throw new Error(
      `The archive contained no ${extensions.join(" or ")} file. Files found: ` +
        `${paths.map((p) => basename(p)).join(", ") || "none"}.`,
    );
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]!.path;
}

export interface IngestResult {
  rowCount: number;
  sourceFile: string;
  table: string;
}

/** Downloads a dataset file, extracts it, and loads it into the cache. */
export async function ingestDataset(
  spec: DatasetSpec,
  fileName: string,
  area: string | null,
): Promise<IngestResult> {
  const downloadUrl = await getDownloadUrl(spec.apiName, fileName);

  const workDir = join(DATA_DIR, "downloads", spec.key);
  const archivePath = join(workDir, fileName);
  await downloadToFile(downloadUrl, archivePath);

  const extractDir = join(workDir, "extracted");
  await rm(extractDir, { recursive: true, force: true });

  const extracted = fileName.toLowerCase().endsWith(".zip")
    ? await extractZip(archivePath, extractDir)
    : [archivePath];

  try {
    const rowCount =
      spec.key === "inspire"
        ? await loadSpatial(spec, extracted, area)
        : await loadCsv(spec, extracted, area);

    await recordIngest(spec.key, area, fileName, rowCount);
    return { rowCount, sourceFile: fileName, table: spec.table };
  } finally {
    // The extracted copy can be many gigabytes; the archive is kept so a
    // re-ingest does not need to re-download.
    await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Loads a CSV dataset into its canonical table. Exported for tests. */
export async function loadCsv(
  spec: DatasetSpec,
  extracted: string[],
  area: string | null,
): Promise<number> {
  const csvPath = await pickDataFile(extracted, [".csv", ".txt"]);
  const staging = `_staging_${spec.table}`;

  await execute(`DROP TABLE IF EXISTS ${sqlIdent(staging)};`);
  // all_varchar keeps HMLR's mixed-type columns readable; ignore_errors skips
  // the trailing "Row Count: N" line these files end with.
  await execute(
    `CREATE TABLE ${sqlIdent(staging)} AS
     SELECT * FROM read_csv(${sqlLit(csvPath)},
       all_varchar = true, header = true, ignore_errors = true,
       sample_size = -1, null_padding = true);`,
  );

  const columns = await columnsOf(staging);
  if (columns.length === 0) {
    throw new Error(`No columns were parsed from ${basename(csvPath)}.`);
  }

  const isOwnership = spec.key === "ccod" || spec.key === "ocod";
  const projection = isOwnership
    ? ownershipProjection(headerIndex(columns))
    : passthroughProjection(columns);

  const areaColumn = spec.perArea ? `, ${sqlLit(area ?? "")} AS "area"` : "";
  const datasetColumn = isOwnership ? `, ${sqlLit(spec.key)} AS "dataset"` : "";

  await execute(`DROP TABLE IF EXISTS ${sqlIdent(spec.table)};`);
  await execute(
    `CREATE TABLE ${sqlIdent(spec.table)} AS
     SELECT
  ${projection}${datasetColumn}${areaColumn}
     FROM ${sqlIdent(staging)};`,
  );
  await execute(`DROP TABLE IF EXISTS ${sqlIdent(staging)};`);

  // HMLR CSVs end with a "Row Count: N" trailer. With null_padding it parses
  // as a data row whose first column holds the trailer text, so checking for
  // a null title number is not enough to catch it.
  if (isOwnership) {
    await execute(
      `DELETE FROM ${sqlIdent(spec.table)}
       WHERE "title_number" IS NULL
          OR TRIM("title_number") = ''
          OR lower(TRIM("title_number")) LIKE 'row count%';`,
    );
  }

  // Ownership lookups are dominated by company-name and postcode filters.
  if (isOwnership) {
    await execute(
      `CREATE INDEX IF NOT EXISTS ${sqlIdent(`${spec.table}_postcode_idx`)}
       ON ${sqlIdent(spec.table)} ("postcode");`,
    ).catch(() => undefined);
    await execute(
      `CREATE INDEX IF NOT EXISTS ${sqlIdent(`${spec.table}_title_idx`)}
       ON ${sqlIdent(spec.table)} ("title_number");`,
    ).catch(() => undefined);
  }

  const rows = await query<{ count: number | bigint }>(
    `SELECT COUNT(*) AS count FROM ${sqlIdent(spec.table)}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Loads INSPIRE polygons via DuckDB's spatial extension, which reads GML
 * through GDAL. Appends rather than replaces, so several local authorities can
 * coexist in one table. Exported for tests.
 */
export async function loadSpatial(
  spec: DatasetSpec,
  extracted: string[],
  area: string | null,
): Promise<number> {
  await ensureSpatial();
  const gmlPath = await pickDataFile(extracted, [".gml", ".gpkg", ".shp"]);
  const staging = `_staging_${spec.table}`;

  await execute(`DROP TABLE IF EXISTS ${sqlIdent(staging)};`);
  await execute(
    `CREATE TABLE ${sqlIdent(staging)} AS SELECT * FROM ST_Read(${sqlLit(gmlPath)});`,
  );

  const columns = await columnsOf(staging);
  const index = headerIndex(columns);

  const inspireId = index.get("inspireid") ?? index.get("id") ?? null;
  const geometry = await geometryColumnOf(staging);
  if (!geometry) {
    throw new Error(
      `No geometry column found in ${basename(gmlPath)}. Columns: ${columns.join(", ")}. ` +
        "The file may not be a spatial format DuckDB's spatial extension can read.",
    );
  }

  const areaLabel = area ?? "unknown";

  await execute(`CREATE TABLE IF NOT EXISTS ${sqlIdent(spec.table)} (
    inspire_id VARCHAR,
    area VARCHAR,
    area_sq_m DOUBLE,
    centroid_lon DOUBLE,
    centroid_lat DOUBLE,
    geom GEOMETRY
  );`);

  await execute(
    `DELETE FROM ${sqlIdent(spec.table)} WHERE lower(area) = ${sqlLit(areaLabel.toLowerCase())};`,
  );

  // INSPIRE geometry is published in British National Grid (EPSG:27700);
  // reprojecting to WGS84 lets results join to postcodes.io coordinates.
  await execute(
    `INSERT INTO ${sqlIdent(spec.table)}
     SELECT
       ${inspireId ? `CAST(${sqlIdent(inspireId)} AS VARCHAR)` : "NULL"} AS inspire_id,
       ${sqlLit(areaLabel)} AS area,
       ST_Area(${sqlIdent(geometry)}) AS area_sq_m,
       ST_X(ST_Centroid(ST_Transform(${sqlIdent(geometry)}, 'EPSG:27700', 'EPSG:4326', always_xy := true))) AS centroid_lon,
       ST_Y(ST_Centroid(ST_Transform(${sqlIdent(geometry)}, 'EPSG:27700', 'EPSG:4326', always_xy := true))) AS centroid_lat,
       ${sqlIdent(geometry)} AS geom
     FROM ${sqlIdent(staging)};`,
  );

  await execute(`DROP TABLE IF EXISTS ${sqlIdent(staging)};`);

  const rows = await query<{ count: number | bigint }>(
    `SELECT COUNT(*) AS count FROM ${sqlIdent(spec.table)}
     WHERE lower(area) = ${sqlLit(areaLabel.toLowerCase())}`,
  );
  return Number(rows[0]?.count ?? 0);
}

/** Lists files currently in the download cache, for status reporting. */
export async function listCachedArchives(): Promise<string[]> {
  const root = join(DATA_DIR, "downloads");
  try {
    const datasets = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const dataset of datasets) {
      if (!dataset.isDirectory()) continue;
      const entries = await readdir(join(root, dataset.name));
      for (const entry of entries) {
        if (entry.endsWith(".zip") || entry.endsWith(".csv")) {
          files.push(`${dataset.name}/${entry}`);
        }
      }
    }
    return files;
  } catch {
    return [];
  }
}

/** Exported for tests. */
export { normaliseHeader, toSnakeCase, headerIndex, ownershipProjection };
